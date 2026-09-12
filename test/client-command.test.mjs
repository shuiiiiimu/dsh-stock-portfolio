/**
 * `/portfolio-review`: the slash-menu row and what a pick does with it.
 *
 * The row is intentionally client-owned, so the things worth pinning down are
 * the ones a Host command could not have done: a localized label read on demand,
 * a real icon, and one session's composer receiving the request as an editable
 * draft rather than a question already sent.
 *
 * The bundle is loaded exactly as the shell loads it — `window.__ModuleLoader__`
 * plus the frozen platform table — so a require the shell cannot answer fails
 * here rather than in the browser.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const SOURCE = readFileSync(BUNDLE, 'utf8')

/**
 * Load the bundle and hand back its module exports.
 * @returns the browser half's exports.
 */
function loadClient() {
  let registration
  const document = {
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  // eslint-disable-next-line no-new-func -- the artifact under test is a script by construction.
  new Function('window', 'document', SOURCE)(window, document)
  const icon = () => null
  return registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => icon })
    throw new Error(`client-modules: require("${specifier}") missed the module table`)
  })
}

/**
 * Build a context shaped the way the client half finds services.
 * @param options - `active` locale id, `withComposer: false` to omit it, and
 *   `locale` to replace the locale service outright.
 * @returns the context, the registered contribution, and the draft writes.
 */
function makeContext(options = {}) {
  const drafts = []
  const effects = []
  const contribution = { current: undefined }
  const scoped = {
    get: (name) => (name === 'conversation' && options.withComposer !== false
      ? { input: { for: () => ({ setDraft: (text) => { drafts.push(text) } }) } }
      : undefined),
  }
  /** The services both contexts see; the scope adds `commandUi` on top. */
  const shared = (name) => {
    if (name === 'locale') {
      // `locale: null` is the absent service; `locale: {...}` a real one; no
      // key at all keeps the factory's working default.
      if (options.locale === null) return undefined
      return options.locale ?? { getSnapshot: () => ({ active: options.active ?? 'zh' }) }
    }
    if (name === 'sessions') return { scope: (id) => (id === 's1' ? scoped : undefined) }
    return undefined
  }
  const scope = {
    get: (name) => (name === 'commandUi'
      ? { register: (row) => { contribution.current = row; return () => {} } }
      : shared(name)),
    // The real registry runs the work and keeps its disposer; a mock that only
    // collected the closure would leave the row unregistered and the test green
    // about nothing.
    effect: (work) => { effects.push(work()) },
  }
  return {
    ctx: { inject: (deps, callback) => { callback(scope) } },
    contribution,
    drafts,
  }
}

test('a pick writes the review request into the composer, unsent', () => {
  const { ctx, contribution } = makeContext()
  loadClient().applyReviewCommand(ctx)

  const row = contribution.current
  assert.ok(row !== undefined, 'no command row was registered')
  assert.equal(row.name, 'portfolio-review')
  assert.equal(row.ui.kind, 'action')
  assert.equal(typeof row.icon, 'function')

  const sent = []
  row.ui.run({ sessionId: 's1', send: (text) => sent.push(text) })
  assert.deepEqual(sent, [], 'the pick must not submit on the user behalf')
})

test('the label and description follow the active locale, read per pass', () => {
  const { ctx, contribution } = makeContext({ active: 'zh-CN' })
  loadClient().applyReviewCommand(ctx)
  const row = contribution.current
  assert.equal(row.label(), '复盘持仓')
  assert.match(row.description(), /复盘当前持仓/)

  const english = makeContext({ active: 'en' })
  loadClient().applyReviewCommand(english.ctx)
  assert.equal(english.contribution.current.label(), 'Portfolio review')
  assert.match(english.contribution.current.description(), /current P&L/)
})

test('either locale reader answers, and a missing one falls back to English', () => {
  const older = makeContext({ locale: { getLocale: () => ({ active: 'zh' }) } })
  loadClient().applyReviewCommand(older.ctx)
  assert.equal(older.contribution.current.label(), '复盘持仓')

  // The failure this pins down: an accessor that is not there must not throw
  // inside the menu's candidate pass, because that takes the whole `/` menu
  // down with it rather than merely showing English copy.
  // No service at all, and a service whose readers are not functions: both must
  // answer English rather than throw. The `active: 'zh'` default is deliberately
  // not passed here — it is the factory's stand-in for a WORKING service, and
  // asserting through it would test the mock instead of the fallback.
  for (const options of [{ locale: null }, { locale: {} }, { locale: { getSnapshot: undefined } }]) {
    const { ctx, contribution } = makeContext(options)
    loadClient().applyReviewCommand(ctx)
    assert.equal(contribution.current.label(), 'Portfolio review')
  }

  // A reader that IS a function still selects Chinese, so the fallback above is
  // a fallback and not the only path.
  const shaped = makeContext({ locale: { getSnapshot: () => ({ active: 'zh-CN' }) } })
  loadClient().applyReviewCommand(shaped.ctx)
  assert.equal(shaped.contribution.current.label(), '复盘持仓')
})

test('the draft names the tool so a typed and a picked review ask the same thing', () => {
  const { ctx, contribution, drafts } = makeContext()
  const exports = loadClient()
  exports.applyReviewCommand(ctx)

  contribution.current.ui.run({ sessionId: 's1' })
  assert.equal(drafts.length, 1)
  assert.match(drafts[0], /stock_portfolio_review/)
  assert.match(drafts[0], /券商预期/)
  assert.equal(drafts[0], exports.REVIEW_PROMPT)
})

test('a session with no composer is reported, not silently dropped', () => {
  const { ctx, contribution } = makeContext({ withComposer: false })
  loadClient().applyReviewCommand(ctx)
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    contribution.current.ui.run({ sessionId: 's1' })
  } finally {
    console.warn = original
  }
  assert.ok(warnings.some(line => line.includes('no composer')))
})

test('a composition without a command surface simply registers nothing', () => {
  const ctx = { inject: (deps, callback) => { callback({ get: () => undefined, effect: () => {} }) } }
  loadClient().applyReviewCommand(ctx)
})
