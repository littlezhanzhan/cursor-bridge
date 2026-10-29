import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveNamedConnection, getNamedConnection } from '../named-connections.mjs';

const uri = 'vscode-remote://ssh-remote+fixture/srv/project';
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const parse = result => { assert.notEqual(result.isError, true, result.content?.[0]?.text); return result.structuredContent || JSON.parse(result.content[0].text); };
test('two MCP processes dispatch concurrently and return only each caller exact task result', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-mcp-concurrent-'));
  const files = { CURSOR_BRIDGE_WORKSPACE_FILE: join(root, 'workspaces.json'), CURSOR_BRIDGE_SESSION_FILE: join(root, 'sessions.json'),
    CURSOR_BRIDGE_CONNECTIONS_FILE: join(root, 'connections.json'), CURSOR_BRIDGE_CALLER_CONNECTIONS_FILE: join(root, 'caller.json'),
    CURSOR_BRIDGE_UI_LOCK_PATH: join(root, 'ui.lock'), CURSOR_BRIDGE_RUNTIME_FILE: join(root, 'runtime.json'),
    CURSOR_BRIDGE_MODEL_PREFERENCES_FILE: join(root, 'models.json'), CURSOR_TEST_UI_STATE: join(root, 'ui-state.json') };
  const old = saveNamedConnection(files.CURSOR_BRIDGE_CONNECTIONS_FILE, { name: 'project', uri,
    sessionId: 'cursor-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const http = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify([{ id: 'mock-window', type: 'page', title: 'fixture', url: 'file:///workbench.html' }])); });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(c => c.close())); await new Promise(r => http.close(r)); rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 2; i++) {
    const env = { ...process.env, ...files, CURSOR_BRIDGE_CDP_PORT: String(http.address().port), CURSOR_BRIDGE_NO_AUTOLAUNCH: '1' };
    delete env.CODEX_THREAD_ID;
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/concurrent-mcp-server.mjs', import.meta.url))], env, stderr: 'pipe' });
    const client = new Client({ name: `caller-${i}`, version: '1' });
    clients.push(client); await client.connect(transport);
  }
  const call = (index, name, args, caller = index) => clients[index].callTool({ name, arguments: args, _meta: { threadId: ids[caller] } }, undefined, { timeout: 20000 });
  const receipts = await Promise.all([0, 1].map(async i => parse(await call(i, 'cursor_connection_send', {
    name: 'project', prompt: `Read-only CASE=${i === 0 ? 'A' : 'B'}`, request_id: 'same-request-id', background: true }))));
  assert.notEqual(receipts[0].sessionId, receipts[1].sessionId);
  assert.notEqual(receipts[0].taskId, receipts[1].taskId);
  assert.ok(receipts.every(r => r.sessionScope === 'caller' && r.callerIdentity.source === 'mcp-threadId'));
  let statuses, overlapping = false;
  const deadline = Date.now() + 20000;
  do {
    statuses = await Promise.all(receipts.map(async (r, i) => parse(await call(i, 'cursor_status', { task_id: r.taskId }))));
    if (statuses.every(s => s.status === 'running' && s.phase === 'running' && s.sendState === 'sent' && s.agentId)) overlapping = true;
    assert.ok(statuses.every(s => !['failed', 'needs_attention', 'cancelled'].includes(s.status)), JSON.stringify(statuses));
    if (statuses.every(s => s.status === 'completed')) break;
    await new Promise(r => setTimeout(r, 100));
  } while (Date.now() < deadline);
  assert.equal(overlapping, true);
  assert.ok(statuses.every(s => s.status === 'completed'));
  assert.notEqual(statuses[0].agentId, statuses[1].agentId);
  for (let i = 0; i < 2; i++) {
    const result = await call(i, 'cursor_status', { task_id: receipts[i].taskId, detail: 'result' });
    assert.notEqual(result.isError, true);
    const answer = JSON.parse(result.content[0].text);
    assert.equal(answer.case, i === 0 ? 'A' : 'B');
    assert.equal(answer.agentId, statuses[i].agentId);
  }
  const foreign = parse(await call(0, 'cursor_status', { task_id: receipts[0].taskId }, 1));
  assert.equal(foreign.found, false, 'another caller on the same transport cannot receive this result');
  assert.deepEqual(getNamedConnection(files.CURSOR_BRIDGE_CONNECTIONS_FILE, 'project'), old);
  const bindings = JSON.parse(readFileSync(files.CURSOR_BRIDGE_WORKSPACE_FILE, 'utf8')).bindings;
  for (const id of ids) assert.equal(bindings[`codex-thread:${id}`].projectPath, uri, 'concurrent caller workspace saves must not lose another binding');
  const ui = JSON.parse(readFileSync(files.CURSOR_TEST_UI_STATE, 'utf8'));
  const ordered = ui.intervals.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i].start >= ordered[i - 1].end, 'UI critical sections must not overlap');
});
