import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPR_HISTORY_ENTRIES } from '../server.mjs';

test('a first-time empty classic history exposes its adapter without an existing row label', () => {
  const content = { offsetParent: {}, parentElement: null,
    __reactProps$test: { entries: [], onOpenEntry() {} } };
  const document = { querySelectorAll: selector => selector === '.compact-agent-history-react-menu-content' ? [content] : [] };
  const snapshot = JSON.parse(Function('document', `return ${EXPR_HISTORY_ENTRIES}`)(document));
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.entries, []);
});

test('a hidden empty history is not adopted as a usable adapter', () => {
  const content = { offsetParent: null, parentElement: null,
    __reactProps$test: { entries: [], onOpenEntry() {} } };
  const document = { querySelectorAll: selector => selector === '.compact-agent-history-react-menu-content' ? [content] : [] };
  const snapshot = JSON.parse(Function('document', `return ${EXPR_HISTORY_ENTRIES}`)(document));
  assert.equal(snapshot.ok, false);
});
