import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callerConnectionKey,
  getCallerConnection,
  resolveCallerConnectionsFile,
  setCallerConnectionSession,
} from '../caller-connections.mjs';
import { getNamedConnection, saveNamedConnection } from '../named-connections.mjs';

const uri = 'vscode-remote://ssh-remote+DevBox/home/Alice/Project';
const sessionA = 'cursor-session-550e8400-e29b-41d4-a716-446655440000';
const sessionB = 'cursor-session-6ba7b810-9dad-41d1-80b4-00c04fd430c8';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-caller-connections-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const appData = join(dir, 'roaming');
  mkdirSync(appData, { recursive: true });
  return {
    dir,
    appData,
    callerFile: join(appData, 'cursor-bridge', 'caller-connections-v1.json'),
    sharedFile: join(appData, 'cursor-bridge', 'connections-v1.json'),
  };
}

function spawnCallerWriter(args) {
  const moduleUrl = new URL('../caller-connections.mjs', import.meta.url).href;
  const source = `
    import { setCallerConnectionSession } from ${JSON.stringify(moduleUrl)};
    const [file, callerKey, name, uri, sessionId, revision] = process.argv.slice(1);
    try {
      const result = setCallerConnectionSession(file, callerKey, { name, uri }, sessionId, {
        expectedRevision: Number(revision),
      });
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      if (error.code === 'NAMED_CONNECTION_REVISION_CONFLICT') {
        process.stdout.write('REVISION_CONFLICT');
      } else {
        console.error(error.stack || error);
        process.exitCode = 1;
      }
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `writer exited with ${code}`));
    });
  });
}

test('caller registry defaults to its independent APPDATA file and honors its own override', t => {
  const f = fixture(t);
  const oldConnectionsOverride = join(f.dir, 'legacy-location', 'connections-v1.json');
  assert.equal(resolveCallerConnectionsFile({
    APPDATA: f.appData,
    CURSOR_BRIDGE_CONNECTIONS_FILE: oldConnectionsOverride,
  }), f.callerFile);
  assert.equal(resolveCallerConnectionsFile({
    APPDATA: f.appData,
    CURSOR_BRIDGE_CALLER_CONNECTIONS_FILE: join(f.dir, 'custom', 'caller.json'),
  }), join(f.dir, 'custom', 'caller.json'));
});

test('callerConnectionKey is stable after name and URI canonicalization but isolates caller and URI', () => {
  const key = callerConnectionKey('codex-thread:thread-a', '  Prod.Box  ', uri);
  const canonicalEquivalent = callerConnectionKey(
    'codex-thread:thread-a',
    'prod.box',
    'vscode-remote://ssh-remote+DevBox/home/Alice/Project/',
  );
  assert.equal(key, canonicalEquivalent);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, callerConnectionKey('codex-thread:thread-b', 'prod.box', uri));
  assert.notEqual(key, callerConnectionKey('codex-thread:thread-a', 'prod.box',
    'vscode-remote://ssh-remote+OtherBox/home/Alice/Project'));
  assert.notEqual(key, callerConnectionKey('codex-thread:thread-a', 'prod.box',
    'vscode-remote://ssh-remote+DevBox/home/alice/Project'));
  assert.notEqual(key, callerConnectionKey('Codex-thread:thread-a', 'prod.box', uri),
    'caller keys retain exact case');
});

test('caller mappings are isolated from other callers and the old shared registry is never migrated or modified', t => {
  const f = fixture(t);
  const shared = saveNamedConnection(f.sharedFile, { name: 'prod.box', uri, sessionId: sessionA });
  const sharedBytes = readFileSync(f.sharedFile, 'utf8');

  assert.equal(getCallerConnection(f.callerFile, 'caller-a', { name: 'prod.box', uri }), null,
    'an old shared session is not implicitly adopted');
  const callerA = setCallerConnectionSession(f.callerFile, 'caller-a', { name: ' Prod.Box ', uri }, sessionB, {
    expectedRevision: 0,
  });
  assert.equal(callerA.name, 'prod.box');
  assert.equal(callerA.uri, uri);
  assert.equal(callerA.sessionId, sessionB);
  assert.equal(callerA.revision, 1);
  assert.equal(getCallerConnection(f.callerFile, 'caller-b', { name: 'prod.box', uri }), null);
  assert.equal(getCallerConnection(f.callerFile, 'caller-a', { name: 'prod.box', uri }).sessionId, sessionB);
  assert.equal(getNamedConnection(f.sharedFile, 'prod.box').sessionId, shared.sessionId);
  assert.equal(readFileSync(f.sharedFile, 'utf8'), sharedBytes);
});

test('same caller can keep separate case-sensitive URI mappings for the same connection name', t => {
  const f = fixture(t);
  const lowerPath = 'vscode-remote://ssh-remote+DevBox/home/alice/Project';
  setCallerConnectionSession(f.callerFile, 'caller-a', { name: 'prod.box', uri }, sessionA, { expectedRevision: 0 });
  const otherPath = setCallerConnectionSession(f.callerFile, 'caller-a', { name: 'prod.box', uri: lowerPath }, sessionB, {
    expectedRevision: 0,
  });

  assert.equal(otherPath.sessionId, sessionB);
  assert.equal(getCallerConnection(f.callerFile, 'caller-a', { name: 'prod.box', uri }).sessionId, sessionA);
  assert.equal(getCallerConnection(f.callerFile, 'caller-a', { name: 'prod.box', uri: lowerPath }).sessionId, sessionB);
  assert.equal(getCallerConnection(f.callerFile, 'caller-a', { name: 'prod.box', uri: uri.toLowerCase() }), null,
    'a lowercased authority/path is a distinct URI and does not inherit a mapping');
});

test('expectedRevision zero creates only an absent mapping and positive revisions are CAS protected', t => {
  const f = fixture(t);
  const created = setCallerConnectionSession(f.callerFile, 'caller-a', { name: 'work', uri }, sessionA, {
    expectedRevision: 0,
  });
  assert.equal(created.revision, 1);
  assert.throws(() => setCallerConnectionSession(f.callerFile, 'caller-a', { name: 'work', uri }, sessionB, {
    expectedRevision: 0,
  }), { code: 'NAMED_CONNECTION_REVISION_CONFLICT' });

  const updated = setCallerConnectionSession(f.callerFile, 'caller-a', { name: 'work', uri }, sessionB, {
    expectedRevision: 1,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.sessionId, sessionB);
  assert.throws(() => setCallerConnectionSession(f.callerFile, 'caller-a', { name: 'work', uri }, sessionA, {
    expectedRevision: 1,
  }), { code: 'NAMED_CONNECTION_REVISION_CONFLICT' });
  assert.equal(getCallerConnection(f.callerFile, 'caller-a', { name: 'work', uri }).sessionId, sessionB);
  assert.throws(() => setCallerConnectionSession(f.callerFile, 'caller-a', { name: 'work', uri }, sessionA, {}), {
    code: 'NAMED_CONNECTION_REVISION_INVALID',
  });
});

test('invalid caller, name, URI, and session values fail through the facade', t => {
  const f = fixture(t);
  assert.throws(() => callerConnectionKey('', 'work', uri), { code: 'CALLER_CONNECTION_CALLER_KEY_INVALID' });
  assert.throws(() => callerConnectionKey('caller', 'prototype', uri), { code: 'NAMED_CONNECTION_NAME_INVALID' });
  assert.throws(() => callerConnectionKey('caller', 'work', '/tmp/project'), { code: 'NAMED_CONNECTION_URI_INVALID' });
  assert.throws(() => setCallerConnectionSession(f.callerFile, 'caller', { name: 'work', uri }, 'bad-session', {
    expectedRevision: 0,
  }), { code: 'NAMED_CONNECTION_SESSION_ID_INVALID' });
});

test('concurrent processes add independent caller mappings without lost updates', async t => {
  const f = fixture(t);
  const writes = await Promise.all(Array.from({ length: 6 }, (_, index) => spawnCallerWriter([
    f.callerFile,
    `codex-thread:${index}`,
    'prod.box',
    `vscode-remote://ssh-remote+host${index}/srv/project`,
    `cursor-session-00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    '0',
  ])));
  assert.equal(writes.length, 6);
  for (let index = 0; index < 6; index++) {
    const record = getCallerConnection(f.callerFile, `codex-thread:${index}`, {
      name: 'prod.box',
      uri: `vscode-remote://ssh-remote+host${index}/srv/project`,
    });
    assert.equal(record?.revision, 1);
    assert.equal(record?.sessionId, `cursor-session-00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`);
  }
});
