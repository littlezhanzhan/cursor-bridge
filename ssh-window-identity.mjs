import { parseSshWorkspace } from './remote-workspace.mjs';

/**
 * Read only the identity fields from Cursor's renderer preload configuration.
 * The CDP caller must evaluate this with awaitPromise:true and its own timeout:
 * the preload IPC promise can remain pending while Cursor is still starting.
 */
export const EXPR_SSH_WINDOW_IDENTITY = `(() => {
  const context = window.vscode && window.vscode.context;
  const uri = value => {
    if (typeof value === 'string') return { serialized: value };
    if (!value || typeof value !== 'object') return null;
    try {
      if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
        const serialized = value.toString();
        if (typeof serialized === 'string' && serialized && serialized !== '[object Object]') {
          return { serialized };
        }
      }
    } catch {}
    if (typeof value.scheme === 'string' && typeof value.authority === 'string' && typeof value.path === 'string') {
      return {
        scheme: value.scheme,
        authority: value.authority,
        path: value.path,
        query: typeof value.query === 'string' ? value.query : '',
        fragment: typeof value.fragment === 'string' ? value.fragment : ''
      };
    }
    return null;
  };
  return (async () => {
    let configuration;
    try {
      if (typeof context?.resolveConfiguration === 'function') {
        configuration = await context.resolveConfiguration();
      }
    } catch {}
    if (!configuration) {
      try {
        if (typeof context?.configuration === 'function') {
          configuration = await context.configuration();
        }
      } catch {}
    }
    const rawWorkspace = configuration?.workspace;
    // The main process represents a single-folder workspace as { id, uri }.
    // A .code-workspace/multi-root workspace instead has { id, configPath };
    // its folder list is not present in this preload object.
    const singleFolderWorkspace = rawWorkspace && typeof rawWorkspace === 'object'
      && rawWorkspace.uri != null && rawWorkspace.configPath == null;
    const ambiguousFolderWorkspace = singleFolderWorkspace && configuration?.folderUri != null;
    const folderUri = ambiguousFolderWorkspace
      ? null
      : uri(configuration?.folderUri ?? (singleFolderWorkspace ? rawWorkspace.uri : null));
    const workspace = ambiguousFolderWorkspace
      ? { id: typeof rawWorkspace.id === 'string' ? rawWorkspace.id : null, configPath: null }
      : rawWorkspace && !singleFolderWorkspace
        ? {
            id: typeof rawWorkspace.id === 'string' ? rawWorkspace.id : null,
            configPath: uri(rawWorkspace.configPath)
          }
        : null;
    const identity = {
      remoteAuthority: typeof configuration?.remoteAuthority === 'string' ? configuration.remoteAuthority : null,
      folderUri,
      workspace
    };
    if (typeof window.vscodeWindowId === 'number') identity.windowId = window.vscodeWindowId;
    return JSON.stringify(identity);
  })();
})()`;

function failure(reason, remoteAuthority = null) {
  return { ok: false, workspace: null, remoteAuthority, reason };
}

function parseIdentity(raw) {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: 'identity_json_invalid' };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'identity_payload_invalid' };
  }
  return { value: raw };
}

function parseFolderUri(value) {
  if (typeof value === 'string') {
    if (value.includes('?') || value.includes('#')) return { error: 'folder_uri_query_or_fragment' };
    try {
      return { value: parseSshWorkspace(value) };
    } catch {
      return { error: 'folder_uri_invalid' };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'folder_uri_invalid' };
  }

  if (typeof value.serialized === 'string') {
    if (value.serialized.includes('?') || value.serialized.includes('#')) {
      return { error: 'folder_uri_query_or_fragment' };
    }
    try {
      return { value: parseSshWorkspace(value.serialized) };
    } catch {
      return { error: 'folder_uri_invalid' };
    }
  }

  const scheme = typeof value.scheme === 'string' ? value.scheme.replace(/:$/, '').toLowerCase() : '';
  if (scheme !== 'vscode-remote') return { error: 'folder_uri_not_remote' };
  if ((value.query !== undefined && value.query !== null && value.query !== '')
      || (value.fragment !== undefined && value.fragment !== null && value.fragment !== '')) {
    return { error: 'folder_uri_query_or_fragment' };
  }
  if (typeof value.authority !== 'string' || typeof value.path !== 'string') {
    return { error: 'folder_uri_invalid' };
  }
  try {
    return { value: parseSshWorkspace({ scheme, authority: value.authority, remotePath: value.path }) };
  } catch {
    return { error: 'folder_uri_invalid' };
  }
}

/**
 * Confirm the active renderer identity against one caller-supplied SSH workspace.
 * This function is deliberately synchronous and never reads files or opens a
 * connection; unresolved CDP promises are the caller's timeout responsibility.
 */
export function inspectSshWindowIdentity(raw, expectedWorkspace) {
  const parsedIdentity = parseIdentity(raw);
  if (parsedIdentity.error) return failure(parsedIdentity.error);

  let expected;
  try {
    expected = parseSshWorkspace(expectedWorkspace);
  } catch {
    return failure('expected_workspace_invalid');
  }

  const identity = parsedIdentity.value;
  const remoteAuthority = typeof identity.remoteAuthority === 'string' && identity.remoteAuthority.length
    ? identity.remoteAuthority
    : null;
  if (!remoteAuthority) return failure('remote_authority_missing');
  if (remoteAuthority !== expected.authority) return failure('remote_authority_mismatch', remoteAuthority);

  if (identity.workspace && typeof identity.workspace === 'object') {
    return failure('workspace_roots_unresolved', remoteAuthority);
  }
  if (identity.folderUri === null || identity.folderUri === undefined) {
    return failure('folder_uri_missing', remoteAuthority);
  }

  const parsedFolder = parseFolderUri(identity.folderUri);
  if (parsedFolder.error) return failure(parsedFolder.error, remoteAuthority);
  const folder = parsedFolder.value;
  if (folder.authority !== expected.authority) return failure('folder_uri_authority_mismatch', remoteAuthority);
  if (folder.remotePath !== expected.remotePath) return failure('folder_uri_path_mismatch', remoteAuthority);

  return { ok: true, workspace: expected, remoteAuthority };
}
