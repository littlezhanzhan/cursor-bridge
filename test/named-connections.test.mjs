import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getNamedConnection,
  listNamedConnections,
  readNamedConnections,
  resolveNamedConnectionsFile,
  saveNamedConnection,
  setNamedConnectionSession,
} from '../named-connections.mjs';

const uri = 'vscode-remote://ssh-remote+DevBox/home/Alice/Project';
const otherUri = 'vscode-remote://ssh-remote+OtherBox/home/Alice/Project';
const sessionA = 'cursor-session-550e8400-e29b-41d4-a716-446655440000';
const sessionB = 'cursor-session-6ba7b810-9dad-41d1-80b4-00c04fd430c8';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-named-connections-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'connections-v1.json') };
}

function spawnWorker(args) {
  const moduleUrl = new URL('../named-connections.mjs', import.meta.url).href;
  const source = `
    import { saveNamedConnection, setNamedConnectionSession } from ${JSON.stringify(moduleUrl)};
    const [action, file, name, workspaceUri, sessionId, revision] = process.argv.slice(1);
    try {
      const result = action === 'save'
        ? saveNamedConnection(file, { name, uri: workspaceUri })
        : setNamedConnectionSession(file, name, sessionId, { expectedRevision: Number(revision), uri: workspaceUri });
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
      else reject(new Error(stderr.trim() || `worker exited with ${code}`));
    });
  });
}

function assertCanonicalRecord(record, { name, uri: workspaceUri, sessionId, revision }) {
  assert.deepEqual(Object.keys(record).sort(), [
    'createdAt', 'name', 'revision', 'sessionId', 'updatedAt', 'uri',
  ]);
  assert.equal(record.name, name);
  assert.equal(record.uri, workspaceUri);
  assert.equal(record.sessionId, sessionId);
  assert.equal(record.revision, revision);
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
  assert.ok(Number.isFinite(Date.parse(record.updatedAt)));
}

test('default path is stable across working directories and honors APPDATA/override', t => {
  const { dir } = fixture(t);
  const appData = join(dir, 'roaming');
  const cwdA = join(dir, 'cwd-a');
  const cwdB = join(dir, 'cwd-b');
  mkdirSync(cwdA);
  mkdirSync(cwdB);
  const previousCwd = process.cwd();
  const env = { APPDATA: appData };
  try {
    process.chdir(dir);
    const first = resolveNamedConnectionsFile(env);
    process.chdir(cwdA);
    const second = resolveNamedConnectionsFile(env);
    process.chdir(cwdB);
    const third = resolveNamedConnectionsFile(env);
    assert.equal(first, join(appData, 'cursor-bridge', 'connections-v1.json'));
    assert.equal(second, first);
    assert.equal(third, first);
    assert.equal(resolveNamedConnectionsFile({
      ...env,
      CURSOR_BRIDGE_CONNECTIONS_FILE: join(dir, 'custom', 'connections.json'),
    }), join(dir, 'custom', 'connections.json'));
  } finally {
    process.chdir(previousCwd);
  }
});

test('create, list, get, and session CAS preserve canonical URI and Linux case', t => {
  const { file } = fixture(t);
  const created = saveNamedConnection(file, { name: '  Prod.Box  ', uri });
  assertCanonicalRecord(created, { name: 'prod.box', uri, sessionId: null, revision: 1 });
  assert.deepEqual(readNamedConnections(file), { version: 1, connections: { 'prod.box': created } });
  assert.deepEqual(getNamedConnection(file, 'PROD.BOX'), created);
  assert.deepEqual(listNamedConnections(file), [created]);

  const assigned = setNamedConnectionSession(file, 'prod.box', sessionA, { expectedRevision: 1, uri });
  assertCanonicalRecord(assigned, { name: 'prod.box', uri, sessionId: sessionA, revision: 2 });
  assert.equal(getNamedConnection(file, 'prod.box').sessionId, sessionA);

  const otherHostRecord = saveNamedConnection(file, { name: 'other', uri: otherUri });
  const otherCaseRecord = saveNamedConnection(file, {
    name: 'case-path', uri: 'vscode-remote://ssh-remote+DevBox/home/alice/Project',
  });
  assert.notEqual(otherHostRecord.uri, created.uri);
  assert.notEqual(otherCaseRecord.uri, created.uri);
  assert.deepEqual(listNamedConnections(file).map(record => record.name), ['case-path', 'other', 'prod.box']);
});

test('name validation trims and case-folds but rejects invalid and prototype keys', t => {
  const { file } = fixture(t);
  assert.equal(saveNamedConnection(file, { name: '  Build_01.A  ', uri }).name, 'build_01.a');
  const nilUuid = 'cursor-session-00000000-0000-0000-0000-000000000000';
  assert.equal(saveNamedConnection(file, { name: 'nil-uuid', uri, sessionId: nilUuid }).sessionId, nilUuid);
  for (const name of ['', '-bad', '_bad', 'naïve', 'a'.repeat(65), 'constructor', 'prototype', '__proto__']) {
    assert.throws(() => saveNamedConnection(file, { name, uri }), { code: 'NAMED_CONNECTION_NAME_INVALID' }, name);
  }
  assert.equal(listNamedConnections(file).length, 2);
});

test('retargeting is explicit, CAS-protected, and clears stale sessions', t => {
  const { file } = fixture(t);
  saveNamedConnection(file, { name: 'work', uri, sessionId: sessionA });
  const before = readFileSync(file, 'utf8');
  assert.throws(() => saveNamedConnection(file, { name: 'work', uri: otherUri }), {
    code: 'NAMED_CONNECTION_REPLACE_REQUIRED',
  });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.throws(() => saveNamedConnection(file, { name: 'work', uri: otherUri }, {
    replace: true, expectedRevision: 9,
  }), { code: 'NAMED_CONNECTION_REVISION_CONFLICT' });
  assert.equal(readFileSync(file, 'utf8'), before);

  const retargeted = saveNamedConnection(file, { name: 'work', uri: otherUri }, {
    replace: true, expectedRevision: 1,
  });
  assertCanonicalRecord(retargeted, { name: 'work', uri: otherUri, sessionId: null, revision: 2 });

  const linked = setNamedConnectionSession(file, 'work', sessionB, { expectedRevision: 2, uri: otherUri });
  const sameUriSaved = saveNamedConnection(file, { name: 'work', uri: otherUri });
  assert.equal(sameUriSaved.sessionId, sessionB);
  assert.equal(sameUriSaved.revision, linked.revision + 1);

  const cleared = saveNamedConnection(file, { name: 'work', uri: otherUri, sessionId: null });
  assert.equal(cleared.sessionId, null);
});

test('session assignment requires both expected revision and matching URI', t => {
  const { file } = fixture(t);
  const created = saveNamedConnection(file, { name: 'work', uri });
  const original = readFileSync(file, 'utf8');
  assert.throws(() => setNamedConnectionSession(file, 'work', sessionA, { uri }), {
    code: 'NAMED_CONNECTION_EXPECTED_REVISION_REQUIRED',
  });
  assert.throws(() => setNamedConnectionSession(file, 'work', sessionA, { expectedRevision: 9, uri }), {
    code: 'NAMED_CONNECTION_REVISION_CONFLICT',
  });
  assert.throws(() => setNamedConnectionSession(file, 'work', sessionA, {
    expectedRevision: created.revision, uri: otherUri,
  }), { code: 'NAMED_CONNECTION_URI_CONFLICT' });
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.throws(() => setNamedConnectionSession(file, 'work', 'not-a-session-id', {
    expectedRevision: created.revision, uri,
  }), { code: 'NAMED_CONNECTION_SESSION_ID_INVALID' });
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('corrupt or unsupported registries fail closed and are never overwritten', t => {
  const { file } = fixture(t);
  for (const contents of ['{bad json', JSON.stringify({ version: 2, connections: {} }), JSON.stringify({
    version: 1,
    connections: { work: { name: 'other', uri, sessionId: null, revision: 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } },
  })]) {
    writeFileSync(file, contents);
    assert.throws(() => readNamedConnections(file));
    assert.throws(() => saveNamedConnection(file, { name: 'new', uri }));
    assert.equal(readFileSync(file, 'utf8'), contents);
  }
});

test('concurrent processes retain independent updates and CAS permits one session writer', async t => {
  const { file } = fixture(t);
  saveNamedConnection(file, { name: 'seed', uri });

  const saves = await Promise.all(Array.from({ length: 6 }, (_, index) => spawnWorker([
    'save', file, `conn-${index}`, `vscode-remote://ssh-remote+host${index}/srv/project`, '', '',
  ])));
  assert.equal(saves.length, 6);
  assert.equal(listNamedConnections(file).length, 7);

  const casResults = await Promise.all([
    spawnWorker(['set', file, 'seed', uri, sessionA, '1']),
    spawnWorker(['set', file, 'seed', uri, sessionB, '1']),
  ]);
  assert.equal(casResults.filter(result => result === 'REVISION_CONFLICT').length, 1);
  assert.equal(casResults.filter(result => result !== 'REVISION_CONFLICT').length, 1);
  const finalRecord = getNamedConnection(file, 'seed');
  assert.equal(finalRecord.revision, 2);
  assert.ok([sessionA, sessionB].includes(finalRecord.sessionId));
});
