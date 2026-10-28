/**
 * Build a small read-only adapter over Cursor 3.21's unified Agents sidebar.
 * This function is intentionally self-contained because the CDP caller embeds
 * createUnifiedHistoryAdapter.toString() into the renderer.
 */
export function createUnifiedHistoryAdapter(document) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SEED_SELECTOR = '.unified-agents-sidebar .ui-agent-status-dot';
  const COMPOSER_SELECTOR = '.composer-bar[data-composer-id]';

  function asId(value) {
    if (value && typeof value === 'object' && 'value' in value) value = value.value;
    if (typeof value !== 'string') return null;
    let raw = value;
    if (/^local:/i.test(raw)) raw = raw.slice(6);
    if (!UUID.test(raw)) return null;
    return raw.toLowerCase();
  }

  function serviceName(key) {
    try {
      if (typeof key === 'string') return key;
      if (typeof key === 'symbol') return key.description || '';
      if (typeof key?.id === 'string') return key.id;
      if (typeof key?.toString === 'function') {
        const name = key.toString();
        if (typeof name === 'string' && name !== '[object Object]') return name;
      }
    } catch {}
    return '';
  }

  function servicePairs(entries) {
    if (!entries) return [];
    try {
      if (Array.isArray(entries)) {
        return entries.filter(entry => Array.isArray(entry) && entry.length >= 2);
      }
      if (typeof entries[Symbol.iterator] === 'function') {
        const result = [];
        for (const entry of entries) {
          if (Array.isArray(entry) && entry.length >= 2) result.push(entry);
        }
        return result;
      }
      if (typeof entries === 'object') return Object.entries(entries);
    } catch {}
    return [];
  }

  function findService(instantiationService, id, predicate) {
    const seen = new Set();
    let current = instantiationService;
    for (let depth = 0; current && depth < 64 && !seen.has(current); depth++) {
      seen.add(current);
      const pairs = servicePairs(current._services?._entries);
      const matches = pairs.filter(([key]) => serviceName(key) === id);
      if (matches.length > 1) return null;
      if (matches.length === 1) {
        const value = matches[0][1];
        // Do not instantiate descriptors or call service getters from CDP.
        return predicate(value) ? value : null;
      }
      current = current._parent;
    }
    return null;
  }

  function isDataService(value) {
    return !!value && typeof value === 'object'
      && !!value.allComposersData && typeof value.allComposersData === 'object'
      && typeof value.whenInitialComposerDataLoaded === 'function';
  }

  function isViewsService(value, data) {
    return !!value && typeof value === 'object'
      && value.composerDataService === data
      && typeof value.getEditorGroupForComposer === 'function';
  }

  function isLayoutService(value) {
    return !!value && typeof value === 'object' && typeof value.openComposer === 'function';
  }

  function serviceBundle(scope) {
    if (!scope || typeof scope !== 'object' || !scope.instantiationService || !scope.workspaceContextService) return null;
    const data = findService(scope.instantiationService, 'composerDataService', isDataService);
    if (!data || data._workspaceContextService !== scope.workspaceContextService) return null;
    const views = findService(scope.instantiationService, 'composerViewsService', value => isViewsService(value, data));
    const layout = findService(scope.instantiationService, 'agentLayoutService', isLayoutService);
    if (!views || !layout) return null;
    return { data, views, layout, workspaceContextService: scope.workspaceContextService };
  }

  function addScope(value, scopes) {
    if (!value || typeof value !== 'object') return;
    const workspace = value.workspace;
    if (workspace && typeof workspace === 'object' && workspace.instantiationService && workspace.workspaceContextService) {
      scopes.push(workspace);
    }
    if (value.instantiationService && value.workspaceContextService) scopes.push(value);
  }

  function collectScopes() {
    if (!document || typeof document.querySelectorAll !== 'function') return [];
    let seeds;
    try {
      seeds = document.querySelectorAll(SEED_SELECTOR);
    } catch {
      return [];
    }
    const scopes = [];
    for (const seed of seeds || []) {
      let names = [];
      try {
        names = Object.getOwnPropertyNames(seed);
      } catch {}
      for (const name of names) {
        if (!name.startsWith('__reactFiber$')) continue;
        let fiber;
        try { fiber = seed[name]; } catch { continue; }
        const seenFibers = new Set();
        for (let depth = 0; fiber && depth < 128 && !seenFibers.has(fiber); depth++) {
          seenFibers.add(fiber);
          try { addScope(fiber.memoizedProps?.value, scopes); } catch {}
          let dependency;
          try { dependency = fiber.dependencies?.firstContext; } catch {}
          const seenDependencies = new Set();
          for (let index = 0; dependency && index < 64 && !seenDependencies.has(dependency); index++) {
            seenDependencies.add(dependency);
            try { addScope(dependency.memoizedValue, scopes); } catch {}
            dependency = dependency.next;
          }
          try { fiber = fiber.return; } catch { fiber = null; }
        }
      }
    }
    return scopes;
  }

  const bundles = [];
  for (const scope of collectScopes()) {
    const bundle = serviceBundle(scope);
    if (!bundle) continue;
    if (!bundles.some(existing => existing.data === bundle.data
        && existing.views === bundle.views && existing.layout === bundle.layout
        && existing.workspaceContextService === bundle.workspaceContextService)) {
      bundles.push(bundle);
    }
  }
  if (bundles.length !== 1) return null;

  const { data, views, layout } = bundles[0];

  function excluded(header) {
    try {
      return !!(header?.isEphemeral || header?.isSpec || header?.isBestOfNSubcomposer
        || header?.isSubagent || header?.subagentInfo || header?.subagentParentComposerId
        || header?.parentComposerId);
    } catch {
      return true;
    }
  }

  function headerRows() {
    let headers;
    try { headers = data.allComposersData.allComposers; } catch { return []; }
    if (!Array.isArray(headers)) return [];
    const rows = [];
    const counts = new Map();
    for (const header of headers) {
      if (!header || typeof header !== 'object') continue;
      let rawId;
      try {
        rawId = header.composerId && typeof header.composerId === 'object' && 'value' in header.composerId
          ? header.composerId.value
          : header.composerId;
      } catch {
        continue;
      }
      const normalizedId = asId(rawId);
      if (!normalizedId) continue;
      counts.set(normalizedId, (counts.get(normalizedId) || 0) + 1);
      rows.push({ header, rawId, normalizedId });
    }
    return rows.filter(row => counts.get(row.normalizedId) === 1 && !excluded(row.header));
  }

  function isVisible(element) {
    if (!element || element.isConnected === false) return false;
    try {
      if (typeof element.getClientRects === 'function') return element.getClientRects().length > 0;
      if ('offsetParent' in element) return element.offsetParent !== null;
    } catch {
      return false;
    }
    return true;
  }

  function visibleComposerInfo() {
    const ids = new Set();
    const states = new Map();
    let visibleCount = 0;
    let bars = [];
    try { bars = document.querySelectorAll(COMPOSER_SELECTOR); } catch {}
    for (const bar of bars || []) {
      if (!isVisible(bar)) continue;
      let rawId;
      let rawStatus;
      try {
        rawId = bar.dataset?.composerId ?? bar.getAttribute?.('data-composer-id');
        rawStatus = bar.dataset?.composerStatus ?? bar.getAttribute?.('data-composer-status');
      } catch { continue; }
      const id = asId(rawId);
      if (!id) continue;
      visibleCount++;
      ids.add(id);
      const values = states.get(id) || [];
      values.push(typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '');
      states.set(id, values);
    }
    const visibleSelectedId = visibleCount === 1 && ids.size === 1 ? [...ids][0] : null;
    let selectedId = visibleSelectedId;
    if (!selectedId) {
      try { selectedId = asId(data.selectedComposerId); } catch {}
    }
    if (!selectedId) {
      try {
        const values = data.allComposersData.selectedComposerIds;
        const candidates = Array.isArray(values)
          ? values
          : values && typeof values[Symbol.iterator] === 'function' ? [...values] : [];
        const unique = new Set(candidates.map(asId).filter(Boolean));
        if (unique.size === 1) selectedId = [...unique][0];
      } catch {}
    }
    return { selectedId, states };
  }

  function mapVisibleStatus(values) {
    if (!Array.isArray(values) || values.length !== 1 || !values[0]) return null;
    const status = values[0];
    if (status === 'generating') return { status, icon: 'loading', showSpinner: true };
    if (status === 'completed') return { status, icon: 'check-circled', showSpinner: false };
    if (status === 'cancelled') return { status, icon: 'circle-slash', showSpinner: false };
    if (status === 'error' || status === 'failed') return { status, icon: 'warning', showSpinner: false };
    return null;
  }

  function timestampOf(header, index) {
    let value;
    try { value = header.lastUpdatedAt ?? header.createdAt; } catch {}
    if (value && typeof value === 'object' && 'value' in value) value = value.value;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : index;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && value.trim() !== '') return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return index;
  }

  function entries() {
    const rows = headerRows();
    const visible = visibleComposerInfo();
    return rows.map(({ header, normalizedId }, index) => {
      let isDraft = false;
      try { isDraft = !!header.isDraft; } catch {}
      const status = isDraft ? null : mapVisibleStatus(visible.states.get(normalizedId));
      return {
        id: `local:${normalizedId}`,
        label: '',
        searchText: '',
        timestamp: timestampOf(header, index),
        isSelected: visible.selectedId === normalizedId,
        showSpinner: status?.showSpinner === true,
        icon: isDraft ? 'draft' : status?.icon || 'registered',
        status: isDraft ? 'draft' : status?.status ?? null,
        durable: !isDraft,
        statusRequiresSelection: !isDraft && !status,
      };
    });
  }

  async function open(id) {
    const normalizedId = asId(id);
    if (!normalizedId) return false;
    const matches = headerRows().filter(row => row.normalizedId === normalizedId);
    if (matches.length !== 1) return false;
    const rawId = matches[0].rawId;
    try {
      const targetGroup = views.getEditorGroupForComposer(rawId);
      await layout.openComposer({
        type: 'local',
        id: rawId,
        openInNewTab: true,
        transient: true,
        targetGroup,
      });
      return true;
    } catch {
      return false;
    }
  }

  return { kind: 'legacy', implementation: 'unified-services', entries, open };
}
