import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorBridge, EXPR_PAGE_CAPABILITIES, toolErrorResult } from '../server.mjs';
import { EXPR_SSH_WINDOW_IDENTITY } from '../ssh-window-identity.mjs';
import { parseSshWorkspace } from '../remote-workspace.mjs';

const workspace = parseSshWorkspace('vscode-remote://ssh-remote+test-host/srv/project');
const page = { id: 'exact-target', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/test' };
const identity = { remoteAuthority: workspace.authority,
  folderUri: { scheme: workspace.scheme, authority: workspace.authority, path: workspace.remotePath }, workspace: null };
const bridge = () => new CursorBridge({ workspaceFile: null, sessionFile: null, runtimeFile: null, modelPreferencesFile: null });

function client({ ready = Promise.resolve(), capabilities = JSON.stringify({ uiFlavor: 'legacy' }), failureAt } = {}) {
  const calls = [];
  let closed = false;
  return { calls, get closed() { return closed; }, ready,
    close() { closed = true; },
    async send(method, params) {
      calls.push(method);
      if (params.expression === failureAt) throw Object.assign(new Error('probe denied'), { code: 'EACCES' });
      return { result: { value: params.expression === EXPR_SSH_WINDOW_IDENTITY ? JSON.stringify(identity) : capabilities } };
    } };
}

test('SSH inspection preserves failed connection, identity and capability stages and closes the client', async () => {
  for (const stage of ['connect', 'identity', 'capabilities']) {
    const c = client(stage === 'connect'
      ? { ready: Promise.reject(Object.assign(new Error('connect denied'), { code: 'EACCES' })) }
      : { failureAt: stage === 'identity' ? EXPR_SSH_WINDOW_IDENTITY : EXPR_PAGE_CAPABILITIES });
    const result = await bridge()._inspectSshPage(page, workspace, { createClient: () => c });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'SSH_PAGE_PROBE_FAILED');
    assert.equal(result.stage, stage);
    assert.equal(result.identityVerified, stage === 'capabilities');
    assert.equal(result.probeError.code, 'EACCES');
    assert.equal(c.closed, true);
    assert.ok(c.calls.every(method => method === 'Runtime.evaluate'), 'inspection cannot dispatch input');
  }
});

test('malformed capability JSON and incomplete payloads are probe failures, not missing workspaces', async () => {
  for (const capabilities of ['{', '{}', 'null', '[]']) {
    const c = client({ capabilities });
    const result = await bridge()._inspectSshPage(page, workspace, { createClient: () => c });
    assert.equal(result.reason, 'SSH_PAGE_PROBE_FAILED');
    assert.equal(result.stage, 'capabilities');
    assert.equal(result.identityVerified, true);
    assert.equal(c.closed, true);
  }
});

test('a verified SSH identity with unknown UI is reported as a classification failure', async () => {
  const b = bridge();
  b._listSshPages = async () => [page];
  const c = client({ capabilities: JSON.stringify({ uiFlavor: 'unknown', agentAdapterKind: 'none', uiEvidence: [] }) });
  const probe = await b._inspectSshPage(page, workspace, { createClient: () => c });
  assert.equal(probe.identityVerified, true);
  b._inspectSshPage = async () => probe;
  await assert.rejects(b._findSshWorkspace(workspace), error => {
    assert.equal(error.code, 'SSH_CLASSIC_IDE_REQUIRED');
    assert.equal(error.sshDiagnostic.rejections[0].stage, 'ui-classification');
    assert.equal(error.sshDiagnostic.rejections[0].uiFlavor, 'unknown');
    assert.equal(error.confirmedNotSent, undefined, 'discovery cannot prove that a previously submitted task was not sent');
    assert.equal(error.sshDiagnostic.probeReadOnly, true);
    return true;
  });
});

test('SSH discovery returns structured per-target probe errors through MCP', async () => {
  const b = bridge();
  b._listSshPages = async () => [page];
  b._inspectSshPage = async () => { throw Object.assign(new Error('probe denied'), { code: 'EACCES' }); };
  await assert.rejects(b._findSshWorkspace(workspace), error => {
    assert.equal(error.code, 'SSH_PAGE_PROBE_FAILED');
    const tool = toolErrorResult(error);
    assert.equal(tool.isError, true);
    assert.deepEqual(JSON.parse(tool.content[0].text), tool.structuredContent);
    assert.equal(tool.structuredContent.confirmedNotSent, undefined);
    assert.equal(tool.structuredContent.sshDiagnostic.probeReadOnly, true);
    assert.deepEqual(tool.structuredContent.sshDiagnostic.rejections, [{ targetId: page.id,
      stage: 'page-inspection', reason: 'SSH_PAGE_PROBE_FAILED', probeError: { code: 'EACCES', message: 'probe denied' } }]);
    assert.equal(b.tasks.size, 0);
    return true;
  });
});

test('page enumeration failures and disappeared pinned targets are distinct and never select replacements', async () => {
  const b = bridge();
  b._listSshPages = async () => { throw Object.assign(new Error('port refused'), { code: 'ECONNREFUSED' }); };
  await assert.rejects(b._findSshWorkspace(workspace), error => error.code === 'SSH_PAGE_ENUMERATION_FAILED'
    && error.sshDiagnostic.stage === 'page-enumeration');
  b._listSshPages = async () => [{ ...page, id: 'replacement' }];
  b._inspectSshPage = async () => assert.fail('must not inspect a replacement target');
  await assert.rejects(b._findSshWorkspace(workspace, page.id), error => error.code === 'SSH_TARGET_NOT_FOUND'
    && error.sshDiagnostic.pageCount === 1 && error.sshDiagnostic.candidateCount === 0);
});

test('unreadable SSH identity is distinct from a confirmed different authority or case-sensitive path', async () => {
  const b = bridge();
  b._listSshPages = async () => [page];
  for (const reason of ['remote_authority_missing', 'identity_json_invalid', 'folder_uri_missing', 'workspace_roots_unresolved']) {
    b._inspectSshPage = async () => ({ ok: false, reason, stage: 'identity' });
    await assert.rejects(b._findSshWorkspace(workspace), { code: 'SSH_WINDOW_IDENTITY_UNAVAILABLE' });
  }
  for (const reason of ['remote_authority_mismatch', 'folder_uri_authority_mismatch', 'folder_uri_path_mismatch']) {
    b._inspectSshPage = async () => ({ ok: false, reason, stage: 'identity' });
    await assert.rejects(b._findSshWorkspace(workspace), { code: 'SSH_WORKSPACE_NOT_FOUND' });
  }
});
