import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createUnifiedHistoryAdapter } from '../unified-history-adapter.mjs';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_D = '44444444-4444-4444-8444-444444444444';
const UUID_E = '55555555-5555-4555-8555-555555555555';

function serviceId(name) {
  const id = function serviceIdentifier() {};
  Object.defineProperty(id, 'toString', { value: () => name });
  return id;
}

function header(composerId, overrides = {}) {
  return {
    composerId,
    name: 'private title must not be exposed',
    subtitle: 'private subtitle must not be exposed',
    createdAt: 100,
    lastUpdatedAt: 200,
    isDraft: false,
    isArchived: false,
    ...overrides,
  };
}

function visibleComposerBar(composerId, composerStatus, visible = true) {
  return {
    dataset: { composerId, ...(composerStatus === undefined ? {} : { composerStatus }) },
    getClientRects: () => visible ? [{}] : [],
  };
}

function makeBundle(headers = [], options = {}) {
  const workspaceContextService = options.workspaceContextService || {};
  const opened = [];
  const groups = [];
  const data = options.data || {
    allComposersData: {
      allComposers: headers,
      selectedComposerIds: options.selectedComposerIds || [],
      lastFocusedComposerIds: [],
    },
    _workspaceContextService: workspaceContextService,
    whenInitialComposerDataLoaded: async () => {},
    get selectedComposerId() { return options.selectedComposerId; },
  };
  const views = options.views || {
    composerDataService: data,
    getEditorGroupForComposer(id) {
      const group = { id: `target:${id}` };
      groups.push({ id, group });
      return group;
    },
  };
  const layout = options.layout || {
    async openComposer(value) { opened.push(value); },
  };
  const entries = new Map([
    [serviceId('composerDataService'), data],
    [Symbol('composerViewsService'), views],
    ['agentLayoutService', layout],
  ]);
  const instantiationService = { _services: { _entries: entries }, _parent: null };
  const scope = { instantiationService, workspaceContextService };
  const fiber = {
    memoizedProps: { value: { workspace: scope } },
    dependencies: null,
    return: null,
  };
  const seed = {};
  Object.defineProperty(seed, '__reactFiber$fixture', { value: fiber });
  return { data, views, layout, opened, groups, scope, seed, headers };
}

function mockDocument({ seeds = [], bars = [] } = {}) {
  return {
    querySelectorAll(selector) {
      if (selector === '.unified-agents-sidebar .ui-agent-status-dot') return seeds;
      if (selector === '.composer-bar[data-composer-id]') return bars;
      return [];
    },
  };
}

test('reads header metadata only and maps visible composer status without exposing names', () => {
  let contentReads = 0;
  const active = header(UUID_A, { status: 'completed' });
  Object.defineProperty(active, 'conversation', { get() { contentReads++; throw new Error('content must not be read'); } });
  const selectedFromStore = header(UUID_B, { status: 'completed' });
  const draft = header(UUID_C, { isDraft: true });
  const ignored = [
    header('44444444-4444-4444-8444-444444444444', { isEphemeral: true }),
    header('55555555-5555-4555-8555-555555555555', { isSpec: true }),
    header('66666666-6666-4666-8666-666666666666', { subagentInfo: { parentComposerId: UUID_A } }),
    header('77777777-7777-4777-8777-777777777777', { isBestOfNSubcomposer: true }),
  ];
  const bundle = makeBundle([active, selectedFromStore, draft, ...ignored], { selectedComposerId: UUID_B });
  const adapter = createUnifiedHistoryAdapter(mockDocument({
    seeds: [bundle.seed],
    bars: [
      visibleComposerBar(UUID_A, 'generating'),
      visibleComposerBar(UUID_B, 'completed', false),
    ],
  }));

  assert.equal(adapter?.kind, 'legacy');
  assert.equal(adapter?.implementation, 'unified-services');
  const rows = adapter.entries();
  assert.deepEqual(rows.map(row => row.id), [`local:${UUID_A}`, `local:${UUID_B}`, `local:${UUID_C}`]);
  assert.equal(rows[0].label, '');
  assert.equal(rows[0].searchText, '');
  assert.equal(rows[0].timestamp, 200);
  assert.equal(rows[0].isSelected, true, 'the unique visible composer takes precedence over the store selection');
  assert.equal(rows[0].icon, 'loading');
  assert.equal(rows[0].status, 'generating');
  assert.equal(rows[0].showSpinner, true);
  assert.equal(rows[0].statusRequiresSelection, false);
  assert.equal(rows[1].isSelected, false);
  assert.equal(rows[1].icon, 'registered', 'a hidden bar status is not treated as current evidence');
  assert.equal(rows[1].statusRequiresSelection, true);
  assert.equal(rows[2].icon, 'draft');
  assert.equal(rows[2].status, 'draft');
  assert.equal(rows[2].durable, false);
  assert.equal(JSON.stringify(rows).includes('private title'), false);
  assert.equal(JSON.stringify(rows).includes('private subtitle'), false);
  assert.equal(contentReads, 0);
});

test('maps only known visible statuses and does not infer completion from an unknown state', () => {
  const headers = [
    header(UUID_A),
    header(UUID_B),
    header(UUID_C, { status: 'completed' }),
    header(UUID_D),
    header(UUID_E),
  ];
  const bundle = makeBundle(headers);
  const adapter = createUnifiedHistoryAdapter(mockDocument({
    seeds: [bundle.seed],
    bars: [
      visibleComposerBar(UUID_A, 'completed'),
      visibleComposerBar(UUID_B, 'cancelled'),
      visibleComposerBar(UUID_C, 'queued-for-review'),
      visibleComposerBar(UUID_D, 'error'),
      visibleComposerBar(UUID_E, 'failed'),
    ],
  }));
  const rows = adapter.entries();
  assert.equal(rows[0].icon, 'check-circled');
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[1].icon, 'circle-slash');
  assert.equal(rows[1].status, 'cancelled');
  assert.equal(rows[2].icon, 'registered');
  assert.equal(rows[2].status, null);
  assert.equal(rows[2].statusRequiresSelection, true);
  assert.equal(rows[3].icon, 'warning');
  assert.equal(rows[3].status, 'error');
  assert.equal(rows[4].icon, 'warning');
  assert.equal(rows[4].status, 'failed');
});

test('multiple visible composer bars fall back to the data service selection', () => {
  const bundle = makeBundle([header(UUID_A), header(UUID_B)], { selectedComposerId: UUID_B });
  const adapter = createUnifiedHistoryAdapter(mockDocument({
    seeds: [bundle.seed],
    bars: [visibleComposerBar(UUID_A, 'generating'), visibleComposerBar(UUID_A, 'completed')],
  }));
  const rows = adapter.entries();
  assert.equal(rows[0].isSelected, false);
  assert.equal(rows[0].icon, 'registered', 'two visible DOM states are ambiguous');
  assert.equal(rows[0].statusRequiresSelection, true);
  assert.equal(rows[1].isSelected, true);
});

test('a unique selectedComposerIds value is used when there is no unique visible composer bar', () => {
  const bundle = makeBundle([header(UUID_A), header(UUID_B)], { selectedComposerIds: new Set([UUID_B]) });
  const adapter = createUnifiedHistoryAdapter(mockDocument({ seeds: [bundle.seed] }));
  const rows = adapter.entries();
  assert.equal(rows[0].isSelected, false);
  assert.equal(rows[1].isSelected, true);
});

test('opens the existing header id and accepts local-prefixed, raw, and case-varied UUIDs', async () => {
  const bundle = makeBundle([header(UUID_A.toUpperCase())]);
  const adapter = createUnifiedHistoryAdapter(mockDocument({ seeds: [bundle.seed] }));
  assert.equal(await adapter.open(`local:${UUID_A.toUpperCase()}`), true);
  assert.equal(await adapter.open(UUID_A), true);
  assert.deepEqual(bundle.opened.map(item => item.id), [UUID_A.toUpperCase(), UUID_A.toUpperCase()]);
  assert.ok(bundle.opened.every(item => item.type === 'local'
    && item.openInNewTab === true && item.transient === true));
  assert.equal(bundle.groups.length, 2);
});

test('open rejects unknown, malformed, duplicate, ephemeral, spec, and subagent ids', async () => {
  const duplicate = header(UUID_A);
  const bundle = makeBundle([
    header(UUID_A),
    duplicate,
    header(UUID_B, { isEphemeral: true }),
    header(UUID_C, { isSpec: true }),
    header('88888888-8888-4888-8888-888888888888', { subagentParentComposerId: UUID_A }),
  ]);
  const adapter = createUnifiedHistoryAdapter(mockDocument({ seeds: [bundle.seed] }));
  assert.equal(await adapter.open(`local:${UUID_A}`), false, 'duplicate header identity is ambiguous');
  assert.equal(await adapter.open(`local:${UUID_B}`), false);
  assert.equal(await adapter.open(`local:${UUID_C}`), false);
  assert.equal(await adapter.open('local:88888888-8888-4888-8888-888888888888'), false);
  assert.equal(await adapter.open(`cloud:${UUID_A}`), false);
  assert.equal(await adapter.open('not-a-uuid'), false);
  assert.equal(await adapter.open(`local:${UUID_A.toUpperCase()} `), false);
  assert.deepEqual(bundle.opened, []);
});

test('child-first service lookup permits split scopes only when references form one consistent bundle', () => {
  const workspaceContextService = {};
  const data = {
    allComposersData: { allComposers: [header(UUID_A)] },
    _workspaceContextService: workspaceContextService,
    whenInitialComposerDataLoaded: async () => {},
  };
  const views = { composerDataService: data, getEditorGroupForComposer: () => null };
  const layout = { openComposer: async () => {} };
  const parent = { _services: { _entries: new Map([
    [serviceId('composerViewsService'), views],
    [serviceId('agentLayoutService'), layout],
  ]) }, _parent: null };
  const child = { _services: { _entries: new Map([[serviceId('composerDataService'), data]]) }, _parent: parent };
  const scope = { workspaceContextService, instantiationService: child };
  const seed = {};
  Object.defineProperty(seed, '__reactFiber$fixture', {
    value: {
      memoizedProps: null,
      dependencies: { firstContext: { memoizedValue: { workspace: scope }, next: null } },
      return: null,
    },
  });
  const adapter = createUnifiedHistoryAdapter(mockDocument({ seeds: [seed] }));
  assert.equal(adapter?.entries()[0]?.id, `local:${UUID_A}`);
});

test('returns null for inconsistent references or multiple distinct service bundles', () => {
  const first = makeBundle([header(UUID_A)]);
  const mismatchedData = { ...first.data, _workspaceContextService: {} };
  const mismatched = makeBundle([header(UUID_B)], {
    data: mismatchedData,
    views: { composerDataService: mismatchedData, getEditorGroupForComposer() {} },
  });
  assert.equal(createUnifiedHistoryAdapter(mockDocument({ seeds: [mismatched.seed] })), null);

  const otherData = {
    allComposersData: { allComposers: [header(UUID_B)] },
    _workspaceContextService: first.scope.workspaceContextService,
    whenInitialComposerDataLoaded: async () => {},
  };
  const mismatchedViews = makeBundle([header(UUID_B)], {
    workspaceContextService: first.scope.workspaceContextService,
    data: otherData,
    views: { composerDataService: first.data, getEditorGroupForComposer() {} },
  });
  assert.equal(createUnifiedHistoryAdapter(mockDocument({ seeds: [mismatchedViews.seed] })), null);

  const second = makeBundle([header(UUID_B)]);
  assert.equal(createUnifiedHistoryAdapter(mockDocument({ seeds: [first.seed, second.seed] })), null);

  const sameBundleAgain = {};
  Object.defineProperty(sameBundleAgain, '__reactFiber$another', {
    value: { memoizedProps: { value: { workspace: first.scope } }, dependencies: null, return: null },
  });
  const adapter = createUnifiedHistoryAdapter(mockDocument({ seeds: [first.seed, sameBundleAgain] }));
  assert.equal(adapter?.entries().length, 1, 'duplicate roots for the same object bundle are deduplicated');
});

test('embedded function source is self-contained and unknown service sets return null', () => {
  const bundle = makeBundle([header(UUID_A)]);
  const embeddedFactory = vm.runInNewContext(`(${createUnifiedHistoryAdapter.toString()})`);
  const adapter = embeddedFactory(mockDocument({ seeds: [bundle.seed] }));
  assert.equal(adapter?.entries()[0]?.id, `local:${UUID_A}`);

  const noServices = {};
  Object.defineProperty(noServices, '__reactFiber$empty', {
    value: { memoizedProps: { value: { workspace: { instantiationService: {}, workspaceContextService: {} } } }, return: null },
  });
  assert.equal(createUnifiedHistoryAdapter(mockDocument({ seeds: [noServices] })), null);
});
