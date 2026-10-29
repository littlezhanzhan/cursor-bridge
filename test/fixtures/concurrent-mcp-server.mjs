// Local fixture only. Exercises the real MCP handler, caller pool, scheduler and locks.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CursorBridge, startMcpServer } from '../../server.mjs';

const stateFile = process.env.CURSOR_TEST_UI_STATE;
const uri = 'vscode-remote://ssh-remote+fixture/srv/project';
const state = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { agents: {}, intervals: [] }; throw e; } };
const save = value => writeFileSync(stateFile, JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function uiOperation(job, kind, operation) {
  const before = state();
  before.selected = job.agentId || job.provisionalAgentId;
  const selected = before.selected;
  const start = Date.now();
  save(before);
  await delay(45);
  const after = state();
  if (after.selected !== selected) throw new Error('MOCK_UI_INTERLEAVED');
  const result = operation(after);
  after.intervals.push({ pid: process.pid, kind, start, end: Date.now() });
  save(after);
  return result;
}
CursorBridge.prototype._listSshPages = async function () { return [{ id: 'mock-window' }]; };
CursorBridge.prototype._inspectSshPage = async function (_page, expected) { return { ok: expected.uri === uri }; };
CursorBridge.prototype._submitParallelAgent = async function (job) {
  const tag = /CASE=([AB])/.exec(job.prompt)?.[1];
  if (!tag) throw new Error('fixture case missing');
  job.targetId = 'mock-window';
  job.provisionalAgentId = `local:${randomUUID()}`;
  return uiOperation(job, 'submit', data => {
    data.agents[job.provisionalAgentId] = { tag, finishAt: Date.now() + 2500 };
    job.sendState = 'sent';
    job.sentAt = new Date().toISOString();
    return { agent: { id: job.provisionalAgentId } };
  });
};
CursorBridge.prototype._readParallelEntry = function (job) {
  return this._withUiLock(() => uiOperation(job, 'poll', data => {
    const agent = data.agents[job.agentId];
    return { id: job.agentId, icon: Date.now() >= agent.finishAt ? 'check-circled' : 'loading',
      showSpinner: Date.now() < agent.finishAt, durable: true };
  }));
};
CursorBridge.prototype._collectParallelAgent = function (job) {
  return uiOperation(job, 'collect', data => JSON.stringify({ case: data.agents[job.agentId].tag, agentId: job.agentId }));
};
await startMcpServer();
