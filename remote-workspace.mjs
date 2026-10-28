const REMOTE_SCHEME = 'vscode-remote';
const SSH_AUTHORITY = /^ssh-remote\+([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const ENCODED_SEPARATOR_OR_NUL = /%(?:2f|5c|00)/i;
const AMBIGUOUS_DOUBLE_ESCAPE = /%(?:2e|2f|5c|00)/i;

function invalid(message) {
  throw new TypeError(`Invalid SSH workspace URI: ${message}`);
}

export function isSshWorkspaceUri(value) {
  if (typeof value === 'string') return /^vscode-remote:/i.test(value.trim());
  if (!value || typeof value !== 'object') return false;
  if (String(value.scheme || value.protocol || '').replace(/:$/, '').toLowerCase() === REMOTE_SCHEME) return true;
  return typeof value.authority === 'string'
    && value.authority.startsWith('ssh-remote+')
    && typeof value.remotePath === 'string';
}

function validateAuthority(authority) {
  if (typeof authority !== 'string' || authority.includes('@') || authority.includes('%')) {
    invalid('credentials and escaped authority values are not supported');
  }
  if (!SSH_AUTHORITY.test(authority)) {
    invalid('authority must be ssh-remote+<alias>');
  }
  return authority;
}

function encodePathSegment(value) {
  try {
    return encodeURIComponent(value)
      .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch {
    invalid('path contains invalid Unicode');
  }
}

function canonicalRemotePath(path, { fromUri = false } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    invalid('remotePath must be an absolute POSIX path');
  }
  if (path.includes('\0') || path.includes('\\')) {
    invalid('NUL and backslashes are not supported in remote paths');
  }
  if (fromUri && (path.includes('?') || path.includes('#'))) {
    invalid('query and fragment components are not supported');
  }
  if (path.startsWith('//') || path.slice(1).includes('//')) {
    invalid('repeated path separators are ambiguous');
  }

  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (trimmed === '/') return { remotePath: '/', encodedPath: '/' };

  const rawSegments = trimmed.slice(1).split('/');
  const remoteSegments = [];
  const encodedSegments = [];
  for (const rawSegment of rawSegments) {
    if (!rawSegment) invalid('empty path segments are not supported');
    if (fromUri && /%(?![0-9a-f]{2})/i.test(rawSegment)) {
      invalid('malformed percent escape');
    }
    if (fromUri && ENCODED_SEPARATOR_OR_NUL.test(rawSegment)) {
      invalid('escaped separators and NUL are not supported');
    }

    let segment;
    try {
      segment = fromUri ? decodeURIComponent(rawSegment) : rawSegment;
    } catch {
      invalid('path contains invalid UTF-8 or percent encoding');
    }
    if (!segment || segment === '.' || segment === '..') {
      invalid('empty and dot path segments are not supported');
    }
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')
        || /[\u0001-\u001f\u007f]/.test(segment)) {
      invalid('path segment contains a separator or control character');
    }
    // A second decode could turn a filename into a separator or traversal segment.
    if (AMBIGUOUS_DOUBLE_ESCAPE.test(segment)) {
      invalid('double-escaped separators, dot segments, or NUL are ambiguous');
    }

    remoteSegments.push(segment);
    encodedSegments.push(encodePathSegment(segment));
  }
  return {
    remotePath: `/${remoteSegments.join('/')}`,
    encodedPath: `/${encodedSegments.join('/')}`,
  };
}

function descriptor(authorityValue, pathValue, { fromUri = false } = {}) {
  const authority = validateAuthority(authorityValue);
  const { remotePath, encodedPath } = canonicalRemotePath(pathValue, { fromUri });
  return {
    kind: 'ssh',
    scheme: REMOTE_SCHEME,
    authority,
    remotePath,
    uri: `${REMOTE_SCHEME}://${authority}${encodedPath}`,
  };
}

export function parseSshWorkspace(value) {
  if (value && typeof value === 'object' && typeof value.remotePath === 'string') {
    if (value.scheme && String(value.scheme).replace(/:$/, '').toLowerCase() !== REMOTE_SCHEME) {
      invalid('object scheme must be vscode-remote');
    }
    if (value.uri !== undefined) {
      if (typeof value.uri !== 'string') invalid('uri must be a string when provided');
      const fromUri = parseSshWorkspace(value.uri);
      const fromFields = descriptor(value.authority, value.remotePath);
      if (fromUri.authority !== fromFields.authority || fromUri.remotePath !== fromFields.remotePath) {
        invalid('uri conflicts with authority or remotePath');
      }
      return fromUri;
    }
    return descriptor(value.authority, value.remotePath);
  }
  if (typeof value !== 'string') invalid('expected a URI string or { authority, remotePath }');
  if (value.includes('\0')) invalid('NUL is not supported');

  const match = value.match(/^vscode-remote:\/\/([^/?#]+)(\/[^?#]*)$/i);
  if (!match) invalid('expected vscode-remote://ssh-remote+<alias>/<absolute-path> without query or fragment');
  return descriptor(match[1], match[2], { fromUri: true });
}
