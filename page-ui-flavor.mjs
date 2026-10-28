/**
 * Classify Cursor's UI surface using only visible, structural evidence.
 * Keep this function self-contained: the CDP page probe serializes its source
 * into the renderer with Function#toString.
 */
export function classifyCursorUiFlavor(document, { adapterKind = 'none' } = {}) {
  const isVisible = node => !!(node && (
    node.offsetParent !== null
    || (typeof node.getClientRects === 'function' && node.getClientRects().length > 0)
  ));
  const visibleCount = selector => {
    if (!document || typeof document.querySelectorAll !== 'function') return 0;
    try {
      return [...document.querySelectorAll(selector)].filter(isVisible).length;
    } catch {
      return 0;
    }
  };

  const nativeAdapterKind = typeof adapterKind === 'string' && adapterKind.trim()
    ? adapterKind.trim().toLowerCase()
    : 'none';
  const visibleV2SidebarCount = visibleCount('.glass-sidebar-agent-list-container');
  const visibleLegacyInputCount = visibleCount('.aislash-editor-input');
  const visibleLegacyHistoryCount = visibleCount(
    '.compact-agent-history-react-menu-label,.compact-agent-history-react-menu-content',
  );
  const visibleModernInputCount = visibleCount(
    '[contenteditable="true"].ui-prompt-input-editor__input,.tiptap.ProseMirror[contenteditable="true"]',
  );

  const adapterIsV2 = nativeAdapterKind === 'agents_v2';
  const adapterIsLegacy = ['legacy', 'unified', 'unified_history'].includes(nativeAdapterKind);
  const hasV2Evidence = visibleV2SidebarCount > 0 || adapterIsV2;
  const hasClassicEvidence = visibleLegacyInputCount > 0
    || visibleLegacyHistoryCount > 0
    || adapterIsLegacy;
  const conflict = hasV2Evidence && hasClassicEvidence;

  let uiFlavor = 'unknown';
  let agentAdapterKind = 'none';
  if (!conflict && hasV2Evidence) {
    uiFlavor = 'agents_v2';
    agentAdapterKind = 'agents_v2';
  } else if (!conflict && hasClassicEvidence) {
    uiFlavor = 'legacy';
    agentAdapterKind = 'legacy';
  }

  return {
    uiFlavor,
    agentAdapterKind,
    uiEvidence: {
      adapterKind: nativeAdapterKind,
      visibleV2SidebarCount,
      visibleLegacyInputCount,
      visibleLegacyHistoryCount,
      visibleModernInputCount,
      hasV2Evidence,
      hasClassicEvidence,
      conflict,
    },
  };
}
