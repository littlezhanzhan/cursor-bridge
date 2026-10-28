import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { EXPR_SSH_WINDOW_IDENTITY } from '../ssh-window-identity.mjs';

test('wrong remote identity blocks real continue, collect and stop paths before any UI action', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cursor-ssh-operation-'));
  const evaluated = [];
  const inputs = [];
  let port;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ id: 'pinned-ssh-page', type: 'page',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` }]));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.on('message', message => {
    const request = JSON.parse(message.toString());
    if (request.method === 'Runtime.evaluate') {
      evaluated.push(request.params.expression);
      socket.send(JSON.stringify({ id: request.id, result: { result: { value: JSON.stringify({
        remoteAuthority: 'ssh-remote+other-host', workspace: null,
        folderUri: { scheme: 'vscode-remote', authority: 'ssh-remote+other-host', path: '/srv/project' },
      }) } } }));
    } else {
      inputs.push(request.method);
      socket.send(JSON.stringify({ id: request.id, result: {} }));
    }
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
  process.env.CURSOR_BRIDGE_CDP_PORT = String(port);
  process.env.CURSOR_BRIDGE_NO_AUTOLAUNCH = '1';
  process.env.CURSOR_BRIDGE_WORKSPACE_FILE = join(root, 'bindings.json');
  process.env.CURSOR_BRIDGE_RUNTIME_FILE = join(root, 'runtime.json');
  process.env.CURSOR_BRIDGE_MODEL_PREFERENCES_FILE = join(root, 'models.json');
  process.env.CURSOR_BRIDGE_SESSION_FILE = join(root, 'sessions.json');
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const { CursorBridge } = await import('../server.mjs');
  const uri = 'vscode-remote://ssh-remote+intended-host/srv/project';
  for (const operation of ['continue', 'collect', 'stop']) {
    evaluated.length = 0;
    inputs.length = 0;
    const bridge = new CursorBridge({ projectPath: uri, workspaceFile: null,
      sessionFile: null, runtimeFile: null, modelPreferencesFile: null, runtimeMode: 'normal' });
    bridge._lastLifecycle = { targetId: 'pinned-ssh-page', projectPath: uri };
    const job = { agentId: 'local:dedicated-agent', targetId: 'pinned-ssh-page',
      projectPath: uri, readOnly: true, prompt: 'Do not send this', sessionId: 'test-session' };
    const action = operation === 'continue' ? () => bridge._submitSessionTurn(job)
      : operation === 'collect' ? () => bridge._collectParallelAgent(job)
        : () => bridge._stopParallelAgent(job);
    await assert.rejects(action(), /SSH_WORKSPACE_MISMATCH/, operation);
    assert.ok(evaluated.length > 0, `${operation}: identity must actually be queried`);
    assert.ok(evaluated.every(expression => expression === EXPR_SSH_WINDOW_IDENTITY), `${operation}: no history, prompt or stop interaction may occur`);
    assert.deepEqual(inputs, [], `${operation}: no keyboard or mouse events may be dispatched`);
  }
});
