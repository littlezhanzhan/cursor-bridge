import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CursorBridge } from '../server.mjs';
import { ExistingAgentController, existingWindowProject, inspectExistingAgentDocument } from '../existing-agent.mjs';
import { EXPR_SSH_WINDOW_IDENTITY, inspectSshWindowIdentity } from '../ssh-window-identity.mjs';
import { getAgentAttachment } from '../agent-attachments.mjs';
import { createCursorSessionId, readCursorSessionRegistry, updateCursorSessionRegistry } from '../cursor-session-registry.mjs';
import { parseSshWorkspace } from '../remote-workspace.mjs';

const TARGET_ID = 'fixture-target';
const AGENT_A = 'local:11111111-1111-4111-8111-111111111111';
const AGENT_B = 'local:22222222-2222-4222-8222-222222222222';
const SNAPSHOT_EXPRESSION = 'existing-agent-fixture-snapshot';
const SSH_URI = 'vscode-remote://ssh-remote+fixture/srv/project';

function localWorkspaceIdentity(projectPath) {
  return { remoteAuthority: null, folderUri: pathToFileURL(projectPath).href, workspace: null };
}

function sshWorkspaceIdentity(uri = SSH_URI) {
  const parsed = parseSshWorkspace(uri);
  return {
    remoteAuthority: parsed.authority,
    folderUri: {
      scheme: 'vscode-remote',
      authority: parsed.authority,
      path: parsed.remotePath,
      query: '',
      fragment: '',
    },
    workspace: null,
  };
}

function fixtureDocument({
  agentId = AGENT_A,
  status = 'completed',
  selected = true,
  showSpinner = false,
  draftText = '',
  attachmentCount = 0,
  composerCount = 1,
} = {}) {
  const rawId = agentId.replace(/^local:/, '').toLowerCase();
  const input = { offsetParent: {}, innerText: draftText, textContent: draftText, files: [] };
  const attachments = Array.from({ length: attachmentCount }, () => ({ offsetParent: {}, tagName: 'DIV' }));
  const bar = {
    offsetParent: {},
    dataset: { composerId: rawId, composerStatus: status },
    querySelectorAll(selector) {
      if (selector.includes('contenteditable="true"')) return [input];
      if (selector.includes('.context-pill')) return attachments;
      if (selector.includes('button[aria-label^="Stop"]')) return [];
      return [];
    },
  };
  const bars = Array.from({ length: composerCount }, () => bar);
  const document = {
    querySelectorAll(selector) {
      if (selector === '.composer-bar[data-composer-id]') return bars;
      if (selector.startsWith('[role="dialog"]')) return [];
      if (selector.startsWith('.markdown-root')) return [];
      return [];
    },
  };
  const adapterEntries = [{ id: agentId, durable: true, isSelected: selected, showSpinner }];
  return inspectExistingAgentDocument(document, adapterEntries);
}

class FixtureBridge extends CursorBridge {
  constructor(root, {
    callerKey = 'caller-a',
    projectPath,
    identity,
    pages,
    snapshot,
    snapshots = [],
    attachmentFile,
  } = {}) {
    const safeCaller = callerKey.replace(/[^A-Za-z0-9_-]/g, '_');
    const fixtureAttachmentFile = attachmentFile || join(root, 'attachments.json');
    super({
      adapterStartCwd: root,
      workspaceFile: join(root, `workspace-${safeCaller}.json`),
      workspaceKey: callerKey,
      callerIdentity: { key: callerKey, source: 'fixture', persistent: true },
      sessionFile: join(root, 'sessions.json'),
      uiLockPath: join(root, 'ui.lock'),
      attachmentFile: fixtureAttachmentFile,
      runtimeFile: null,
      modelPreferencesFile: null,
      delegationMode: 'on',
    });
    this.fixtureAttachmentFile = fixtureAttachmentFile;
    this.fixtureProjectPath = projectPath;
    this.fixtureState = {
      identity,
      snapshot,
      snapshots: [...snapshots],
      events: [],
      closedClients: 0,
    };
    this.pages = pages || [{ id: TARGET_ID, type: 'page', webSocketDebuggerUrl: 'ws://fixture/selected' }];
    this.ensureCursorCalls = 0;
    this._drain = () => {};
    this._ensureCursor = async () => {
      this.ensureCursorCalls++;
      throw new Error('Fixture forbids launch/ensure; existing-Agent flow must not call it');
    };
    this.existingAgentController = new ExistingAgentController(this, {
      expression: SNAPSHOT_EXPRESSION,
      file: this.fixtureAttachmentFile,
      createClient: () => this._createFixtureClient(),
    });
  }

  async _listSshPages() { return this.pages; }

  _createFixtureClient() {
    const state = this.fixtureState;
    return {
      ready: Promise.resolve(),
      async send(method, params) {
        state.events.push({ method, expression: params?.expression || null });
        assert.equal(method, 'Runtime.evaluate', 'the fixture allows only metadata-only Runtime.evaluate');
        if (params.expression === EXPR_SSH_WINDOW_IDENTITY) {
          return { result: { value: JSON.stringify(state.identity) } };
        }
        if (params.expression === SNAPSHOT_EXPRESSION) {
          const snapshot = state.snapshots.length ? state.snapshots.shift() : state.snapshot;
          return { result: { value: JSON.stringify(snapshot) } };
        }
        throw new Error(`Unexpected renderer expression: ${params.expression}`);
      },
      close() { state.closedClients++; },
    };
  }
}

function fixtureRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-existing-agent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeLocalFixture(t, options = {}) {
  const root = options.root || fixtureRoot(t);
  const projectPath = options.projectPath || join(root, 'project space % 100');
  mkdirSync(projectPath, { recursive: true });
  const identity = options.identity || localWorkspaceIdentity(projectPath);
  const bridge = new FixtureBridge(root, {
    callerKey: options.callerKey,
    projectPath,
    identity,
    pages: options.pages,
    snapshot: options.snapshot || fixtureDocument(),
    snapshots: options.snapshots,
    attachmentFile: options.attachmentFile,
  });
  return { root, projectPath, identity, bridge, attachmentFile: bridge.fixtureAttachmentFile };
}

function makeSshFixture(t, options = {}) {
  const root = options.root || fixtureRoot(t);
  const identity = options.identity || sshWorkspaceIdentity();
  const projectPath = options.projectPath || SSH_URI;
  const bridge = new FixtureBridge(root, {
    callerKey: options.callerKey,
    projectPath,
    identity,
    pages: options.pages,
    snapshot: options.snapshot || fixtureDocument(),
    snapshots: options.snapshots,
    attachmentFile: options.attachmentFile,
  });
  return { root, projectPath, identity, bridge, attachmentFile: bridge.fixtureAttachmentFile };
}

async function attach(bridge, options = {}) {
  return bridge.existingAgentController.attach({
    expectedAgentId: options.expectedAgentId || AGENT_A,
    targetId: options.targetId === undefined ? TARGET_ID : options.targetId,
    ...(options.workspacePath !== undefined ? { workspacePath: options.workspacePath } : {}),
  });
}

function sessionPolicy(session) {
  return {
    scopeEnvelope: JSON.parse(JSON.stringify(session.scopeEnvelope)),
    sshWriteEnabledPresent: Object.hasOwn(session, 'sshWriteEnabled'),
    sshWriteEnabledValue: session.sshWriteEnabled,
  };
}

function seedSession(bridge, { agentId = AGENT_A, readOnly, allowedPaths = [], sshWriteEnabled, state = 'ready' }) {
  const taskId = `seed-${createCursorSessionId()}`;
  const created = bridge._claimNewSession({
    taskId,
    projectPath: bridge.fixtureProjectPath,
    readOnly,
    allowedPaths,
    modelPreference: null,
    requestId: `seed-request-${createCursorSessionId()}`,
    timeoutMs: 60000,
    sshWriteEnabled: sshWriteEnabled === true,
  });
  updateCursorSessionRegistry(bridge.sessionFile, registry => {
    const session = registry.sessions[created.id];
    session.state = state;
    session.agentId = agentId;
    session.activeTaskId = state === 'ready' ? null : 'fixture-active-task';
    session.lease = state === 'ready' ? null : { taskId: 'fixture-active-task', adapterPid: process.pid,
      expiresAt: new Date(Date.now() + 60000).toISOString() };
    session.scopeEnvelope = { readOnly, allowedPaths: [...allowedPaths] };
    if (sshWriteEnabled === true) session.sshWriteEnabled = true;
    else delete session.sshWriteEnabled;
    session.lastTask = null;
  });
  return created.id;
}

test('local file URI spaces/percent and exact SSH folders resolve; wrong workspace and multi-root fail closed', t => {
  const root = fixtureRoot(t);
  const local = join(root, 'Project space % 100');
  mkdirSync(local, { recursive: true });
  const localResult = existingWindowProject(localWorkspaceIdentity(local), local);
  assert.equal(localResult.projectPath, resolve(local));
  assert.equal(localResult.workspaceKind, 'local');

  const remoteIdentity = sshWorkspaceIdentity();
  const remote = existingWindowProject(remoteIdentity, SSH_URI);
  assert.equal(remote.projectPath, SSH_URI);
  assert.equal(remote.workspaceKind, 'ssh');

  assert.throws(() => existingWindowProject(localWorkspaceIdentity(local), join(root, 'other')),
    { code: 'AGENT_WORKSPACE_MISMATCH' });
  assert.throws(() => existingWindowProject(remoteIdentity, 'vscode-remote://ssh-remote+other/srv/project'),
    { code: 'AGENT_WORKSPACE_MISMATCH' });
  assert.throws(() => existingWindowProject({ remoteAuthority: null, folderUri: null,
    workspace: { id: 'multi-root', folders: [] } }, local), { code: 'AGENT_WORKSPACE_UNRESOLVED' });
});

test('pure DOM probe accepts only a selected idle Agent with an empty draft', () => {
  const ready = fixtureDocument();
  assert.equal(ready.attachable, true);
  assert.equal(ready.draftLength, 0);

  const draft = fixtureDocument({ draftText: 'unsent user text' });
  assert.equal(draft.attachable, false);
  assert.equal(draft.reason, 'draft_not_empty_or_input_unknown');

  const busy = fixtureDocument({ status: 'generating', showSpinner: true });
  assert.equal(busy.attachable, false);
  assert.equal(busy.reason, 'agent_busy_or_unknown');

  const unselected = fixtureDocument({ selected: false });
  assert.equal(unselected.attachable, false);
  assert.equal(unselected.reason, 'durable_selected_agent_unconfirmed');
});

test('unknown existing SSH Agent attaches read-only without sending or creating a task', async t => {
  const { bridge, projectPath, attachmentFile } = makeSshFixture(t);
  const result = await attach(bridge, { workspacePath: projectPath });
  const session = readCursorSessionRegistry(bridge.sessionFile).sessions[result.sessionId];

  assert.match(result.sessionId, /^cursor-session-[0-9a-f-]{36}$/i);
  assert.equal(result.attached, true);
  assert.equal(result.callerBindingUpdated, true);
  assert.equal(result.messageSent, false);
  assert.equal(result.agentId, AGENT_A);
  assert.equal(result.origin, 'attached-existing');
  assert.equal(result.projectPath, SSH_URI);
  assert.equal(result.readOnly, true);
  assert.equal(session.scopeEnvelope.readOnly, true);
  assert.deepEqual(session.scopeEnvelope.allowedPaths, []);
  assert.equal(Object.hasOwn(session, 'sshWriteEnabled'), false);
  assert.equal(session.existingAgentTarget.agentId, AGENT_A);
  assert.equal(session.existingAgentTarget.targetId, TARGET_ID);
  assert.equal(session.existingAgentTarget.projectPath, SSH_URI);
  assert.equal(readCursorSessionRegistry(bridge.sessionFile).sessions[result.sessionId].agentId, AGENT_A);
  assert.equal(bridge.queue.length, 0);
  assert.equal(bridge.tasks.size, 0);
  assert.equal(bridge.ensureCursorCalls, 0);
  assert.ok(bridge.fixtureState.events.every(event => event.method === 'Runtime.evaluate'));
  assert.equal(getAgentAttachment(attachmentFile, 'caller-a').sessionId, result.sessionId);
});

test('repeat attach reuses the same session, and another caller gets an isolated mapping to that same Agent', async t => {
  const root = fixtureRoot(t);
  const first = makeSshFixture(t, { root, callerKey: 'caller-a' });
  const initial = await attach(first.bridge, { workspacePath: first.projectPath });
  const repeated = await attach(first.bridge, { workspacePath: first.projectPath });
  assert.equal(repeated.sessionId, initial.sessionId);
  assert.equal(repeated.reusedSession, true);
  assert.equal(Object.keys(readCursorSessionRegistry(first.bridge.sessionFile).sessions).length, 1);
  assert.equal(getAgentAttachment(first.attachmentFile, 'caller-a').revision, 2);

  const second = makeSshFixture(t, { root, callerKey: 'caller-b', attachmentFile: first.attachmentFile });
  const before = second.bridge.existingAgentController.get();
  assert.equal(before.found, false);
  const attachedBySecond = await attach(second.bridge, { workspacePath: second.projectPath });
  assert.equal(attachedBySecond.sessionId, initial.sessionId);
  assert.equal(attachedBySecond.reusedSession, true);
  assert.equal(getAgentAttachment(first.attachmentFile, 'caller-a').sessionId, initial.sessionId);
  assert.equal(getAgentAttachment(first.attachmentFile, 'caller-b').sessionId, initial.sessionId);
  assert.equal(Object.keys(readCursorSessionRegistry(first.bridge.sessionFile).sessions).length, 1);
  assert.equal(first.bridge.ensureCursorCalls + second.bridge.ensureCursorCalls, 0);
});

test('busy, draft, selected-ID changes, and ambiguous windows refuse attachment without new records', async t => {
  for (const snapshot of [fixtureDocument({ status: 'generating', showSpinner: true }),
    fixtureDocument({ draftText: 'unfinished draft' })]) {
    const { bridge, projectPath } = makeSshFixture(t, { snapshot });
    await assert.rejects(attach(bridge, { workspacePath: projectPath }), { code: 'AGENT_NOT_ATTACHABLE' });
    assert.equal(Object.keys(readCursorSessionRegistry(bridge.sessionFile).sessions).length, 0);
    assert.equal(getAgentAttachment(bridge.attachmentFile, 'caller-a'), null);
  }

  const { bridge: changed, projectPath } = makeSshFixture(t, {
    snapshots: [fixtureDocument({ agentId: AGENT_A }), fixtureDocument({ agentId: AGENT_B })],
  });
  await assert.rejects(attach(changed, { workspacePath: projectPath, expectedAgentId: AGENT_A }), {
    code: 'AGENT_SELECTION_CHANGED',
  });
  assert.equal(Object.keys(readCursorSessionRegistry(changed.sessionFile).sessions).length, 0);
  assert.equal(getAgentAttachment(changed.attachmentFile, 'caller-a'), null);

  const multiple = makeSshFixture(t, { pages: [
    { id: 'window-a', type: 'page', webSocketDebuggerUrl: 'ws://fixture/a' },
    { id: 'window-b', type: 'page', webSocketDebuggerUrl: 'ws://fixture/b' },
  ] });
  await assert.rejects(attach(multiple.bridge), { code: 'AGENT_WINDOW_AMBIGUOUS' });
  assert.equal(Object.keys(readCursorSessionRegistry(multiple.bridge.sessionFile).sessions).length, 0);
  assert.equal(getAgentAttachment(multiple.attachmentFile, 'caller-a'), null);

  const alreadyBusy = makeSshFixture(t);
  const busySessionId = seedSession(alreadyBusy.bridge, { readOnly: true, state: 'busy' });
  const beforeIds = Object.keys(readCursorSessionRegistry(alreadyBusy.bridge.sessionFile).sessions);
  await assert.rejects(attach(alreadyBusy.bridge, { workspacePath: alreadyBusy.projectPath }), {
    code: 'AGENT_ALREADY_BUSY',
  });
  assert.deepEqual(Object.keys(readCursorSessionRegistry(alreadyBusy.bridge.sessionFile).sessions), beforeIds);
  assert.equal(readCursorSessionRegistry(alreadyBusy.bridge.sessionFile).sessions[busySessionId].state, 'busy');
  assert.equal(getAgentAttachment(alreadyBusy.attachmentFile, 'caller-a'), null);
});

test('registered read-only policy is unchanged and cannot be elevated through attachment', async t => {
  const { bridge, projectPath } = makeSshFixture(t);
  const sessionId = seedSession(bridge, { readOnly: true });
  const before = sessionPolicy(readCursorSessionRegistry(bridge.sessionFile).sessions[sessionId]);
  const attached = await attach(bridge, { workspacePath: projectPath });
  assert.equal(attached.sessionId, sessionId);
  assert.equal(attached.reusedSession, true);

  await assert.rejects(bridge.existingAgentController.send('Attempt a write', {
    requestId: 'readonly-must-not-elevate', readOnly: false,
  }), { code: 'SESSION_SCOPE_EXPANSION' });
  const after = sessionPolicy(readCursorSessionRegistry(bridge.sessionFile).sessions[sessionId]);
  assert.deepEqual(after, before);
  assert.equal(bridge.queue.length, 0);
  assert.equal(bridge.ensureCursorCalls, 0);
});

test('registered write policy is preserved and send queues the exact attached Agent/target only', async t => {
  const { bridge, projectPath } = makeSshFixture(t);
  const sessionId = seedSession(bridge, { readOnly: false, allowedPaths: [], sshWriteEnabled: true });
  const before = sessionPolicy(readCursorSessionRegistry(bridge.sessionFile).sessions[sessionId]);
  const modelBefore = JSON.stringify(bridge.modelPreferencesView());
  const attached = await attach(bridge, { workspacePath: projectPath });
  assert.equal(attached.sessionId, sessionId);
  assert.equal(attached.reusedSession, true);

  const receipt = await bridge.existingAgentController.send('Queue a bounded fixture turn', {
    requestId: 'known-write-agent-turn', readOnly: false, background: true,
  });
  const job = bridge.tasks.get(receipt.taskId);
  assert.ok(job);
  assert.equal(job.sessionId, sessionId);
  assert.equal(job.agentId, AGENT_A);
  assert.equal(job.readOnly, false);
  assert.equal(job.modelPreference, null);
  assert.deepEqual({ agentId: job.existingAgentTarget.agentId, targetId: job.existingAgentTarget.targetId,
    projectPath: job.existingAgentTarget.projectPath }, { agentId: AGENT_A, targetId: TARGET_ID, projectPath: SSH_URI });
  assert.equal(bridge.queue.length, 1);
  assert.equal(bridge.ensureCursorCalls, 0);
  assert.equal(JSON.stringify(bridge.modelPreferencesView()), modelBefore);
  assert.deepEqual(sessionPolicy(readCursorSessionRegistry(bridge.sessionFile).sessions[sessionId]), before);
  assert.ok(bridge.fixtureState.events.every(event => event.method === 'Runtime.evaluate'));
});

test('a changed workspace identity blocks send after attachment', async t => {
  const { bridge, projectPath } = makeLocalFixture(t);
  const attached = await attach(bridge, { workspacePath: projectPath });
  assert.equal(attached.attached, true);
  const savedBinding = bridge.existingAgentController.get().binding;
  bridge.fixtureState.identity = localWorkspaceIdentity(join(bridge.adapterStartCwd, 'other-project'));
  await assert.rejects(bridge.existingAgentController.send('Must not be queued', {
    requestId: 'changed-window-identity', readOnly: true,
  }), { code: 'AGENT_WORKSPACE_MISMATCH' });
  assert.deepEqual(bridge.existingAgentController.get().binding, savedBinding);
  assert.equal(bridge.queue.length, 0);
  assert.equal(bridge.ensureCursorCalls, 0);
});
