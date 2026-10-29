import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CursorBridge, buildToolDefinitions } from '../server.mjs';
import { NamedConnectionController } from '../connection-controller.mjs';
import { saveNamedConnection, getNamedConnection } from '../named-connections.mjs';
import { setCallerConnectionSession } from '../caller-connections.mjs';
import { readCursorSessionRegistry, updateCursorSessionRegistry } from '../cursor-session-registry.mjs';

const uri = 'vscode-remote://ssh-remote+fixture/srv/project';
class Fixture extends CursorBridge {
  constructor(root, caller) {
    super({ workspaceFile: join(root, `${caller}.json`), workspaceKey: caller,
      callerIdentity: { key: caller, source: 'fixture', persistent: true },
      sessionFile: join(root, 'sessions.json'), uiLockPath: join(root, 'ui.lock'),
      runtimeFile: null, modelPreferencesFile: null });
  }
  async _listSshPages() { return [{ id: 'fixture-window' }]; }
  async _inspectSshPage() { return { ok: true }; }
  _drain() {}
}
async function fixture(t, caller = 'caller-a', root) {
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'cursor-ssh-write-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
  }
  const bridge = new Fixture(root, caller);
  await bridge.initializeSshWorkspace(uri);
  return { root, bridge };
}
const saved = (b, sid) => readCursorSessionRegistry(b.sessionFile).sessions[sid];
const policy = s => ({ envelope: s.scopeEnvelope, hasWriteFlag: Object.hasOwn(s, 'sshWriteEnabled'), writeFlag: s.sshWriteEnabled });
function finish(b, receipt) {
  const job = b.tasks.get(receipt.taskId);
  job.agentId ||= `local:${randomUUID()}`;
  b.queue = b.queue.filter(item => item.id !== job.id);
  b._finishJob(job, 'fixture result');
  b._markTaskResultCollected(job);
}
function legacy(b) {
  const session = b._claimNewSession({ taskId: 'legacy', projectPath: uri,
    readOnly: true, allowedPaths: [], requestId: 'legacy', timeoutMs: 60000 });
  updateCursorSessionRegistry(b.sessionFile, r => Object.assign(r.sessions[session.id], {
    agentId: `local:${randomUUID()}`, state: 'ready', activeTaskId: null, lease: null,
    lastTask: { taskId: 'legacy', status: 'completed', resultCollectedAt: new Date().toISOString() },
  }));
  return session.id;
}

test('new SSH Agents default to write-capable tasks without required write paths', async t => {
  const { bridge } = await fixture(t);
  const r = await bridge.sshSessionTurn('Create a task-authorized file', { requestId: 'write-new' });
  const job = bridge.tasks.get(r.taskId), session = saved(bridge, r.sessionId);
  assert.equal(job.readOnly, false);
  assert.deepEqual(job.allowedPaths, []);
  assert.equal(session.sshWriteEnabled, true);
  assert.equal(bridge.sessionStatus(r.sessionId).writeEnabled, true);
  assert.doesNotMatch(job.prompt, /Read-only boundary: Do not modify/);
});
test('read_only=true applies to the task and does not remove a new Agent write capability', async t => {
  const { bridge } = await fixture(t);
  const first = await bridge.sshSessionTurn('Inspect only', { requestId: 'read-first', readOnly: true });
  assert.equal(bridge.tasks.get(first.taskId).readOnly, true);
  assert.match(bridge.tasks.get(first.taskId).prompt, /Read-only boundary: Do not modify/);
  assert.equal(saved(bridge, first.sessionId).sshWriteEnabled, true);
  finish(bridge, first);
  const second = await bridge.sshSessionTurn('Now edit', { requestId: 'write-second', sessionId: first.sessionId });
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(bridge.tasks.get(second.taskId).readOnly, false);
  finish(bridge, second);
  const third = await bridge.sshSessionTurn('Inspect only again', { requestId: 'read-third', sessionId: first.sessionId, readOnly: true });
  assert.equal(bridge.tasks.get(third.taskId).readOnly, true);
});
test('historical read-only session policy is preserved and write requests fail without upgrading it', async t => {
  const { bridge } = await fixture(t);
  const id = legacy(bridge), before = policy(saved(bridge, id));
  await assert.rejects(bridge.sshSessionTurn('Write', { sessionId: id, requestId: 'must-reject', readOnly: false }), /SESSION_SCOPE_EXPANSION/);
  assert.deepEqual(policy(saved(bridge, id)), before);
  const read = await bridge.sshSessionTurn('Inspect', { sessionId: id, requestId: 'legacy-read' });
  assert.equal(bridge.tasks.get(read.taskId).readOnly, true);
  assert.deepEqual(policy(saved(bridge, id)), before);
});
test('named connection requires a new Agent to replace a historical read-only caller binding', async t => {
  const { root, bridge } = await fixture(t);
  const id = legacy(bridge), before = policy(saved(bridge, id));
  const file = join(root, 'connections.json'), callerFile = join(root, 'caller.json');
  const old = saveNamedConnection(file, { name: 'project', uri, sessionId: id });
  setCallerConnectionSession(callerFile, bridge.callerKey, old, id, { expectedRevision: 0 });
  const controller = new NamedConnectionController(bridge, { file, callerFile });
  await assert.rejects(controller.send('project', 'Edit', { requestId: 'old-write', readOnly: false }), { code: 'SSH_SESSION_READ_ONLY' });
  assert.equal(controller.get('project').sessionId, id);
  const receipt = await controller.send('project', 'Edit in new Agent', { requestId: 'new-write', newSession: true, readOnly: false });
  assert.notEqual(receipt.sessionId, id);
  assert.equal(saved(bridge, receipt.sessionId).sshWriteEnabled, true);
  assert.deepEqual(policy(saved(bridge, id)), before);
  assert.deepEqual(getNamedConnection(file, 'project'), old);
});
test('independent new writers retain Agent/UI coordination without adding file conflict scheduling', async t => {
  const { root, bridge: a } = await fixture(t);
  const { bridge: b } = await fixture(t, 'caller-b', root);
  const receipts = await Promise.all([a.sshSessionTurn('Edit', { requestId: 'same' }), b.sshSessionTurn('Edit', { requestId: 'same' })]);
  assert.notEqual(receipts[0].sessionId, receipts[1].sessionId);
  assert.equal(a.queue.length + b.queue.length, 2);
  assert.ok([a, b].every(x => x.queue[0].readOnly === false && x.queue[0].allowedPaths.length === 0));
});
test('SSH task schemas carry read_only through both named and direct entry points', async t => {
  const { bridge } = await fixture(t);
  const definitions = new Map(buildToolDefinitions(bridge).map(d => [d.name, d]));
  for (const name of ['cursor_connection_send', 'cursor_ssh_session']) {
    assert.equal(definitions.get(name).inputSchema.properties.read_only.type, 'boolean');
    assert.equal(definitions.get(name).inputSchema.properties.allowed_paths, undefined);
  }
  await assert.rejects(bridge.sshSessionTurn('Invalid mode', { requestId: 'bad', readOnly: 'false' }), { code: 'SSH_TASK_MODE_INVALID' });
});
