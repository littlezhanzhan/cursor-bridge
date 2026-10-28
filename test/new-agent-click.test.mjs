import test from 'node:test';
import assert from 'node:assert/strict';
import { CursorBridge, EXPR_FIND_NEWAGENT } from '../server.mjs';

const bridge = () => new CursorBridge({ workspaceFile: null, sessionFile: null, runtimeFile: null, modelPreferencesFile: null });
function client(targets) {
  const inputs = [], reads = [];
  return { inputs, reads, async send(method, params) {
    if (method === 'Runtime.evaluate') {
      assert.equal(params.expression, EXPR_FIND_NEWAGENT);
      const target = targets[Math.min(reads.length, targets.length - 1)];
      reads.push(target);
      return { result: { value: JSON.stringify(target) } };
    }
    inputs.push({ method, params });
    return {};
  } };
}

test('a transient menu is dismissed once and a fresh hit-tested target authorizes the click', async () => {
  const c = client([{ state: 'blocked_by_menu' }, { state: 'ready', x: 51, y: 72 }]);
  assert.equal(await bridge()._clickNewAgent(c, false), true);
  assert.equal(c.reads.length, 2);
  assert.deepEqual(c.inputs.map(i => [i.method, i.params.type, i.params.key || null]), [
    ['Input.dispatchKeyEvent', 'keyDown', 'Escape'], ['Input.dispatchKeyEvent', 'keyUp', 'Escape'],
    ['Input.dispatchMouseEvent', 'mousePressed', null], ['Input.dispatchMouseEvent', 'mouseReleased', null],
  ]);
  assert.ok(c.inputs.slice(2).every(i => i.params.x === 51 && i.params.y === 72));
});

test('a remaining menu or ordinary blocker never permits a click or a second Escape', async () => {
  for (const state of ['blocked_by_menu', 'blocked', 'ambiguous', 'missing']) {
    const c = client([{ state }]);
    assert.equal(await bridge()._clickNewAgent(c, false), false);
    assert.ok(c.inputs.every(i => i.method !== 'Input.dispatchMouseEvent'));
    assert.equal(c.inputs.length, state === 'blocked_by_menu' ? 2 : 0);
  }
});
