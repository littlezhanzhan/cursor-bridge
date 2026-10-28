import test from 'node:test';
import assert from 'node:assert/strict';
import { locateNewAgentTarget } from '../new-agent-target.mjs';

function makeNode({ tag = 'button', attrs = {}, classes = [], visible = true, disabled = false, rect } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    attrs: { ...attrs },
    classes: new Set(classes),
    parentElement: null,
    children: [],
    offsetParent: visible ? {} : null,
    disabled,
    innerText: attrs.text || '',
    textContent: attrs.text || '',
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
    getClientRects() { return visible ? [{}] : []; },
    getBoundingClientRect() { return rect || { left: 10, top: 20, width: 40, height: 20 }; },
    matches(selector) {
      return selector.split(',').some(part => {
        const value = part.trim();
        if (value === 'button') return this.tagName === 'BUTTON';
        if (value === '[role="button"]') return this.attrs.role === 'button';
        if (value === 'a.action-label') return this.tagName === 'A' && this.classes.has('action-label');
        if (value.startsWith('.')) return this.classes.has(value.slice(1));
        return false;
      });
    },
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (current.matches(selector)) return current;
      }
      return null;
    },
    contains(candidate) {
      for (let current = candidate; current; current = current.parentElement) {
        if (current === this) return true;
      }
      return false;
    },
    clickCount: 0,
    click() { this.clickCount++; },
  };
  return node;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function page(nodes, hitTest = () => null, { hasHitTest = true } = {}) {
  const document = {
    querySelectorAll(selector) {
      if (selector === 'button,[role="button"],a.action-label,.codicon') return nodes;
      return [];
    },
  };
  if (hasHitTest) document.elementFromPoint = hitTest;
  return document;
}

test('returns the center of a candidate hit by elementFromPoint', () => {
  const button = makeNode({ attrs: { 'aria-label': 'New Agent (Ctrl+N)\r\n[Alt] Replace Agent' } });
  const result = locateNewAgentTarget(page([button], (x, y) => {
    assert.equal(x, 30);
    assert.equal(y, 30);
    return button;
  }));
  assert.deepEqual(result, { state: 'ready', x: 30, y: 30 });
  assert.equal(button.clickCount, 0);
});

test('accepts an actual hit on a descendant of the candidate control', () => {
  const button = makeNode({ attrs: { title: 'New Chat' } });
  const icon = append(button, makeNode({ tag: 'span', classes: ['codicon'] }));
  const result = locateNewAgentTarget(page([button, icon], () => icon));
  assert.deepEqual(result, { state: 'ready', x: 30, y: 30 });
  assert.equal(button.clickCount, 0);
});

test('a unique candidate covered by a menu surface requests menu dismissal without clicking through', () => {
  const button = makeNode({ attrs: { 'aria-label': 'New Agent (Ctrl+N)' } });
  const popup = makeNode({ attrs: { 'data-component': 'menu-popup' }, rect: { left: 0, top: 0, width: 100, height: 100 } });
  const popupChild = append(popup, makeNode({ tag: 'div' }));
  const result = locateNewAgentTarget(page([button], () => popupChild));
  assert.deepEqual(result, { state: 'blocked_by_menu' });
  assert.equal(button.clickCount, 0);
});

test('a menu backdrop descendant is classified as menu-blocked', () => {
  const button = makeNode({ attrs: { 'aria-label': 'New Chat' } });
  const backdrop = makeNode({ attrs: { 'data-component': 'menu-backdrop' } });
  const backdropChild = append(backdrop, makeNode({ tag: 'div' }));
  assert.deepEqual(locateNewAgentTarget(page([button], () => backdropChild)), { state: 'blocked_by_menu' });
});

test('ordinary modal occlusion is blocked and is not treated as a dismissible menu', () => {
  const button = makeNode({ attrs: { 'aria-label': 'New Agent' } });
  const modal = makeNode({ attrs: { role: 'dialog' } });
  assert.deepEqual(locateNewAgentTarget(page([button], () => modal)), { state: 'blocked' });
});

test('hidden and disabled controls are not candidates', () => {
  const hidden = makeNode({ attrs: { 'aria-label': 'New Agent' }, visible: false });
  const disabled = makeNode({ attrs: { 'aria-label': 'New Chat', 'aria-disabled': 'true' } });
  const nativeDisabled = makeNode({ attrs: { title: 'New Agent' }, disabled: true });
  assert.deepEqual(locateNewAgentTarget(page([hidden, disabled, nativeDisabled], () => hidden)), { state: 'missing' });
});

test('multiple independently hit-testable new controls are ambiguous', () => {
  const first = makeNode({ attrs: { 'aria-label': 'New Agent' }, rect: { left: 0, top: 0, width: 20, height: 20 } });
  const second = makeNode({ attrs: { 'aria-label': 'New Chat' }, rect: { left: 30, top: 0, width: 20, height: 20 } });
  assert.deepEqual(locateNewAgentTarget(page([first, second], (x) => x < 20 ? first : second)), { state: 'ambiguous' });
});

test('menu-agent and transcript/markdown body controls are excluded', () => {
  const menuAgent = makeNode({ attrs: { 'aria-label': 'New Agent' }, classes: ['glass-sidebar-agent-menu-btn'] });
  const markdown = makeNode({ classes: ['markdown-root'] });
  const inMarkdown = append(markdown, makeNode({ attrs: { 'aria-label': 'New Chat' } }));
  const transcript = makeNode({ classes: ['composer-react-transcript-root'] });
  const inTranscript = append(transcript, makeNode({ attrs: { title: 'New Agent' } }));
  assert.deepEqual(locateNewAgentTarget(page([menuAgent, inMarkdown, inTranscript], () => menuAgent)), { state: 'missing' });
});

test('missing elementFromPoint fails closed even with one visible candidate', () => {
  const button = makeNode({ attrs: { 'aria-label': 'New Agent' } });
  assert.deepEqual(locateNewAgentTarget(page([button], undefined, { hasHitTest: false })), {
    state: 'blocked', reason: 'hit_test_unavailable',
  });
  assert.equal(button.clickCount, 0);
});
