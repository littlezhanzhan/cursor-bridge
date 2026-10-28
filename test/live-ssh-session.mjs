#!/usr/bin/env node
// Explicit opt-in live model calls; never included in node --test test/*.test.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseSshWorkspace } from '../remote-workspace.mjs';

const { values } = parseArgs({ options: {
  uri: { type: 'string' }, file: { type: 'string' }, 'state-dir': { type: 'string' },
  'confirm-live': { type: 'boolean', default: false },
} });
if (!values['confirm-live'] || !values.uri || !/^[A-Za-z0-9_.-]+\.py$/.test(values.file || '')) {
  throw new Error('Usage: node test/live-ssh-session.mjs --confirm-live --uri vscode-remote://ssh-remote+alias/absolute/path --file example.py [--state-dir PATH]. This submits two read-only requests using your signed-in Cursor account.');
}
const workspace = parseSshWorkspace(values.uri);
const state = resolve(values['state-dir'] || `.artifacts/ssh-live-${Date.now()}`);
mkdirSync(state, { recursive: true });
const env = { ...process.env, CURSOR_BRIDGE_NO_AUTOLAUNCH: '1',
  CURSOR_BRIDGE_WORKSPACE_FILE: join(state, 'workspaces.json'),
  CURSOR_BRIDGE_SESSION_FILE: join(state, 'sessions.json'),
  CURSOR_BRIDGE_MODEL_PREFERENCES_FILE: join(state, 'models.json'),
  CURSOR_BRIDGE_RUNTIME_FILE: join(state, 'runtime.json'),
  CURSOR_BRIDGE_LIFECYCLE_DIR: join(state, 'lifecycle') };
delete env.CODEX_THREAD_ID;
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('dist/cursor-bridge.mjs')], cwd: process.cwd(), env, stderr: 'pipe' });
let diagnostic = '';
transport.stderr?.on('data', data => { diagnostic += data; });
const client = new Client({ name: 'cursor-bridge-ssh-live', version: '1.0.0' });
const report = { result: 'FAIL', workspace: workspace.uri, stateDirectory: state, turns: [] };
function json(result) {
  const text = result.content?.find(item => item.type === 'text')?.text || '';
  if (result.isError) throw new Error(text);
  return result.structuredContent || JSON.parse(text);
}
const provenance = { sender: 'model', source: 'mixed' };
async function call(name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
}
async function turn(prompt, requestId, sessionId) {
  const receipt = json(await call('cursor_ssh_session', {
    prompt, request_id: requestId, ...(sessionId ? { session_id: sessionId } : {}),
    workspace_uri: workspace.uri, request_context: provenance, timeout_ms: 300000,
  }));
  const taskId = receipt.taskId;
  assert.ok(taskId, 'A live turn must return a task receipt');
  console.log(JSON.stringify({ phase: 'submitted', taskId, sessionId: receipt.sessionId }));
  const deadline = Date.now() + 330000;
  let status;
  let previous = '';
  while (Date.now() < deadline) {
    status = json(await call('cursor_status', { task_id: taskId }));
    const key = `${status.status}:${status.phase}:${status.agentId || ''}`;
    if (key !== previous) console.log(JSON.stringify({ phase: 'status', taskId, status: status.status, taskPhase: status.phase, agentId: status.agentId, error: status.error }));
    previous = key;
    if (status.status === 'completed') break;
    if (['failed', 'cancelled', 'needs_attention'].includes(status.status)) throw new Error(`Live task stopped: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.equal(status?.status, 'completed', 'Live turn timed out; inspect its exact Agent before retrying');
  const result = await call('cursor_status', { task_id: taskId, detail: 'result' });
  if (result.isError) throw new Error(JSON.stringify(result));
  const reply = result.content.find(item => item.type === 'text')?.text || '';
  assert.ok(reply.trim());
  const outcome = { taskId, sessionId: receipt.sessionId, agentId: status.agentId, reply };
  report.turns.push(outcome);
  writeFileSync(join(state, 'live-report.json'), JSON.stringify(report, null, 2));
  return outcome;
}
try {
  await client.connect(transport);
  report.init = json(await call('cursor_ssh_init', { uri: workspace.uri }));
  assert.equal(report.init.ready, true);
  console.log(JSON.stringify({ phase: 'initialized', targetId: report.init.targetId, workspace: workspace.uri }));
  const nonce = `BRIDGE_SSH_${randomUUID().replaceAll('-', '')}`;
  const first = await turn(`用户授权的工作区是 ${workspace.remotePath}（${workspace.authority}）。这是一个专用只读协作会话：不要修改、创建、删除任何文件，不运行改变状态的命令，也不要输出凭据或环境变量。只检查 ${values.file} 是否存在；若存在，返回总行数和第一个顶层 def 或 class 的名称与行号（无需输出代码正文）；若不存在，直接报告不存在，不读取其他文件。返回当前工作区根路径。请在会话上下文记住本次标识 ${nonce}，不要写入文件，并在回答末尾原样返回标识。`, `first-${randomUUID()}`);
  assert.ok(first.reply.includes(nonce), 'First reply must include the live validation token');
  const second = await turn('继续刚才的专用只读会话，不要修改或创建文件。请仅返回上一轮要求记住的验证标识、上一轮工作区根路径，以及上一轮检查的文件名。不要重新询问标识，不要输出凭据。', `second-${randomUUID()}`, first.sessionId);
  assert.equal(second.sessionId, first.sessionId);
  assert.ok(first.agentId && first.agentId === second.agentId, 'Both turns must use the same exact Agent');
  assert.ok(second.reply.includes(nonce), 'Continuation must recall a token not supplied in the second request');
  report.result = 'PASS';
  console.log(JSON.stringify({ phase: 'verified', result: report.result, agentId: first.agentId, sessionId: first.sessionId, turns: report.turns.length }));
} catch (error) {
  report.error = error.message;
  console.error(JSON.stringify({ result: 'FAIL', error: error.message }));
  process.exitCode = 1;
} finally {
  writeFileSync(join(state, 'live-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(state, 'mcp.stderr.log'), diagnostic);
  await client.close();
}
