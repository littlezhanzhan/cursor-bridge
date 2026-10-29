import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CursorBridge, buildToolDefinitions } from '../server.mjs';
import { parseSshWorkspace } from '../remote-workspace.mjs';
import { EXPR_SSH_WINDOW_IDENTITY, inspectSshWindowIdentity } from '../ssh-window-identity.mjs';
import { readWorkspaceBinding } from '../workspace-binding.mjs';
import { readCursorSessionRegistry } from '../cursor-session-registry.mjs';

const uri = 'vscode-remote://ssh-remote+alpha/srv/project';
const otherHost = uri.replace('alpha', 'other-host');
const otherCase = uri.replace('project', 'Project');
const pageFor = (workspace = uri, id = 'ssh-target') => {
  const parsed = parseSshWorkspace(workspace);
  return { id, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1/${id}`,
    title: 'A deliberately untrusted title',
    identity: { remoteAuthority: parsed.authority, folderUri: {
      scheme: parsed.scheme, authority: parsed.authority, path: parsed.remotePath,
    }, workspace: null } };
};

class FixtureBridge extends CursorBridge {
  constructor(root, overrides = {}) {
    super({ workspaceFile: join(root, 'workspaces.json'), workspaceKey: 'default',
      sessionFile: join(root, 'sessions.json'), runtimeFile: null, runtimeMode: 'normal',
      modelPreferencesFile: null, delegationMode: 'on', ...overrides });
    this.pages = [pageFor()];
    this.probes = [];
  }
  async _listSshPages() { return this.pages; }
  async _inspectSshPage(page, workspace) {
    this.probes.push(page.id);
    return inspectSshWindowIdentity(page.identity, workspace);
  }
  _drain() {} // Observe admission and persistence without executing UI or model work.
}

function fixture(t, overrides) {
  const root = mkdtempSync(join(tmpdir(), 'cursor-ssh-collaboration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, bridge: new FixtureBridge(root, overrides) };
}

test('remote initialization persists only one verified exact window identity', async t => {
  const { bridge } = fixture(t);
  const result = await bridge.initializeSshWorkspace(uri);
  assert.equal(result.status, 'ssh-window-bound');
  assert.equal(result.targetId, 'ssh-target');
  assert.equal(result.projectPath, uri);
  assert.equal(result.readOnly, true);
  assert.equal(result.remoteConnectionState, 'not-independently-probed');
  assert.equal(readWorkspaceBinding(bridge.workspaceFile, 'default').projectPath, uri);
  assert.equal(bridge.tasks.size, 0);
});

test('missing, cross-host, wrong-case and duplicate windows cannot establish a binding', async t => {
  for (const pages of [[], [pageFor(otherHost)], [pageFor(otherCase)], [pageFor(uri, 'a'), pageFor(uri, 'b')]]) {
    const { bridge } = fixture(t);
    bridge.pages = pages;
    await assert.rejects(bridge.initializeSshWorkspace(uri), /SSH_WORKSPACE_(NOT_FOUND|AMBIGUOUS)/);
    assert.equal(existsSync(bridge.workspaceFile), false);
    assert.equal(bridge.tasks.size, 0);
  }
});

test('explicit target_id resolves duplicate windows without using their titles', async t => {
  const { bridge } = fixture(t);
  bridge.pages = [pageFor(uri, 'a'), pageFor(uri, 'b')];
  assert.equal((await bridge.initializeSshWorkspace(uri, { targetId: 'b' })).targetId, 'b');
  assert.deepEqual(bridge.probes, ['b']);
});

test('a first SSH turn creates a separate read-only persistent session and retries do not enqueue again', async t => {
  const { bridge } = fixture(t);
  await bridge.initializeSshWorkspace(uri);
  const receipt = await bridge.sshSessionTurn('Read the project entry points', { requestId: 'first-turn' });
  assert.ok(receipt.sessionId);
  assert.equal(bridge.queue.length, 1);
  const job = bridge.queue[0];
  assert.equal(job.newChat, true);
  assert.equal(job.readOnly, true);
  assert.equal(job.sessionMode, 'create');
  assert.equal(job.execution, 'parallel_agent');
  assert.equal(job.projectPath, uri);
  const saved = readCursorSessionRegistry(bridge.sessionFile).sessions[receipt.sessionId];
  assert.equal(saved.collaborationKind, 'ssh-read-only');
  assert.equal(saved.remoteWorkspace.authority, 'ssh-remote+alpha');
  assert.equal(saved.scopeEnvelope.readOnly, true);
  const duplicate = await bridge.sshSessionTurn('Read the project entry points', { requestId: 'first-turn' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sessionId, receipt.sessionId);
  assert.equal(bridge.queue.length, 1);
  const independent = await bridge.sshSessionTurn('Another task', { requestId: 'second-turn' });
  assert.notEqual(independent.sessionId, receipt.sessionId);
  assert.equal(bridge.queue.length, 2);
});

test('SSH entry points reject writes, isolated execution, missing request IDs and wrong workspace assertions', async t => {
  const { bridge } = fixture(t);
  await bridge.initializeSshWorkspace(uri);
  await assert.rejects(bridge.doTask('write', { sessionMode: 'create', execution: 'parallel_agent', requestId: 'write' }), /SSH_READ_ONLY_REQUIRED/);
  await assert.rejects(bridge.doTask('read', { readOnly: true }), /SSH_SESSION_REQUIRED/);
  await assert.rejects(bridge.sshSessionTurn('read'), /SSH_REQUEST_ID_REQUIRED/);
  await assert.rejects(bridge.sshSessionTurn('read', { requestId: 'wrong', workspacePath: otherHost }), /SSH_WORKSPACE_MISMATCH/);
  await assert.rejects(bridge.contextEngine('read'), /SSH_SESSION_REQUIRED/);
  assert.equal(bridge.queue.length, 0);
});

test('a collected completed SSH task permits a new independent session in the same pinned window', async t => {
  const { bridge } = fixture(t);
  await bridge.initializeSshWorkspace(uri);
  const first = await bridge.sshSessionTurn('Read first', { requestId: 'fresh-first' });
  const job = bridge.queue.shift();
  Object.assign(job, { status: 'completed', result: 'first result',
    agentId: 'local:11111111-1111-4111-8111-111111111111', terminalEvidence: 'fixture_completed' });
  bridge._settleSessionJob(job, 'completed');
  bridge._markTaskResultCollected(job);
  const second = await bridge.sshSessionTurn('Read independently', { requestId: 'fresh-second' });
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(bridge._lastLifecycle.targetId, 'ssh-target');
  assert.equal(bridge.queue.length, 1);
  assert.equal(bridge.queue[0].newChat, true);
  assert.equal(bridge.queue[0].sessionMode, 'create');
  const saved = readCursorSessionRegistry(bridge.sessionFile);
  assert.equal(saved.sessions[first.sessionId].agentId, job.agentId);
  assert.equal(saved.sessions[first.sessionId].state, 'ready');
  assert.equal(saved.sessions[second.sessionId].agentId, null);
});

test('a saved SSH binding requires verification again in each new adapter', async t => {
  const { bridge, root } = fixture(t);
  await bridge.initializeSshWorkspace(uri);
  const restarted = new FixtureBridge(root);
  assert.equal(restarted.projectPath, uri);
  assert.equal(restarted.workspaceConfirmationRequired, true);
  await assert.rejects(restarted.sshSessionTurn('read', { requestId: 'after-restart' }), /SSH_INITIALIZATION_REQUIRED/);
});

test('continued sessions cannot move to another host or case-different Linux path', async t => {
  for (const different of [otherHost, otherCase]) {
    const { bridge } = fixture(t);
    await bridge.initializeSshWorkspace(uri);
    const session = bridge._claimNewSession({ taskId: 'fixture', projectPath: uri, readOnly: true,
      allowedPaths: [], requestId: 'created', timeoutMs: 30000 });
    assert.throws(() => bridge._claimExistingSession({ sessionId: session.id, taskId: 'different',
      projectPath: different, readOnly: true, allowedPaths: [], requestId: 'continue', timeoutMs: 30000 }), /SESSION_WORKSPACE_MISMATCH/);
  }
});

test('operation-time identity checking fails when the bound window changes host or path', async t => {
  const { bridge } = fixture(t);
  await bridge.initializeSshWorkspace(uri);
  const client = { send: async () => ({ result: { value: JSON.stringify(pageFor(otherHost).identity) } }) };
  await assert.rejects(bridge._verifySshWorkspace(client, { projectPath: uri }, 'before_send'), /SSH_WORKSPACE_MISMATCH/);
  client.send = async () => ({ result: { value: JSON.stringify(pageFor(uri).identity) } });
  assert.equal((await bridge._verifySshWorkspace(client, { projectPath: uri }, 'before_send')).ok, true);
});

test('the pinned CDP target is not silently replaced after a window closes', async t => {
  const { bridge } = fixture(t);
  await bridge.initializeSshWorkspace(uri);
  bridge.pages = [pageFor(uri, 'replacement')];
  await assert.rejects(bridge._ensureSshWorkspace(), /SSH_TARGET_NOT_FOUND/);
  assert.equal(bridge._lastLifecycle.targetId, 'ssh-target');
});

test('a matching workspace cannot authorize prompt entry or reply extraction from another composer', async t => {
  const { bridge } = fixture(t);
  await bridge.initializeSshWorkspace(uri);
  const expected = 'local:11111111-1111-4111-8111-111111111111';
  let visible = 'local:22222222-2222-4222-8222-222222222222';
  const client = { send: async (_method, params) => ({ result: { value: JSON.stringify(
    params.expression === EXPR_SSH_WINDOW_IDENTITY ? pageFor(uri).identity : { ok: true, id: visible },
  ) } }) };
  for (const stage of ['before_fill', 'before_send', 'before_read_reply']) {
    await assert.rejects(bridge._verifySshWorkspace(client, { projectPath: uri, agentId: expected }, stage), /SSH_COMPOSER_MISMATCH/);
  }
  visible = expected;
  assert.equal((await bridge._verifySshWorkspace(client, { projectPath: uri, agentId: expected }, 'before_fill')).ok, true);
});

test('two adapters atomically deduplicate the same SSH creation request', async t => {
  const { bridge: first, root } = fixture(t);
  const second = new FixtureBridge(root);
  await Promise.all([first.initializeSshWorkspace(uri), second.initializeSshWorkspace(uri)]);
  const receipts = await Promise.all([
    first.sshSessionTurn('Read once', { requestId: 'raced-same' }),
    second.sshSessionTurn('Read once', { requestId: 'raced-same' }),
  ]);
  assert.equal(receipts[0].sessionId, receipts[1].sessionId);
  assert.equal(receipts.filter(receipt => receipt.duplicate).length, 1);
  assert.equal(first.queue.length + second.queue.length, 1);
  assert.equal(Object.keys(readCursorSessionRegistry(first.sessionFile).sessions).length, 1);
});

test('two coordinated adapters may submit separate read-only sessions to one SSH workspace', async t => {
  const { bridge: first, root } = fixture(t);
  const second = new FixtureBridge(root);
  await Promise.all([first.initializeSshWorkspace(uri), second.initializeSshWorkspace(uri)]);
  const results = await Promise.allSettled([
    first.sshSessionTurn('First', { requestId: 'raced-first' }),
    second.sshSessionTurn('Second', { requestId: 'raced-second' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.notEqual(results[0].value.sessionId, results[1].value.sessionId);
  assert.notEqual(results[0].value.taskId, results[1].value.taskId);
  assert.equal(first.queue.length + second.queue.length, 2);
});

test('legacy active senders and uncertain unbound sessions still block unsafe admission', async t => {
  for (const state of ['legacy', 'needs_attention']) {
    const { bridge } = fixture(t);
    await bridge.initializeSshWorkspace(uri);
    const receipt = await bridge.sshSessionTurn('First', { requestId: `blocked-${state}` });
    const { updateCursorSessionRegistry } = await import('../cursor-session-registry.mjs');
    updateCursorSessionRegistry(bridge.sessionFile, registry => {
      const session = registry.sessions[receipt.sessionId];
      if (state === 'legacy') delete session.uiCoordinationVersion;
      else session.state = 'needs_attention';
    });
    await assert.rejects(bridge.sshSessionTurn('Must not send', { requestId: `next-${state}` }), /SSH_WORKSPACE_BUSY/);
    assert.equal(bridge.queue.length, 1);
  }
});

test('a repeated request ID never bypasses host identity checks', async t => {
  const { bridge } = fixture(t);
  const session = bridge._claimNewSession({ taskId: 'owned', projectPath: uri, readOnly: true,
    allowedPaths: [], requestId: 'same-id', timeoutMs: 30000 });
  assert.throws(() => bridge._claimExistingSession({ sessionId: session.id, taskId: 'wrong-host',
    projectPath: otherHost, readOnly: true, allowedPaths: [], requestId: 'same-id', timeoutMs: 30000 }), /SESSION_WORKSPACE_MISMATCH/);
});

test('MCP exposes dedicated SSH initialization and session tools without accepting write flags', t => {
  const { bridge } = fixture(t);
  const tools = new Map(buildToolDefinitions(bridge).map(tool => [tool.name, tool]));
  assert.ok(tools.has('cursor_ssh_init'));
  const session = tools.get('cursor_ssh_session').inputSchema;
  assert.deepEqual(session.required, ['prompt', 'request_id']);
  assert.equal(session.additionalProperties, false);
  assert.equal(session.properties.read_only, undefined);
  assert.equal(session.properties.allowed_paths, undefined);
});
