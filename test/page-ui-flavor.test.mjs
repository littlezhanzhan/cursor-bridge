import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCursorUiFlavor } from '../page-ui-flavor.mjs';

function element(isVisible = true) {
  return {
    offsetParent: isVisible ? {} : null,
    getClientRects: () => isVisible ? [{}] : [],
  };
}

function documentWith(selectors = {}) {
  return {
    querySelectorAll(selector) {
      return selector.split(',').flatMap(part => selectors[part.trim()] || []);
    },
  };
}

function classify(selectors, adapterKind = 'none') {
  return classifyCursorUiFlavor(documentWith(selectors), { adapterKind });
}

test('classic legacy input is a positive classic UI signal', () => {
  const result = classify({ '.aislash-editor-input': [element()] });
  assert.equal(result.uiFlavor, 'legacy');
  assert.equal(result.agentAdapterKind, 'legacy');
  assert.equal(result.uiEvidence.visibleLegacyInputCount, 1);
});

test('modern prompt input alone does not identify the UI flavor', () => {
  const result = classify({ '[contenteditable="true"].ui-prompt-input-editor__input': [element()] });
  assert.equal(result.uiFlavor, 'unknown');
  assert.equal(result.agentAdapterKind, 'none');
  assert.equal(result.uiEvidence.visibleModernInputCount, 1);
});

test('modern prompt input with the unified history adapter is classified as classic', () => {
  const result = classify({ '[contenteditable="true"].ui-prompt-input-editor__input': [element()] }, 'unified_history');
  assert.equal(result.uiFlavor, 'legacy');
  assert.equal(result.agentAdapterKind, 'legacy');
  assert.equal(result.uiEvidence.adapterKind, 'unified_history');
});

test('tiptap prompt with legacy history is classified as classic', () => {
  const result = classify({
    '.tiptap.ProseMirror[contenteditable="true"]': [element()],
    '.compact-agent-history-react-menu-label': [element()],
  });
  assert.equal(result.uiFlavor, 'legacy');
  assert.equal(result.agentAdapterKind, 'legacy');
  assert.equal(result.uiEvidence.visibleModernInputCount, 1);
  assert.equal(result.uiEvidence.visibleLegacyHistoryCount, 1);
});

test('an empty legacy history content container is a classic UI signal', () => {
  const result = classify({ '.compact-agent-history-react-menu-content': [element()] });
  assert.equal(result.uiFlavor, 'legacy');
  assert.equal(result.agentAdapterKind, 'legacy');
  assert.equal(result.uiEvidence.visibleLegacyHistoryCount, 1);
});

test('a visible Agents v2 sidebar is a positive v2 signal', () => {
  const result = classify({
    '.glass-sidebar-agent-list-container': [element()],
    '[contenteditable="true"].ui-prompt-input-editor__input': [element()],
  });
  assert.equal(result.uiFlavor, 'agents_v2');
  assert.equal(result.agentAdapterKind, 'agents_v2');
  assert.equal(result.uiEvidence.visibleV2SidebarCount, 1);
});

test('hidden residual v2 DOM does not override visible classic evidence', () => {
  const result = classify({
    '.glass-sidebar-agent-list-container': [element(false)],
    '.aislash-editor-input': [element()],
  });
  assert.equal(result.uiFlavor, 'legacy');
  assert.equal(result.agentAdapterKind, 'legacy');
  assert.equal(result.uiEvidence.visibleV2SidebarCount, 0);
  assert.equal(result.uiEvidence.visibleLegacyInputCount, 1);
});

test('visible v2 and classic evidence conflict and fail closed as unknown', () => {
  const result = classify({
    '.glass-sidebar-agent-list-container': [element()],
    '.compact-agent-history-react-menu-content': [element()],
    '[contenteditable="true"].ui-prompt-input-editor__input': [element()],
  }, 'agents_v2');
  assert.equal(result.uiFlavor, 'unknown');
  assert.equal(result.agentAdapterKind, 'none');
  assert.equal(result.uiEvidence.conflict, true);
});

test('a classic adapter conflicts with a visible v2 sidebar rather than overriding it', () => {
  const result = classify({
    '.glass-sidebar-agent-list-container': [element()],
    '.tiptap.ProseMirror[contenteditable="true"]': [element()],
  }, 'legacy');
  assert.equal(result.uiFlavor, 'unknown');
  assert.equal(result.agentAdapterKind, 'none');
  assert.equal(result.uiEvidence.conflict, true);
});

test('classification reads only allowlisted DOM selectors and visibility signals', () => {
  const candidate = element();
  Object.defineProperty(candidate, 'innerText', { get() { throw new Error('chat text must not be read'); } });
  Object.defineProperty(candidate, 'textContent', { get() { throw new Error('chat text must not be read'); } });
  const doc = documentWith({ '.compact-agent-history-react-menu-label': [candidate] });
  Object.defineProperty(doc, 'title', { get() { throw new Error('window title must not be read'); } });
  const result = classifyCursorUiFlavor(doc);
  assert.equal(result.uiFlavor, 'legacy');
});
