import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EXPR_SSH_WINDOW_IDENTITY, inspectSshWindowIdentity } from '../ssh-window-identity.mjs';
import { parseSshWorkspace } from '../remote-workspace.mjs';

const workspaceUri = 'vscode-remote://ssh-remote+devbox/home/flyin/project';
const workspace = parseSshWorkspace(workspaceUri);

function identity(overrides = {}) {
  return {
    remoteAuthority: workspace.authority,
    folderUri: {
      scheme: 'vscode-remote',
      authority: workspace.authority,
      path: workspace.remotePath,
      query: '',
      fragment: '',
    },
    workspace: null,
    ...overrides,
  };
}

function evalIdentityExpression(windowObject) {
  return vm.runInNewContext(EXPR_SSH_WINDOW_IDENTITY, { window: windowObject });
}

test('identity expression awaits the preload resolver and returns only allowlisted fields', async () => {
  const config = identity({
    userEnv: { PRIVATE_TOKEN: 'must-not-escape' },
    product: { nameShort: 'Cursor' },
  });
  let resolveCalls = 0;
  let syncCalls = 0;
  const returned = await evalIdentityExpression({
    vscodeWindowId: 7,
    vscode: {
      context: {
        async resolveConfiguration() {
          resolveCalls++;
          return config;
        },
        configuration() {
          syncCalls++;
          return identity({ remoteAuthority: 'wrong-fallback' });
        },
      },
    },
  });

  assert.deepEqual(JSON.parse(returned), {
    remoteAuthority: workspace.authority,
    folderUri: identity().folderUri,
    workspace: null,
    windowId: 7,
  });
  assert.equal(resolveCalls, 1);
  assert.equal(syncCalls, 0);
  assert.equal(returned.includes('PRIVATE_TOKEN'), false);
  assert.equal(returned.includes('nameShort'), false);
});

test('identity expression falls back to synchronous configuration when resolver is absent or rejects', async () => {
  let syncCalls = 0;
  const withFallback = await evalIdentityExpression({
    vscode: { context: { configuration: () => { syncCalls++; return identity(); } } },
  });
  assert.equal(inspectSshWindowIdentity(withFallback, workspace).ok, true);

  const afterRejectedResolver = await evalIdentityExpression({
    vscode: {
      context: {
        resolveConfiguration: async () => { throw new Error('IPC unavailable'); },
        configuration: () => identity(),
      },
    },
  });
  assert.equal(inspectSshWindowIdentity(afterRejectedResolver, workspace).ok, true);
  assert.equal(syncCalls, 1);
});

test('identity expression normalizes Cursor single-folder workspace { id, uri } to folderUri', async () => {
  const returned = await evalIdentityExpression({
    vscode: {
      context: {
        resolveConfiguration: async () => ({
          remoteAuthority: workspace.authority,
          workspace: {
            id: 'single-folder-id',
            uri: {
              scheme: 'vscode-remote',
              authority: workspace.authority,
              path: workspace.remotePath,
              query: '',
              fragment: '',
              toString: () => workspaceUri,
            },
          },
        }),
      },
    },
  });

  const payload = JSON.parse(returned);
  assert.deepEqual(payload.folderUri, { serialized: workspaceUri });
  assert.equal(payload.workspace, null);
  assert.equal(inspectSshWindowIdentity(payload, workspace).ok, true);
});

test('a never-settling preload promise is left to the outer CDP evaluation timeout', async () => {
  const pending = evalIdentityExpression({
    vscode: { context: { resolveConfiguration: () => new Promise(() => {}) } },
  });
  const result = await Promise.race([
    pending.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('outer-timeout'), 10)),
  ]);
  assert.equal(result, 'outer-timeout');
});

test('failed preload access returns an empty allowlisted payload that fails closed', async () => {
  const returned = await evalIdentityExpression({
    vscode: {
      context: {
        resolveConfiguration: async () => { throw new Error('IPC failure'); },
        configuration: () => { throw new Error('fallback failure'); },
      },
    },
  });
  assert.deepEqual(JSON.parse(returned), { remoteAuthority: null, folderUri: null, workspace: null });
  assert.deepEqual(inspectSshWindowIdentity(returned, workspace), {
    ok: false,
    workspace: null,
    remoteAuthority: null,
    reason: 'remote_authority_missing',
  });
});

test('single-folder SSH URI components and serialized JSON payloads match the requested workspace', () => {
  const fromParts = inspectSshWindowIdentity(identity(), workspaceUri);
  assert.deepEqual(fromParts, { ok: true, workspace, remoteAuthority: workspace.authority });

  const fromSerializedUri = inspectSshWindowIdentity(JSON.stringify(identity({
    folderUri: { serialized: workspaceUri },
  })), workspace);
  assert.deepEqual(fromSerializedUri, { ok: true, workspace, remoteAuthority: workspace.authority });
});

test('matching path on another host and case-different authority or path are rejected', () => {
  assert.equal(inspectSshWindowIdentity(identity({ remoteAuthority: 'ssh-remote+otherbox' }), workspace).reason,
    'remote_authority_mismatch');

  assert.equal(inspectSshWindowIdentity(identity({
    folderUri: { ...identity().folderUri, authority: 'ssh-remote+otherbox' },
  }), workspace).reason, 'folder_uri_authority_mismatch');

  assert.equal(inspectSshWindowIdentity(identity({
    remoteAuthority: 'ssh-remote+Devbox',
    folderUri: { ...identity().folderUri, authority: 'ssh-remote+Devbox' },
  }), workspace).reason, 'remote_authority_mismatch');

  assert.equal(inspectSshWindowIdentity(identity({
    folderUri: { ...identity().folderUri, path: '/home/flyin/Project' },
  }), workspace).reason, 'folder_uri_path_mismatch');
});

test('file-scheme folders, multi-root workspaces, unknown roots, and URI suffixes fail closed', () => {
  assert.equal(inspectSshWindowIdentity(identity({
    folderUri: { ...identity().folderUri, scheme: 'file' },
  }), workspace).reason, 'folder_uri_not_remote');

  assert.equal(inspectSshWindowIdentity(identity({
    folderUri: null,
    workspace: { id: 'workspace-id', configPath: { scheme: 'file', path: '/local/project.code-workspace' } },
  }), workspace).reason, 'workspace_roots_unresolved');

  assert.equal(inspectSshWindowIdentity(identity({ folderUri: null }), workspace).reason, 'folder_uri_missing');

  assert.equal(inspectSshWindowIdentity(identity({
    folderUri: `${workspaceUri}?mode=read`,
  }), workspace).reason, 'folder_uri_query_or_fragment');
  assert.equal(inspectSshWindowIdentity(identity({
    folderUri: { ...identity().folderUri, fragment: 'section' },
  }), workspace).reason, 'folder_uri_query_or_fragment');
});

test('malformed identity and invalid expected workspaces return explicit reasons', () => {
  assert.equal(inspectSshWindowIdentity('{bad json', workspace).reason, 'identity_json_invalid');
  assert.equal(inspectSshWindowIdentity(null, workspace).reason, 'identity_payload_invalid');
  assert.equal(inspectSshWindowIdentity(identity(), 'relative/path').reason, 'expected_workspace_invalid');
});
