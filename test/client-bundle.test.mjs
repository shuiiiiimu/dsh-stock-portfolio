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

test('apply registers both cells and injects its stylesheet', () => {
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
  }

  exports_.apply(ctx)

  // One `inject` per slot: the callback only runs once the owner declares it.
  assert.deepEqual(injections.map(([key]) => key), ['sidebar.footer.action', 'shell.overlay'])
  // Running both callbacks is what a live owner does on mount.
  for (const [, callback] of injections) callback()

  assert.deepEqual(registrations.map(row => row.options.name), ['sidebar.footer.action', 'shell.overlay'])
  for (const { options } of registrations) {
    // The list-entry key, not the package name: it must be fresh so the
    // registration stays additive, and it must not be ui-cordis's `cordis-panel`.
    assert.equal(options.id, 'stock-portfolio')
    assert.notEqual(options.id, 'cordis-panel')
    assert.equal(typeof options.order, 'number')
  }
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

  // The stylesheet is an owned effect, not a side effect of module evaluation.
  assert.equal(effects.length, 2)
  const styleWork = effects[1]
  const disposer = styleWork()
  assert.equal(typeof disposer, 'function')
  disposer()
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
  })
  for (const [, callback] of injections) callback()
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
})
