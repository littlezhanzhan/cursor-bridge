import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorBridge } from '../server.mjs';
import { readCursorSessionRegistry, updateCursorSessionRegistry } from '../cursor-session-registry.mjs';

const uri = 'vscode-remote://ssh-remote+fixture/srv/project';
class Fixture extends CursorBridge {
  constructor(root, caller) {
    super({ workspaceFile: join(root, `${caller}-workspace.json`), workspaceKey: caller,
      callerIdentity: { key: caller, source: 'fixture', persistent: true }, sessionFile: join(root, 'sessions.json'),
      uiLockPath: join(root, 'ui.lock'), runtimeFile: null, modelPreferencesFile: null });
    this.submissions = 0;
  }
  _drain() {}
  async _listSshPages() { return [{ id: 'fixture-target' }]; }
  async _inspectSshPage() { return { ok: true }; }
  async _submitParallelAgent(job) {
    this.submissions++;
    job.targetId = 'fixture-target';
    job.sendState = 'sent';
    return { agent: { id: 'local:11111111-1111-4111-8111-111111111111' } };
  }
}
async function fixtures(t) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-concurrent-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = new Fixture(root, 'caller-a'), b = new Fixture(root, 'caller-b');
  await Promise.all([a.initializeSshWorkspace(uri), b.initializeSshWorkspace(uri)]);
  const ra = await a.sshSessionTurn('A', { requestId: 'a' });
  const rb = await b.sshSessionTurn('B', { requestId: 'b' });
  return { a, b, ra, rb };
}
test('a queued sender rechecks an unbound predecessor after that adapter dies', async t => {
  const { a, b, ra, rb } = await fixtures(t);
  updateCursorSessionRegistry(a.sessionFile, registry => {
    registry.sessions[ra.sessionId].lease.adapterPid = 2147483647;
  });
  await CursorBridge.prototype._drain.call(b);
  assert.equal(b.submissions, 0);
  const job = b.tasks.get(rb.taskId);
  assert.equal(job.status, 'failed');
  assert.equal(job.sendState, 'not_sent');
  assert.match(job.error, /SSH_WORKSPACE_BUSY/);
});
test('uncertain submission is persisted before the UI critical section exits and blocks queued senders', async t => {
  const { a, b, ra, rb } = await fixtures(t);
  let fencedBeforeRelease = false;
  a._submitParallelAgent = async job => {
    a.submissions++;
    job.sendState = 'dispatching';
    throw new Error('lost confirmation after Enter');
  };
  a._withUiLock = fn => CursorBridge.prototype._withUiLock.call(a, async () => {
    try { return await fn(); }
    finally { fencedBeforeRelease = readCursorSessionRegistry(a.sessionFile).sessions[ra.sessionId].state === 'needs_attention'; }
  });
  await CursorBridge.prototype._drain.call(a);
  assert.equal(fencedBeforeRelease, true);
  assert.equal(a.tasks.get(ra.taskId).status, 'needs_attention');
  await CursorBridge.prototype._drain.call(b);
  assert.equal(b.submissions, 0);
  assert.equal(b.tasks.get(rb.taskId).sendState, 'not_sent');
});
test('an error after successful UI submission retains the exact Agent and uncertain task reservation', async t => {
  const { a, ra } = await fixtures(t);
  a._withUiLock = async fn => {
    await CursorBridge.prototype._withUiLock.call(a, fn);
    throw Object.assign(new Error('lock cleanup failed'), { code: 'LOCK_RELEASE_FAILED' });
  };
  await CursorBridge.prototype._drain.call(a);
  const job = a.tasks.get(ra.taskId);
  const session = readCursorSessionRegistry(a.sessionFile).sessions[ra.sessionId];
  assert.equal(a.submissions, 1);
  assert.equal(job.status, 'needs_attention');
  assert.equal(session.agentId, job.agentId);
  assert.equal(session.state, 'needs_attention');
  assert.ok(job.agentId && a.activeParallel.has(job.id));
});
