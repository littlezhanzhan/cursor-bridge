import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSshWorkspace } from '../remote-workspace.mjs';
import { inspectSshWindowIdentity } from '../ssh-window-identity.mjs';
import { sameSshAuthority } from '../remote-workspace.mjs';

const alias = 'ssh-remote+devbox';
const remotePath = '/srv/example/Project';
const expectedUri = `vscode-remote://${alias}${remotePath}`;
const expectedWorkspace = parseSshWorkspace(expectedUri);

function encodedAuthority(value, uppercaseHex = false) {
  const hex = Buffer.from(JSON.stringify(value), 'utf8').toString('hex');
  return `ssh-remote+${uppercaseHex ? hex.toUpperCase() : hex}`;
}

function identity({ remoteAuthority = alias, folderAuthority = alias, path = remotePath } = {}) {
  return {
    remoteAuthority,
    folderUri: {
      scheme: 'vscode-remote',
      authority: folderAuthority,
      path,
      query: '',
      fragment: '',
    },
    workspace: null,
  };
}

test('plain aliases and hostName-only hex JSON authorities match in both directions', () => {
  const encodedLower = encodedAuthority({ hostName: 'devbox' });
  const encodedUpper = encodedAuthority({ hostName: 'devbox' }, true);

  assert.equal(sameSshAuthority(alias, encodedLower), true);
  assert.equal(sameSshAuthority(encodedLower, alias), true);
  assert.equal(sameSshAuthority(alias, encodedUpper), true);
  assert.equal(sameSshAuthority(encodedUpper, alias), true);
  assert.equal(sameSshAuthority(encodedLower, encodedUpper), true);
});

test('hostName matching is case-sensitive and rejects a different host', () => {
  assert.equal(sameSshAuthority(alias, encodedAuthority({ hostName: 'Devbox' })), false);
  assert.equal(sameSshAuthority(alias, encodedAuthority({ hostName: 'otherbox' })), false);
  assert.equal(sameSshAuthority('ssh-remote+otherbox', encodedAuthority({ hostName: 'devbox' })), false);
});

test('authority objects with user, port, nulls, args or unknown fields do not match a plain alias', () => {
  const nonHostOnlyValues = [
    { hostName: 'devbox', user: 'alice' },
    { hostName: 'devbox', user: null },
    { hostName: 'devbox', port: 22 },
    { hostName: null },
    { hostName: 'devbox', args: [] },
    { hostName: 'devbox', sshArgs: ['-p', '22'] },
    { hostName: 'devbox', userInDestination: true },
    { hostName: 'devbox', extra: 'value' },
  ];
  for (const value of nonHostOnlyValues) {
    assert.equal(sameSshAuthority(alias, encodedAuthority(value)), false, JSON.stringify(value));
  }
});

test('malformed and primitive JSON authorities never match a plain alias; identical opaque values still match exactly', () => {
  const malformed = [
    'ssh-remote+not-hex',
    'ssh-remote+7',
    encodedAuthority('devbox'),
    encodedAuthority(null),
    encodedAuthority(['devbox']),
    `ssh-remote+${Buffer.from('{"hostName":', 'utf8').toString('hex')}`,
  ];
  for (const value of malformed) assert.equal(sameSshAuthority(alias, value), false, value);

  const opaque = encodedAuthority({ hostName: 'devbox', user: null });
  assert.equal(sameSshAuthority(opaque, opaque), true);
  assert.equal(sameSshAuthority(opaque, alias), false);
});

test('window config and folder authorities must agree under the limited alias equivalence', () => {
  const encoded = encodedAuthority({ hostName: 'devbox' }, true);
  const accepted = inspectSshWindowIdentity(identity({ remoteAuthority: encoded, folderAuthority: alias }), expectedWorkspace);
  assert.equal(accepted.ok, true);

  const differentFolderHost = inspectSshWindowIdentity(identity({
    remoteAuthority: alias,
    folderAuthority: encodedAuthority({ hostName: 'otherbox' }),
  }), expectedWorkspace);
  assert.equal(differentFolderHost.ok, false);
  assert.equal(differentFolderHost.reason, 'folder_uri_authority_mismatch');

  const differentConfigHost = inspectSshWindowIdentity(identity({
    remoteAuthority: encodedAuthority({ hostName: 'otherbox' }),
    folderAuthority: alias,
  }), expectedWorkspace);
  assert.equal(differentConfigHost.ok, false);
  assert.equal(differentConfigHost.reason, 'remote_authority_mismatch');
});

test('host equivalence does not normalize the selected workspace URI or remote path', () => {
  const encoded = encodedAuthority({ hostName: 'devbox' });
  const result = inspectSshWindowIdentity(identity({ remoteAuthority: encoded, folderAuthority: encoded }), expectedUri);
  assert.equal(result.ok, true);
  assert.equal(result.workspace.authority, alias);
  assert.equal(result.workspace.remotePath, remotePath);
  assert.equal(result.workspace.uri, expectedUri);

  const differentPathCase = inspectSshWindowIdentity(identity({
    remoteAuthority: encoded,
    folderAuthority: encoded,
    path: '/srv/example/project',
  }), expectedUri);
  assert.equal(differentPathCase.ok, false);
  assert.equal(differentPathCase.reason, 'folder_uri_path_mismatch');
});
