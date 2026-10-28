import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSshWorkspaceUri, parseSshWorkspace } from '../remote-workspace.mjs';
import { readWorkspaceBinding, writeWorkspaceBinding } from '../workspace-binding.mjs';

test('parses and preserves SSH authority and Linux path case', () => {
  const parsed = parseSshWorkspace('vscode-remote://ssh-remote+DevBox/home/Alice/MyRepo');
  assert.deepEqual(parsed, {
    kind: 'ssh',
    scheme: 'vscode-remote',
    authority: 'ssh-remote+DevBox',
    remotePath: '/home/Alice/MyRepo',
    uri: 'vscode-remote://ssh-remote+DevBox/home/Alice/MyRepo',
  });
  assert.notEqual(
    parseSshWorkspace('vscode-remote://ssh-remote+devbox/home/Alice/MyRepo').uri,
    parsed.uri,
  );
  assert.notEqual(
    parseSshWorkspace('vscode-remote://ssh-remote+DevBox/home/alice/MyRepo').uri,
    parsed.uri,
  );
  assert.equal(isSshWorkspaceUri(parsed.uri), true);
  assert.equal(isSshWorkspaceUri('C:\\work\\repo'), false);
});

test('canonicalizes encoded UTF-8 and accepts an authority/path descriptor', () => {
  assert.deepEqual(parseSshWorkspace('vscode-remote://ssh-remote+dev/home/alice/my%20repo/%E4%B8%AD'), {
    kind: 'ssh',
    scheme: 'vscode-remote',
    authority: 'ssh-remote+dev',
    remotePath: '/home/alice/my repo/中',
    uri: 'vscode-remote://ssh-remote+dev/home/alice/my%20repo/%E4%B8%AD',
  });
  assert.equal(parseSshWorkspace({ authority: 'ssh-remote+dev', remotePath: '/home/Alice/a b' }).uri,
    'vscode-remote://ssh-remote+dev/home/Alice/a%20b');
});

test('rejects malformed, non-SSH, relative, credentialed, queried, and ambiguous URIs', () => {
  const invalidValues = [
    'vscode-remote://wsl+Ubuntu/home/alice/repo',
    'vscode-remote://user@ssh-remote+dev/home/alice/repo',
    'vscode-remote://ssh-remote+dev/home/alice/repo?x=1',
    'vscode-remote://ssh-remote+dev/home/alice/repo#branch',
    'vscode-remote://ssh-remote+dev/home/alice%2Frepo',
    'vscode-remote://ssh-remote+dev/home/alice/%2e%2e/secret',
    'vscode-remote://ssh-remote+dev/home/alice/%252Fsecret',
    'vscode-remote://ssh-remote+dev/home/alice/%00repo',
    'vscode-remote://ssh-remote+dev/home/alice/%E0%A4%A',
    'vscode-remote://ssh-remote+dev/home//repo',
    'vscode-remote://ssh-remote+dev/home/alice/../secret',
    'vscode-remote://ssh-remote+dev/home/alice\\repo',
    'vscode-remote://ssh-remote+dev/home/alice/repo\0',
  ];
  for (const value of invalidValues) assert.throws(() => parseSshWorkspace(value), TypeError, value);
  assert.throws(() => parseSshWorkspace({ authority: 'ssh-remote+dev', remotePath: 'relative/repo' }), TypeError);
  assert.equal(isSshWorkspaceUri('vscode-remote://ssh-remote+dev/home/alice?x=1'), true);
});

test('remote bindings round-trip without local filesystem checks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-remote-workspace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bindingsFile = join(dir, 'workspaces.json');
  const uri = 'vscode-remote://ssh-remote+prod/home/Alice/Not-A-Local-Directory';

  const written = writeWorkspaceBinding(bindingsFile, 'thread-1', uri);
  assert.equal(written.projectPath, uri);
  assert.deepEqual(written.remoteWorkspace, parseSshWorkspace(uri));
  assert.equal(readFileSync(bindingsFile, 'utf8').includes(uri), true);
  assert.deepEqual(readWorkspaceBinding(bindingsFile, 'thread-1'), {
    projectPath: uri,
    remoteWorkspace: parseSshWorkspace(uri),
    updatedAt: written.updatedAt,
  });
});

test('local workspace bindings retain existing behavior and schema', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-local-workspace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, 'repo');
  mkdirSync(project);
  const bindingsFile = join(dir, 'workspaces.json');

  const written = writeWorkspaceBinding(bindingsFile, 'thread-local', project);
  assert.equal(written.projectPath, project);
  assert.equal(Object.hasOwn(written, 'remoteWorkspace'), false);
  assert.deepEqual(readWorkspaceBinding(bindingsFile, 'thread-local'), {
    projectPath: project,
    updatedAt: written.updatedAt,
  });

  writeFileSync(bindingsFile, JSON.stringify({
    version: 1,
    bindings: { legacy: { projectPath: project, updatedAt: '2026-10-28T00:00:00.000Z' } },
  }));
  assert.deepEqual(readWorkspaceBinding(bindingsFile, 'legacy'), {
    projectPath: project,
    updatedAt: '2026-10-28T00:00:00.000Z',
  });
});
