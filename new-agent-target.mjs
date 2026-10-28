/**
 * Locate a visible New Agent/New Chat control and prove its center is the
 * renderer's actual hit target. This function is self-contained so the CDP
 * caller can embed its source in the page.
 */
export function locateNewAgentTarget(document) {
  const candidateSelector = 'button,[role="button"],a.action-label,.codicon';
  const clickableSelector = 'button,[role="button"],a.action-label';
  const excludedSelector = '.glass-sidebar-agent-menu-btn,.markdown-root,.composer-messages-container,.composer-react-transcript-root';
  const visible = node => !!(node && (
    node.offsetParent !== null
    || (typeof node.getClientRects === 'function' && node.getClientRects().length > 0)
  ));
  const matches = (node, selector) => {
    try { return !!(node && typeof node.matches === 'function' && node.matches(selector)); }
    catch { return false; }
  };
  const closest = (node, selector) => {
    for (let current = node, depth = 0; current && depth < 64; current = current.parentElement, depth++) {
      if (matches(current, selector)) return current;
    }
    return null;
  };
  const isDisabled = control => {
    if (control.disabled === true) return true;
    try {
      if (control.getAttribute?.('disabled') !== null) return true;
      return String(control.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true';
    } catch {
      return true;
    }
  };
  const hasNewActionLabel = control => {
    let values = [];
    try {
      values = [
        control.getAttribute?.('aria-label'),
        control.getAttribute?.('title'),
        control.innerText,
        control.textContent,
      ].filter(value => typeof value === 'string' && value.trim());
    } catch {
      return false;
    }
    return values.some(value => {
      const firstLine = value.replace(/\r/g, '').split('\n')[0].trim();
      return /^New\s+(?:Agent|Chat)(?:\b|\s|\(|$)/i.test(firstLine);
    });
  };
  const containsNode = (ancestor, node) => {
    for (let current = node, depth = 0; current && depth < 64; current = current.parentElement, depth++) {
      if (current === ancestor) return true;
    }
    return false;
  };
  const menuOverlayAt = node => {
    for (let current = node, depth = 0; current && depth < 64; current = current.parentElement, depth++) {
      try {
        const component = current.getAttribute?.('data-component');
        if (component === 'menu-backdrop' || component === 'menu-popup') return true;
      } catch {}
    }
    return false;
  };

  if (!document || typeof document.querySelectorAll !== 'function') return { state: 'missing' };
  let nodes;
  try { nodes = [...document.querySelectorAll(candidateSelector)]; }
  catch { return { state: 'missing' }; }

  const candidates = [];
  const seen = new Set();
  for (const node of nodes) {
    const control = matches(node, clickableSelector) ? node : closest(node, clickableSelector);
    if (!control || seen.has(control)) continue;
    seen.add(control);
    if (!visible(control) || isDisabled(control)) continue;
    if (closest(control, excludedSelector)) continue;
    if (!hasNewActionLabel(control)) continue;
    candidates.push(control);
  }
  if (!candidates.length) return { state: 'missing' };
  if (typeof document.elementFromPoint !== 'function') {
    return { state: 'blocked', reason: 'hit_test_unavailable' };
  }

  const ready = [];
  const blockers = [];
  for (const control of candidates) {
    let rect;
    let hit;
    try {
      rect = control.getBoundingClientRect();
      const left = Number(rect?.left ?? rect?.x);
      const top = Number(rect?.top ?? rect?.y);
      const width = Number(rect?.width);
      const height = Number(rect?.height);
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        blockers.push({ kind: 'blocked' });
        continue;
      }
      const x = Math.round(left + width / 2);
      const y = Math.round(top + height / 2);
      hit = document.elementFromPoint(x, y);
      if (containsNode(control, hit)) ready.push({ state: 'ready', x, y });
      else blockers.push({ kind: menuOverlayAt(hit) ? 'blocked_by_menu' : 'blocked' });
    } catch {
      blockers.push({ kind: 'blocked' });
    }
  }

  if (ready.length > 1) return { state: 'ambiguous' };
  if (ready.length === 1) return ready[0];
  if (candidates.length > 1) return { state: 'ambiguous' };
  if (blockers[0]?.kind === 'blocked_by_menu') return { state: 'blocked_by_menu' };
  return { state: 'blocked' };
}
