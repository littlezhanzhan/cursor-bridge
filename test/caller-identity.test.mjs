import test from 'node:test';
import assert from 'node:assert/strict';
import { CallerBridgePool, resolveCallerIdentity } from '../caller-identity.mjs';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
test('MCP thread identity overrides startup env, and cwd never identifies a conversation', () => {
  assert.equal(resolveCallerIdentity({ meta: { threadId: b }, env: { CODEX_THREAD_ID: a }, instanceId: 'x' }).key, `codex-thread:${b}`);
  assert.equal(resolveCallerIdentity({ env: { CODEX_THREAD_ID: a }, instanceId: 'x' }).source, 'environment');
  const first = resolveCallerIdentity({ env: { PWD: '/same/project' }, instanceId: 'x' });
  const other = resolveCallerIdentity({ env: { PWD: '/same/project' }, instanceId: 'y' });
  assert.notEqual(first.key, other.key);
  assert.equal(first.persistent, false);
  assert.throws(() => resolveCallerIdentity({ meta: { threadId: '../shared' }, env: {}, instanceId: 'x' }), { code: 'CALLER_IDENTITY_INVALID' });
  for (const threadId of ['', null, 0]) assert.throws(() => resolveCallerIdentity({ meta: { threadId }, env: {}, instanceId: 'x' }), { code: 'CALLER_IDENTITY_INVALID' });
});
test('one MCP transport keeps different caller tasks separate and resumes only the same caller', () => {
  const fallback = { callerIdentity: resolveCallerIdentity({ env: {}, instanceId: 'fallback' }), sessionInstanceId: 'fallback', tasks: new Map() };
  const pool = new CallerBridgePool(fallback, identity => ({ callerIdentity: identity, tasks: new Map() }), { env: {} });
  const request = id => ({ params: { _meta: { threadId: id } } });
  const first = pool.forRequest(request(a));
  first.tasks.set('task-a', 'reply-a');
  const second = pool.forRequest(request(b));
  assert.notEqual(first, second);
  assert.equal(second.tasks.has('task-a'), false);
  assert.equal(pool.forRequest(request(a)), first);
  assert.equal(pool.forRequest({ params: {} }), fallback);
});
