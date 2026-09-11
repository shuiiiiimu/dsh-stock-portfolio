/**
 * The client bundle's load contract.
 *
 * dsh-client-modules serves `lib/client.js` as a classic script and hands the
 * registered factory a `require` backed by the shell's frozen platform module
 * table. Two failure modes there are silent until a user opens the GUI: a
 * `require` the table cannot answer, and an `id` that disagrees with the package
 * name the host half scanned. Both are asserted here, and the factory is
 * actually executed against a stub table so `apply` runs for real.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const PACKAGE_NAME = 'dsh-stock-portfolio'
const BUNDLE = new URL('../lib/client.js', import.meta.url)
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** The shell's frozen module table (`packages/client/web/src/platform.ts`). */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const SOURCE = readFileSync(BUNDLE, 'utf8')

/**
 * Build a stand-in for the shell's module table.
 * @param seen - collects every specifier the bundle actually required.
 * @returns the `require` function handed to the factory.
 */
function stubRequire(seen) {
  const icon = () => null
  const table = {
    'react': {
      useLayoutEffect: () => {},
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useState: value => [typeof value === 'function' ? value() : value, () => {}],
      useMemo: factory => factory(),
      useCallback: fn => fn,
      createElement: () => null,
    },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: null },
    '@deepseek-ai/dsh-client-ui-primitives': new Proxy({ Tooltip: () => null }, {
      get: (target, key) => (key in target ? target[key] : icon),
    }),
  }
  return (specifier) => {
    seen.push(specifier)
    if (!(specifier in table)) {
      throw new Error(`client-modules: require("${specifier}") missed the module table`)
    }
    return table[specifier]
  }
}

/**
 * Load the bundle and return its registration.
 *
 * The bundle is evaluated in THIS realm rather than a fresh VM context: a
 * separate realm would give its arrays and objects different prototypes, and
 * every structural assertion below would fail on identity rather than on
 * behaviour.
 * @returns the registration plus the recorded style tags.
 */
function loadBundle() {
  let registration
  const styleTags = []
  const document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: tag => { styleTags.push(tag) } },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  // eslint-disable-next-line no-new-func -- the artifact under test is a script by construction.
  const run = new Function('window', 'document', SOURCE)
  run(window, document)
  return { registration, styleTags }
}

test('the bundle registers exactly one factory under the package name', () => {
  const { registration } = loadBundle()
  assert.ok(registration, 'the bundle never called window.__ModuleLoader__.load')
  // The host half derives the graph row id from the manifest name; a mismatch
  // means the registered factory is never adopted.
  assert.equal(registration.id, MANIFEST.name)
  assert.equal(registration.id, PACKAGE_NAME)
  assert.equal(typeof registration.factory, 'function')
})

test('every require stays inside the platform module table', () => {
  const seen = []
  const { registration } = loadBundle()
  registration.factory(stubRequire(seen))
  assert.ok(seen.length > 0, 'the bundle required nothing, which cannot be right')
  for (const specifier of new Set(seen)) {
    assert.ok(
      PLATFORM_MODULES.includes(specifier),
      `require("${specifier}") is not a platform module — the browser table cannot answer it`,
    )
  }
})

test('the factory exports a Cordis plugin with the slots injection', () => {
  const exports_ = loadBundle().registration.factory(stubRequire([]))
  assert.equal(typeof exports_.apply, 'function')
  assert.deepEqual(exports_.inject, ['slots'])
})

/**
 * The `inject` face of a client context.
 *
 * `ctx.inject(deps, callback)` runs the callback once those services exist — the
 * harness's own optional-registration path, which this plugin uses for the Right
 * Sidebar's tab-type registry. A stub that lacks it turns that registration into
 * a no-op and the pane into something nobody can open.
 * `ctx.effect(work)` runs `work` immediately and keeps its disposer, so the
 * default here runs it too: an effect that is merely collected would leave the
 * registration it performs undone, and the assertion that follows would be
 * measuring the stub rather than the plugin.
 * @param get - the context's service reader.
 * @param onEffect - what to do with an effect the callback registers; runs it by
 * default, and may collect it instead when a case cares about the disposer.
 * @returns the `inject` method.
 */
function injectFace(get, onEffect = work => { work() }) {
  return (deps, callback) => { callback({ get, effect: work => { onEffect(work) } }) }
}

/**
 * Run one injection callback the way the live slot owner does.
 *
 * A cell registers through a plain callback; the mention pane registers through
 * a generator that yields its disposers (the Right-Sidebar two-stage form), so a
 * callback that hands back an iterator is driven to completion here.
 * @param callback - the injected callback.
 * @returns what a plain callback returned.
 */
function runInjection(callback) {
  const result = callback()
  if (result === null || typeof result !== 'object' || typeof result.next !== 'function') return result
  let step = result.next()
  while (step.done !== true) step = result.next()
  return undefined
}

test('apply registers every cell and injects its stylesheet', () => {
  const exports_ = loadBundle().registration.factory(stubRequire([]))
  const injections = []
  const registrations = []
  const effects = []
  const ctx = {
    slots: {
      inject: (key, callback) => { injections.push([key, callback]) },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    effect: (work) => { effects.push(work) },
    get: () => undefined,
    inject: injectFace(() => undefined, work => { effects.push(work) }),
  }

  exports_.apply(ctx)

  // One `inject` per slot: the callback only runs once the owner declares it.
  assert.deepEqual(injections.map(([key]) => key),
    ['sidebar.footer.action', 'shell.overlay', 'conversation.session.header.utilities', 'sidebar.right.pane.tab'])
  // Running every callback is what a live owner does on mount.
  for (const [, callback] of injections) runInjection(callback)

  assert.deepEqual(registrations.map(row => row.options.name),
    ['sidebar.footer.action', 'shell.overlay', 'conversation.session.header.utilities', 'sidebar.right.pane.tab'])
  // The two frame cells are list entries keyed by a fresh id.
  for (const { options } of registrations.filter(row => row.options.name !== 'sidebar.right.pane.tab')) {
    // The list-entry key, not the package name: it must be fresh so the
    // registration stays additive, and it must not be ui-cordis's `cordis-panel`.
    assert.equal(options.id, 'stock-portfolio')
    assert.notEqual(options.id, 'cordis-panel')
    assert.equal(typeof options.order, 'number')
  }
  // The pane is a keyed Right-Sidebar tab body, and its key is also the id its
  // type registers under — that agreement is what the seat dispatches on.
  // The session watcher is the header seat that follows whatever conversation is
  // on screen; it renders nothing and exists so that OPENING a session is enough.
  const watcher = registrations.find(row => row.options.name === 'conversation.session.header.utilities')
  assert.equal(watcher.options.id, 'stock-portfolio')
  assert.equal(typeof watcher.options.inject().store.watchSession, 'function')

  const pane = registrations.find(row => row.options.name === 'sidebar.right.pane.tab')
  assert.equal(pane.options.key, 'dsh-stock-portfolio')
  assert.equal(exports_.mentionsDefinition().id, pane.options.key)
  assert.equal(exports_.mentionsDefinition().kind, exports_.MENTIONS_KIND)
  assert.equal(exports_.mentionsDefinition().title('sidebar://stock-portfolio-mentions'), '持仓提及')
  // A page type is reachable from the Guide too, or a user who turned the
  // automatic reveal off could never open the pane.
  assert.deepEqual(exports_.mentionsDefinition().guide.map(entry => entry.title()), ['持仓提及'])

  const sidebar = registrations.find(row => row.options.name === 'sidebar.footer.action')
  assert.ok(sidebar.options.order > 0, 'the entry must sort after the existing footer action')
  for (const { component } of registrations) assert.equal(typeof component, 'function')

  // Both registrations share one store instance, which is what keeps the
  // sidebar badge and the open panel in step.
  const first = sidebar.options.inject()
  const overlay = registrations.find(row => row.options.name === 'shell.overlay')
  assert.equal(first.store, overlay.options.inject().store)
  assert.equal(first.hooks.portfolio, first.store)
  assert.equal(typeof first.store.getSnapshot, 'function')
  assert.equal(typeof first.store.subscribe, 'function')
  assert.equal(pane.options.inject().store, first.store)

  // The stylesheet is an owned effect, not a side effect of module evaluation.
  assert.equal(effects.length, 2)
  const styleWork = effects[1]
  const disposer = styleWork()
  assert.equal(typeof disposer, 'function')
  disposer()

  // `apply` also starts the conversation watcher, whose poll keeps the process
  // alive until the plugin's own disposer runs it down.
  first.store.dispose()
})

test('the store snapshot only changes identity when something changed', () => {
  const exports_ = loadBundle().registration.factory(stubRequire([]))
  const injections = []
  const registrations = []
  exports_.apply({
    slots: {
      inject: (key, callback) => { injections.push([key, callback]) },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    effect: () => {},
    get: () => undefined,
    inject: injectFace(() => undefined),
  })
  for (const [, callback] of injections) runInjection(callback)
  const { store } = registrations[0].options.inject()

  const before = store.getSnapshot()
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications += 1 })
  assert.equal(store.getSnapshot(), before, 'reading twice must not allocate a new snapshot')

  store.selectTab('trades')
  assert.notEqual(store.getSnapshot(), before)
  assert.equal(store.getSnapshot().tab, 'trades')
  assert.equal(notifications, 1)

  // Selecting the tab that is already active still notifies, which is harmless:
  // the selector returns the same value and React skips the re-render.
  store.close()
  unsubscribe()
  store.selectTab('overview')
  assert.equal(notifications, 2, 'unsubscribed listeners must not be called')

  // The mention watcher `apply` started is this store's to stop.
  store.dispose()
})

test('apply wires a fresh mention to the Right-Sidebar navigation face', async () => {
  // The wiring under test is the one line between two packages: a mention in the
  // conversation must end as a navigation call on the Right Sidebar, with the
  // tab type registered under the id its body is keyed by.
  const registered = []
  const opened = []
  // One stand-in for the whole test: `ctx.get` is called per reveal, and a fresh
  // object each time would forget that the pane is already on screen.
  let expanded = false
  const injections = []
  const registrations = []
  const exports_ = loadBundle().registration.factory(stubRequire([]))
  let rev = 1
  let batches = [{ rev: 1, source: 'user', at: 1, symbols: ['600519.SH'], excerpt: '…' }]
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = String(url).split('?')[0]
    const body = path.endsWith('/mentions')
      ? { rev, batches }
      : {
          trades: [], positions: [], closed: [], quotes: [], stats: {},
          settings: { mentionPopup: true, autoRefresh: false, baseCurrency: 'CNY' },
          feed: { latestDate: null }, motives: [], generatedAt: '2026-09-11T00:00:00.000Z',
        }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }

  const read = (name) => {
      if (name === 'sidebarRightTabs') return { register: (definition) => { registered.push(definition); return () => {} } }
      if (name === 'sidebarRight') {
        // A faithful stand-in: opening the pane leaves it expanded and active,
        // which is the state the second turn below must respect.
        return {
          openTab: (kind) => { opened.push(kind); expanded = true },
          isExpanded: () => expanded,
          active: () => (expanded ? { kind: exports_.MENTIONS_KIND } : undefined),
        }
      }
      return undefined
  }
  exports_.apply({
    slots: {
      inject: (key, callback) => { injections.push([key, callback]) },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    effect: () => {},
    get: read,
    inject: injectFace(read),
  })
  for (const [, callback] of injections) runInjection(callback)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-stock-portfolio')
  assert.equal(registered[0].kind, exports_.MENTIONS_KIND)
  assert.equal(registered[0].title('sidebar://stock-portfolio-mentions'), '持仓提及')
  assert.equal(registered[0].guide.length, 1)
  // The session watcher is the header seat that follows whatever conversation is
  // on screen; it renders nothing and exists so that OPENING a session is enough.
  const watcher = registrations.find(row => row.options.name === 'conversation.session.header.utilities')
  assert.equal(watcher.options.id, 'stock-portfolio')
  assert.equal(typeof watcher.options.inject().store.watchSession, 'function')

  const pane = registrations.find(row => row.options.name === 'sidebar.right.pane.tab')
  assert.equal(pane.options.key, registered[0].id, 'the body is keyed by the type id')
  assert.equal(pane.component, exports_.MentionsPanel)

  const store = registrations[0].options.inject().store
  try {
    // `apply` reads the snapshot once, for the sidebar row's number: nothing
    // visible may depend on the panel having been opened first.
    await new Promise(resolve => { setTimeout(resolve, 10) })
    assert.notEqual(store.getSnapshot().state, null, 'the sidebar badge has no data to render')
    store.watchSession('session-1')
    // The interval is two seconds by design; the test drives the tick itself
    // rather than waiting one out. `watchSession` already kicked one off, so the
    // second call is the one the assertion reads.
    await store.pollMentions()
    assert.deepEqual(opened, [exports_.MENTIONS_KIND], 'a session with mentions reveals the pane')

    // Nothing is mounted, so every fresh turn opens it again — there is no pane
    // on screen to update.
    rev = 2
    batches = [...batches, { rev: 2, source: 'assistant', at: 2, symbols: ['00700.HK'], excerpt: '…' }]
    await store.pollMentions()
    assert.equal(opened.length, 2)

    // The pane reports itself PAINTING: from here it updates itself, and must not
    // be raised again over whatever the user is reading.
    store.paneVisible = true
    rev = 3
    batches = [...batches, { rev: 3, source: 'assistant', at: 3, symbols: ['600519.SH'], excerpt: '…' }]
    await store.pollMentions()
    assert.equal(opened.length, 2, 'a mounted pane is not re-opened')

    // A layout that CLAIMS the pane is showing while nothing is painting must
    // still open it: that is the state a refresh used to leave behind, where the
    // reveal was suppressed and the pane never appeared at all.
    store.paneVisible = false
    rev = 4
    batches = [...batches, { rev: 4, source: 'assistant', at: 4, symbols: ['AAPL.US'], excerpt: '…' }]
    await store.pollMentions()
    assert.equal(opened.length, 3)
  } finally {
    store.dispose()
    globalThis.fetch = realFetch
  }
})

test('a reveal that arrives before the column is mounted is retried, not dropped', async () => {
  // The failure this pins down: a fresh page load polls before the Right
  // Sidebar's seat has bound, `openTab` throws "no session surface is mounted",
  // and a pane nobody retries simply never appears.
  let bound = false
  const opened = []
  const injections = []
  const registrations = []
  const exports_ = loadBundle().registration.factory(stubRequire([]))
  const read = (name) => {
      if (name === 'sidebarRightTabs') return { register: () => () => {} }
      if (name === 'sidebarRight') {
        return {
          openTab: (kind) => {
            if (!bound) throw new Error('sidebarRight: no session surface is mounted')
            opened.push(kind)
          },
          isExpanded: () => false,
          active: () => undefined,
        }
      }
      return undefined
  }
  exports_.apply({
    slots: {
      inject: (key, callback) => { injections.push([key, callback]) },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    effect: () => {},
    get: read,
    inject: injectFace(read),
  })
  for (const [, callback] of injections) runInjection(callback)

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const path = String(url).split('?')[0]
    const body = path.endsWith('/mentions')
      ? { rev: 1, batches: [{ rev: 1, source: 'user', at: 1, symbols: ['600519.SH'], excerpt: '…' }] }
      : {
          trades: [], positions: [], closed: [], quotes: [], stats: {},
          settings: { mentionPopup: true, autoRefresh: false, baseCurrency: 'CNY' },
          feed: { latestDate: null }, motives: [], generatedAt: '2026-09-11T00:00:00.000Z',
        }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }

  const store = registrations[0].options.inject().store
  try {
    await store.load()
    store.watchSession('session-1')
    await store.pollMentions()
    assert.deepEqual(opened, [], 'the seat is not bound yet, so nothing could open')

    // Whatever binds the seat (a moment later in the browser), the store comes
    // back for the reveal on its own — well before the next two-second poll.
    bound = true
    await new Promise(resolve => { setTimeout(resolve, 400) })
    assert.deepEqual(opened, [exports_.MENTIONS_KIND])

    await new Promise(resolve => { setTimeout(resolve, 400) })
    assert.equal(opened.length, 1, 'a landed reveal is not repeated')
  } finally {
    store.dispose()
    globalThis.fetch = realFetch
  }
})

test('a fresh mention reveals the pane through the callback, once per turn', async () => {
  // The store does not know how the Right Sidebar opens — that is the client
  // half's business — so what it owes is exactly one callback per fresh turn,
  // never for history, and never while 自动弹出 is off.
  let rev = 4
  let popup = true
  let batches = [{ rev: 4, source: 'user', at: 1_700_000_000_000, symbols: ['600519.SH'], excerpt: '…600519…' }]
  const asked = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost')
    asked.push(parsed.pathname + parsed.search)
    const body = parsed.pathname.endsWith('/mentions')
      ? { rev, batches }
      : {
          trades: [], positions: [], closed: [], quotes: [], stats: {},
          settings: { mentionPopup: popup, autoRefresh: false, baseCurrency: 'CNY' },
          feed: { latestDate: null }, motives: [], generatedAt: '2026-09-11T00:00:00.000Z',
        }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }

  const seen = []
  const exports_ = loadBundle().registration.factory(stubRequire([]))
  const store = exports_.createPortfolioStore({
    mentionPollMs: 5,
    onMention: symbols => { seen.push([...symbols]) },
  })
  try {
    await store.load()
    store.watchSession('session-1')
    await new Promise(resolve => { setTimeout(resolve, 25) })
    // The poll is per session, and the first answer for a session IS news: a
    // conversation opened from history already has its mentions, and opening it
    // is the user asking to see them.
    assert.deepEqual(seen, [['600519.SH']])
    assert.equal(store.getSnapshot().mentionRev, 4)
    const polls = asked.filter(url => url.includes('/mentions'))
    assert.ok(polls.length > 0 && polls.every(url => url === '/dsh-stock-portfolio/api/mentions?session=session-1'),
      `the poll must name its session: ${asked.join(', ')}`)

    rev = 5
    batches = [...batches, {
      rev: 5, source: 'assistant', at: 1_700_000_060_000, symbols: ['600519.SH', '00700.HK'],
      excerpt: '…腾讯控股…',
    }]
    await new Promise(resolve => { setTimeout(resolve, 40) })

    assert.deepEqual(seen, [['600519.SH'], ['600519.SH', '00700.HK']])
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.mentionRev, 5)
    // Newest mention first, each symbol once, in the order the turn named them.
    assert.deepEqual(exports_.mentionedSymbols(snapshot.mentions), ['600519.SH', '00700.HK'])

    // The same revision must not fire twice while polling continues.
    await new Promise(resolve => { setTimeout(resolve, 30) })
    assert.equal(seen.length, 2)

    // Switching conversations drops the old feed: another session's symbols
    // must never appear under this one's name while the new answer is in flight.
    rev = 0
    batches = []
    store.watchSession('session-2')
    assert.deepEqual(store.getSnapshot().mentions, [])
    assert.equal(store.getSnapshot().mentionRev, null)

    // With 自动弹出 off the feed still fills the pane; nothing is revealed. The
    // store reads the setting from the snapshot, which a save refreshes.
    popup = false
    await store.load()
    rev = 6
    batches = [{
      rev: 6, source: 'user', at: 1_700_000_120_000, symbols: ['AAPL.US'], excerpt: '…AAPL…',
    }]
    await new Promise(resolve => { setTimeout(resolve, 40) })
    assert.equal(store.getSnapshot().mentionRev, 6)
    assert.equal(seen.length, 2, '自动弹出 is off, so nothing may be revealed')
    // The feed itself still holds every batch; the pane lists all of them.
    assert.deepEqual(exports_.mentionedSymbols(store.getSnapshot().mentions), ['AAPL.US'])
  } finally {
    store.dispose()
    globalThis.fetch = realFetch
  }
})
