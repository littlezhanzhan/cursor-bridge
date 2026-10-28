import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorBridge } from '../server.mjs';
import { NamedConnectionController } from '../connection-controller.mjs';
import { inspectSshWindowIdentity } from '../ssh-window-identity.mjs';
import { saveNamedConnection, getNamedConnection } from '../named-connections.mjs';
import { updateCursorSessionRegistry } from '../cursor-session-registry.mjs';

const uri = 'vscode-remote://ssh-remote+alpha/srv/project';
const otherUri = 'vscode-remote://ssh-remote+beta/srv/project';
class FixtureBridge extends CursorBridge {
  constructor(root, thread = 'first') {
    super({ workspaceFile: join(root, 'workspaces.json'), workspaceKey: `codex-thread:${thread}`,
      sessionFile: join(root, 'sessions.json'), runtimeFile: null, modelPreferencesFile: null,
      runtimeMode: 'normal', delegationMode: 'on' });
    this.pages = [{ id: 'exact-window', type: 'page', webSocketDebuggerUrl: 'ws://test',
      identity: { remoteAuthority: 'ssh-remote+alpha', workspace: null,
        folderUri: { scheme: 'vscode-remote', authority: 'ssh-remote+alpha', path: '/srv/project' } } }];
    this.initCalls = [];
  }
  async _listSshPages() { return this.pages; }
  async _inspectSshPage(page, expected) { return inspectSshWindowIdentity(page.identity, expected); }
  async initializeSshWorkspace(...args) {
    this.initCalls.push(args[0]);
    if (this.beforeInit) await this.beforeInit();
    return super.initializeSshWorkspace(...args);
  }
  _drain() {}
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-named-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = new FixtureBridge(root);
  const file = join(root, 'connections.json');
  return { root, bridge, file, controller: new NamedConnectionController(bridge, { file }) };
}
function readySession(bridge, workspace = uri) {
  const session = bridge._claimNewSession({ taskId: 'previous-task', projectPath: workspace,
    readOnly: true, allowedPaths: [], requestId: 'previous-request', timeoutMs: 30000 });
  updateCursorSessionRegistry(bridge.sessionFile, registry => {
    Object.assign(registry.sessions[session.id], { state: 'ready', activeTaskId: null, lease: null,
      agentId: 'local:previous-agent', lastTask: { taskId: 'previous-task', status: 'completed',
        resultCollectedAt: '2026-10-28T00:00:00Z' } });
  });
  return session.id;
}

test('a new Codex thread restores the named workspace and exact old Agent using only the name', async t => {
  const { root, bridge, file, controller } = fixture(t);
  const sessionId = readySession(bridge);
  controller.save({ name: 'project', uri, sessionId });
  const fresh = new FixtureBridge(root, 'entirely-new-chat');
  assert.equal(fresh.projectPath, null);
  const restored = new NamedConnectionController(fresh, { file });
  const receipt = await restored.send('project', 'Continue the prior task', { requestId: 'new-chat-turn' });
  assert.deepEqual(fresh.initCalls, [uri]);
  assert.equal(receipt.sessionReused, true);
  assert.equal(receipt.sessionId, sessionId);
  assert.equal(receipt.agentId, 'local:previous-agent');
  assert.equal(fresh.queue.length, 1);
  assert.equal(fresh.queue[0].newChat, false);
  assert.equal(fresh.queue[0].readOnly, true);
  assert.equal(getNamedConnection(file, 'project').sessionId, sessionId);
});

test('a first named turn saves its new session and retries do not create another Agent', async t => {
  const { bridge, file, controller } = fixture(t);
  controller.save({ name: 'project', uri });
  const first = await controller.send('project', 'Read only', { requestId: 'first-turn' });
  assert.equal(first.sessionReused, false);
  assert.equal(getNamedConnection(file, 'project').sessionId, first.sessionId);
  const retry = await controller.send('project', 'Read only', { requestId: 'first-turn' });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.sessionId, first.sessionId);
  assert.equal(bridge.queue.length, 1);
  assert.equal(bridge.initCalls.length, 1);
});

test('new_session=true explicitly creates a different dedicated Agent mapping', async t => {
  const { bridge, controller, file } = fixture(t);
  const oldSession = readySession(bridge);
  controller.save({ name: 'project', uri, sessionId: oldSession });
  const receipt = await controller.send('project', 'New read-only chat', { requestId: 'new-agent', newSession: true });
  assert.notEqual(receipt.sessionId, oldSession);
  assert.equal(receipt.sessionReused, false);
  assert.equal(bridge.queue[0].newChat, true);
  assert.equal(getNamedConnection(file, 'project').sessionId, receipt.sessionId);
});

test('missing names and invalid saved sessions fail before touching the Cursor window', async t => {
  const { bridge, controller, file } = fixture(t);
  await assert.rejects(controller.send('missing', 'Read', { requestId: 'a' }), /CONNECTION_NOT_FOUND/);
  saveNamedConnection(file, { name: 'missing-session', uri,
    sessionId: 'cursor-session-11111111-1111-4111-8111-111111111111' });
  await assert.rejects(controller.send('missing-session', 'Read', { requestId: 'b' }), /CONNECTION_SESSION_NOT_FOUND/);
  const wrong = readySession(bridge, otherUri);
  assert.throws(() => controller.save({ name: 'wrong-host', uri, sessionId: wrong }), /CONNECTION_SESSION_MISMATCH/);
  assert.equal(bridge.initCalls.length, 0);
  assert.equal(bridge.queue.length, 0);
});

test('failed window validation leaves the named session mapping unchanged', async t => {
  const { bridge, controller, file } = fixture(t);
  const saved = controller.save({ name: 'project', uri });
  bridge.pages = [];
  await assert.rejects(controller.send('project', 'Read', { requestId: 'failed-init' }), /SSH_WORKSPACE_NOT_FOUND/);
  assert.deepEqual(getNamedConnection(file, 'project'), saved);
  assert.equal(bridge.queue.length, 0);
});

test('a mapping changed during submission is not overwritten and returns the already-submitted receipt', async t => {
  const { bridge, controller, file } = fixture(t);
  controller.save({ name: 'project', uri });
  bridge.beforeInit = async () => saveNamedConnection(file, { name: 'project', uri: otherUri }, { replace: true });
  const receipt = await controller.send('project', 'Read the selected target', { requestId: 'raced-mapping' });
  assert.equal(receipt.connectionUpdated, false);
  assert.equal(receipt.warningCode, 'CONNECTION_MAPPING_CHANGED_AFTER_SUBMISSION');
  assert.ok(receipt.taskId && receipt.sessionId);
  assert.equal(getNamedConnection(file, 'project').uri, otherUri);
  assert.equal(bridge.queue[0].projectPath, uri);
  assert.equal(bridge.queue.length, 1);
});

test('get and list expose stored metadata without initializing or sending', t => {
  const { bridge, controller } = fixture(t);
  controller.save({ name: 'project', uri });
  assert.equal(controller.get('project').defaultBehavior, 'create-first-session');
  assert.equal(controller.list().connections.length, 1);
  assert.equal(bridge.initCalls.length, 0);
  assert.equal(bridge.queue.length, 0);
});
