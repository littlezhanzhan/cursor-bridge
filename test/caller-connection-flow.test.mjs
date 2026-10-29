import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CursorBridge } from '../server.mjs';
import { NamedConnectionController } from '../connection-controller.mjs';
import { inspectSshWindowIdentity } from '../ssh-window-identity.mjs';
import { callerConnectionKey, getCallerConnection } from '../caller-connections.mjs';
import { getNamedConnection, saveNamedConnection } from '../named-connections.mjs';
import { updateCursorSessionRegistry } from '../cursor-session-registry.mjs';

const uri = 'vscode-remote://ssh-remote+alpha/srv/project';
const agentUuid = () => randomUUID().toLowerCase();
const callerIdentity = suffix => ({
  key: `codex-thread:${suffix}`,
  source: 'fixture',
  persistent: true,
});

class FixtureBridge extends CursorBridge {
  constructor(paths, identity) {
    super({
      workspaceFile: join(paths.root, `workspace-${randomUUID()}.json`),
      workspaceKey: identity.key,
      callerIdentity: identity,
      sessionFile: paths.sessionFile,
      runtimeFile: null,
      modelPreferencesFile: null,
      uiLockPath: paths.uiLockPath,
      runtimeMode: 'normal',
      delegationMode: 'on',
    });
    this.pages = [{
      id: 'fixture-ssh-target',
      type: 'page',
      webSocketDebuggerUrl: 'ws://fixture.invalid/cdp',
      identity: {
        remoteAuthority: 'ssh-remote+alpha',
        folderUri: {
          scheme: 'vscode-remote',
          authority: 'ssh-remote+alpha',
          path: '/srv/project',
          query: '',
          fragment: '',
        },
        workspace: null,
      },
    }];
    this.initCalls = [];
    this.sshTurnCalls = [];
  }

  async _listSshPages() { return this.pages; }

  async _inspectSshPage(page, expectedWorkspace) {
    return inspectSshWindowIdentity(page.identity, expectedWorkspace);
  }

  async initializeSshWorkspace(...args) {
    this.initCalls.push(args[0]);
    return super.initializeSshWorkspace(...args);
  }

  _drain() {}

  async sshSessionTurn(prompt, options = {}) {
    this.sshTurnCalls.push({ prompt, options: { ...options } });
    const projectPath = options.workspacePath || this.projectPath;
    const requestId = options.requestId;
    const timeoutMs = Number(options.timeoutMs ?? 60000);
    const taskId = this._nextTaskId();
    let session;
    const sessionMode = options.sessionId ? 'continue' : 'create';

    if (options.sessionId) {
      const claimed = this._claimExistingSession({
        sessionId: options.sessionId,
        taskId,
        projectPath,
        readOnly: true,
        allowedPaths: [],
        requestId,
        timeoutMs,
      });
      if (claimed.duplicate) {
        const duplicate = claimed.session;
        return {
          duplicate: true,
          taskId: duplicate.activeTaskId || duplicate.lastTask?.taskId || taskId,
          sessionId: duplicate.id,
          agentId: duplicate.agentId,
        };
      }
      session = claimed.session;
    } else {
      session = this._claimNewSession({
        taskId,
        projectPath,
        readOnly: true,
        allowedPaths: [],
        modelPreference: null,
        requestId,
        timeoutMs,
      });
      if (session.duplicateRequest) {
        return {
          duplicate: true,
          taskId: session.activeTaskId || session.lastTask?.taskId || taskId,
          sessionId: session.id,
          agentId: session.agentId || null,
        };
      }
      const assignedAgentId = `local:${agentUuid()}`;
      updateCursorSessionRegistry(this.sessionFile, registry => {
        const stored = registry.sessions[session.id];
        stored.agentId = assignedAgentId;
        stored.agentLabel = 'Fixture Agent';
        stored.state = 'busy';
        stored.updatedAt = new Date().toISOString();
      });
      session = this._readSession(session.id);
    }

    const job = this._enqueue('do', prompt, {
      taskId,
      timeoutMs,
      requestedTimeoutMs: timeoutMs,
      newChat: sessionMode === 'create',
      execution: 'parallel_agent',
      readOnly: true,
      allowedPaths: [],
      projectPath,
      sessionMode,
      sessionId: session.id,
      sessionTurn: session.turnIndex,
      sessionEpoch: session.epoch,
      sessionState: session.state,
      requestId,
      agentId: session.agentId,
      agentLabel: session.agentLabel || 'Fixture Agent',
    });
    return {
      taskId: job.id,
      sessionId: session.id,
      agentId: session.agentId,
      status: job.status,
      execution: job.execution,
    };
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-caller-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = {
    root,
    sessionFile: join(root, 'sessions.json'),
    connectionFile: join(root, 'connections-v1.json'),
    callerFile: join(root, 'caller-connections-v1.json'),
    uiLockPath: join(root, 'ui.lock'),
  };
  const bridge = (identity) => new FixtureBridge(paths, identity);
  const controller = (targetBridge) => new NamedConnectionController(targetBridge, {
    file: paths.connectionFile,
    callerFile: paths.callerFile,
  });
  return { ...paths, bridge, controller };
}

function createReadySession(bridge, taskLabel = 'seed') {
  const taskId = `cursor-task-${agentUuid()}`;
  const requestId = `seed-${taskLabel}-${agentUuid()}`;
  const session = bridge._claimNewSession({
    taskId,
    projectPath: uri,
    readOnly: true,
    allowedPaths: [],
    modelPreference: null,
    requestId,
    timeoutMs: 60000,
  });
  const agentId = `local:${agentUuid()}`;
  updateCursorSessionRegistry(bridge.sessionFile, registry => {
    const stored = registry.sessions[session.id];
    stored.agentId = agentId;
    stored.agentLabel = 'Fixture Agent';
    stored.state = 'ready';
    stored.activeTaskId = null;
    stored.lease = null;
    stored.lastTask = {
      taskId,
      turnIndex: 1,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      resultCollectedAt: new Date().toISOString(),
    };
    stored.updatedAt = new Date().toISOString();
  });
  return { sessionId: session.id, agentId, taskId };
}

function settleFixtureTurn(bridge, receipt) {
  const job = bridge.tasks.get(receipt.taskId);
  assert.ok(job, `fixture task ${receipt.taskId} should exist`);
  bridge._finishJob(job, 'fixture read-only result');
  bridge._markTaskResultCollected(job);
  bridge.queue = bridge.queue.filter(item => item.id !== job.id);
}

test('default caller scope creates separate Agents for different callers and ignores a legacy shared SID', async t => {
  const f = fixture(t);
  const legacyBridge = f.bridge(callerIdentity('00000000-0000-4000-8000-000000000000'));
  const legacy = createReadySession(legacyBridge, 'legacy-shared');
  saveNamedConnection(f.connectionFile, { name: 'project', uri, sessionId: legacy.sessionId });
  const sharedBytesBefore = readFileSync(f.connectionFile, 'utf8');

  const bridgeA = f.bridge(callerIdentity('11111111-1111-4111-8111-111111111111'));
  const bridgeB = f.bridge(callerIdentity('22222222-2222-4222-8222-222222222222'));
  const [receiptA, receiptB] = await Promise.all([
    f.controller(bridgeA).send('project', 'Read only fixture A', { requestId: 'same-request-id' }),
    f.controller(bridgeB).send('project', 'Read only fixture B', { requestId: 'same-request-id' }),
  ]);

  assert.equal(receiptA.sessionReused, false);
  assert.equal(receiptB.sessionReused, false);
  assert.notEqual(receiptA.sessionId, receiptB.sessionId);
  assert.notEqual(receiptA.agentId, receiptB.agentId);
  assert.equal(bridgeA.queue.length, 1);
  assert.equal(bridgeB.queue.length, 1);
  assert.equal(bridgeA.sshTurnCalls.length, 1);
  assert.equal(bridgeB.sshTurnCalls.length, 1);
  assert.equal(getCallerConnection(f.callerFile, bridgeA.callerKey, { name: 'project', uri }).sessionId,
    receiptA.sessionId);
  assert.equal(getCallerConnection(f.callerFile, bridgeB.callerKey, { name: 'project', uri }).sessionId,
    receiptB.sessionId);
  assert.equal(getNamedConnection(f.connectionFile, 'project').sessionId, legacy.sessionId);
  assert.equal(readFileSync(f.connectionFile, 'utf8'), sharedBytesBefore);
});

test('the same caller resumes its own SID and Agent after a Bridge restart and manual settlement', async t => {
  const f = fixture(t);
  saveNamedConnection(f.connectionFile, { name: 'project', uri });
  const identity = callerIdentity('33333333-3333-4333-8333-333333333333');
  const firstBridge = f.bridge(identity);
  const first = await f.controller(firstBridge).send('project', 'First fixture turn', { requestId: 'turn-1' });
  assert.equal(first.sessionReused, false);
  settleFixtureTurn(firstBridge, first);

  const restartedBridge = f.bridge(identity);
  const second = await f.controller(restartedBridge).send('project', 'Follow-up fixture turn', { requestId: 'turn-2' });
  assert.equal(second.sessionReused, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.agentId, first.agentId);
  assert.equal(restartedBridge.sshTurnCalls[0].options.sessionId, first.sessionId);
  assert.equal(restartedBridge.queue.length, 1);
  assert.equal(getCallerConnection(f.callerFile, identity.key, { name: 'project', uri }).sessionId, first.sessionId);
});

test('a same-caller concurrent duplicate request is queued once', async t => {
  const f = fixture(t);
  saveNamedConnection(f.connectionFile, { name: 'project', uri });
  const bridge = f.bridge(callerIdentity('44444444-4444-4444-8444-444444444444'));
  const controller = f.controller(bridge);
  const [first, retry] = await Promise.all([
    controller.send('project', 'Same fixture request', { requestId: 'repeat-this-request' }),
    controller.send('project', 'Same fixture request', { requestId: 'repeat-this-request' }),
  ]);

  assert.equal(bridge.sshTurnCalls.length, 1);
  assert.equal(bridge.queue.length, 1);
  assert.equal(first.sessionId, retry.sessionId);
  assert.equal(first.taskId, retry.taskId);
  assert.equal([first, retry].filter(item => item.duplicate === true).length, 1);
});

test('different callers may use the same request ID without sharing a session', async t => {
  const f = fixture(t);
  saveNamedConnection(f.connectionFile, { name: 'project', uri });
  const bridgeA = f.bridge(callerIdentity('55555555-5555-4555-8555-555555555555'));
  const bridgeB = f.bridge(callerIdentity('66666666-6666-4666-8666-666666666666'));
  const requestId = 'identical-request-id';
  const [a, b] = await Promise.all([
    f.controller(bridgeA).send('project', 'Caller A', { requestId }),
    f.controller(bridgeB).send('project', 'Caller B', { requestId }),
  ]);

  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(a.agentId, b.agentId);
  assert.equal(bridgeA.queue.length, 1);
  assert.equal(bridgeB.queue.length, 1);
  assert.equal(getCallerConnection(f.callerFile, bridgeA.callerKey, { name: 'project', uri }).sessionId, a.sessionId);
  assert.equal(getCallerConnection(f.callerFile, bridgeB.callerKey, { name: 'project', uri }).sessionId, b.sessionId);
});

test('busy caller binding rejects a different turn while newSession creates an independent Agent', async t => {
  const f = fixture(t);
  saveNamedConnection(f.connectionFile, { name: 'project', uri });
  const bridge = f.bridge(callerIdentity('77777777-7777-4777-8777-777777777777'));
  const controller = f.controller(bridge);
  const first = await controller.send('project', 'Keep first fixture task active', { requestId: 'busy-1' });

  await assert.rejects(controller.send('project', 'Do not implicitly queue another round', { requestId: 'busy-2' }),
    error => error.code === 'CONNECTION_SESSION_BUSY');
  assert.equal(bridge.sshTurnCalls.length, 1);
  assert.equal(bridge.queue.length, 1);

  const independent = await controller.send('project', 'Explicit independent fixture task', {
    requestId: 'new-agent-2',
    newSession: true,
  });
  assert.equal(independent.sessionReused, false);
  assert.notEqual(independent.sessionId, first.sessionId);
  assert.notEqual(independent.agentId, first.agentId);
  assert.equal(bridge.sshTurnCalls.length, 2);
  assert.equal(bridge.queue.length, 2);
  assert.equal(bridge.sshTurnCalls[1].options.sessionId, undefined);
  assert.equal(getCallerConnection(f.callerFile, bridge.callerKey, { name: 'project', uri }).sessionId,
    independent.sessionId);
});

test('explicit shared scope reuses the legacy SID and prevents a concurrent second round', async t => {
  const f = fixture(t);
  const legacyBridge = f.bridge(callerIdentity('88888888-8888-4888-8888-888888888888'));
  const legacy = createReadySession(legacyBridge, 'shared-session');
  const stored = saveNamedConnection(f.connectionFile, { name: 'project', uri, sessionId: legacy.sessionId });

  const bridgeA = f.bridge(callerIdentity('99999999-9999-4999-8999-999999999999'));
  const bridgeB = f.bridge(callerIdentity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  const sharedA = await f.controller(bridgeA).send('project', 'Explicitly shared round one', {
    requestId: 'shared-1', sessionScope: 'shared',
  });
  assert.equal(sharedA.sessionReused, true);
  assert.equal(sharedA.sessionId, legacy.sessionId);
  assert.equal(sharedA.agentId, legacy.agentId);
  assert.equal(bridgeA.sshTurnCalls[0].options.sessionId, legacy.sessionId);
  assert.equal(getNamedConnection(f.connectionFile, 'project').sessionId, legacy.sessionId);

  await assert.rejects(f.controller(bridgeB).send('project', 'Explicitly shared round two', {
    requestId: 'shared-2', sessionScope: 'shared',
  }), error => error.code === 'CONNECTION_SESSION_BUSY');
  assert.equal(bridgeA.queue.length, 1);
  assert.equal(bridgeB.queue.length, 0);
  assert.equal(bridgeB.sshTurnCalls.length, 0);
  assert.equal(getNamedConnection(f.connectionFile, 'project').revision, stored.revision + 1);
});

test('dispatch-lock cleanup failure preserves an already submitted task receipt instead of inviting a resend', async t => {
  const f = fixture(t);
  saveNamedConnection(f.connectionFile, { name: 'project', uri });
  const bridge = f.bridge(callerIdentity('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
  const controller = f.controller(bridge);
  const send = controller._send.bind(controller);
  controller._send = async (...args) => {
    const receipt = await send(...args);
    const key = callerConnectionKey(bridge.callerKey, 'project', uri);
    writeFileSync(join(dirname(controller.callerFile), 'connection-dispatch', `${key}.lock`, 'unexpected'), 'fixture');
    return receipt;
  };
  const receipt = await controller.send('project', 'Read metadata', { requestId: 'release-failure' });
  assert.ok(receipt.taskId && receipt.sessionId);
  assert.equal(receipt.warningCode, 'CONNECTION_DISPATCH_LOCK_RELEASE_FAILED');
  assert.match(receipt.warning, /already submitted/);
  assert.equal(bridge.queue.length, 1);
  assert.equal(controller.get('project').sessionId, receipt.sessionId);
});
