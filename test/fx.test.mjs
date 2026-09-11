/**
 * Exchange-rate acquisition.
 *
 * The rates are the one number in this plugin that arrives from prose rather than
 * from a typed API, so the cases here are mostly about REFUSING: a percentage, a
 * headline about another currency, a snippet pair that implies an absurd cross
 * rate. A wrong rate is worse than a stale one — it silently rescales every
 * converted total on the page.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { FX_ENDPOINTS, PortfolioService, acquireRates, parseRatesFromSearch } from '../lib/index.js'

const dirs = []

/** Create a scratch data directory. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-fx-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/**
 * Build a stand-in for `ctx.web`.
 * @param options - `fetch` and `search` behaviours, `fail` to reject.
 * @returns the capability record.
 */
function makeWeb({ fetch: fetchImpl, search } = {}) {
  return {
    fetch: fetchImpl ?? (async () => { throw new Error('fetch route not configured') }),
    search: search ?? (async () => { throw new Error('search route not configured') }),
  }
}

/** A `ctx.web.fetch` outcome carrying a JSON body. */
function fetched(payload, statusCode = 200) {
  return {
    url: 'https://example.invalid/latest',
    statusCode,
    body: { kind: 'text', content: typeof payload === 'string' ? payload : JSON.stringify(payload) },
    truncated: false,
  }
}

/** A `ctx.web.search` outcome carrying citation snippets. */
function searched(sources, content) {
  return { ...content === undefined ? {} : { content }, sources, truncated: false }
}

test('the JSON endpoint is the route that runs, and it dates the rate', async () => {
  const web = makeWeb({
    fetch: async () => fetched({ amount: 1.0, base: 'USD', date: '2026-09-11', rates: { CNY: 6.7082, HKD: 7.842 } }),
  })
  const outcome = await acquireRates(web)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.quote, {
    usdCny: 6.7082,
    usdHkd: 7.842,
    source: 'web-fetch',
    provider: 'frankfurter.dev',
    asOf: '2026-09-11',
  })
  assert.deepEqual(outcome.failures, [])
})

test('a refusing endpoint falls through to the next one, not to search', async () => {
  const called = []
  const web = makeWeb({
    fetch: async ({ url }) => {
      called.push(url)
      return url.includes('frankfurter')
        ? fetched({ error: 'Service Unavailable' }, 503)
        : fetched({ result: 'success', time_last_update_unix: 1_757_000_000, rates: { CNY: 6.71, HKD: 7.84 } })
    },
  })
  const outcome = await acquireRates(web)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.quote.provider, 'open.er-api.com')
  assert.equal(outcome.quote.usdCny, 6.71)
  assert.equal(outcome.quote.asOf, '2025-09-04')
  assert.equal(called.length, 2)
  assert.deepEqual(outcome.failures.map(failure => failure.route), ['frankfurter.dev'])
})

test('when every endpoint fails, the search fallback reads the citation snippets', async () => {
  const web = makeWeb({
    fetch: async () => { throw new Error('network unreachable') },
    search: async () => searched([
      { url: 'https://example.invalid/usd-cny', title: '美元 人民币 汇率', snippet: '1 美元 = 6.7123 人民币（今日）' },
      { url: 'https://example.invalid/usd-hkd', title: 'USD HKD', snippet: '1 USD = 7.8456 HKD' },
    ]),
  })
  const outcome = await acquireRates(web)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.quote.source, 'web-search')
  assert.equal(outcome.quote.provider, 'web_search')
  assert.equal(outcome.quote.usdCny, 6.7123)
  assert.equal(outcome.quote.usdHkd, 7.8456)
  assert.equal(outcome.quote.asOf, null)
  assert.equal(outcome.failures.length, 2)
})

test('prose with no plausible rate is refused rather than guessed', () => {
  const cases = [
    // A change percentage is not a rate.
    searched([]),
    // Nothing in either band.
    searched([{ url: 'u', title: '人民币兑美元中间价调升51个基点', snippet: '中间价报 7.1234，涨幅 0.15%' }], '美元指数上涨 0.42%'),
    // A plausible single number with no second pair.
    searched([{ url: 'u', title: 'USD CNY', snippet: '1 美元 = 6.71 人民币' }]),
    // Two good numbers that cannot belong to the same day (implied cross rate ~0.4).
    searched([
      { url: 'u', title: 'USD CNY', snippet: '1 美元 = 6.71 人民币' },
      { url: 'v', title: 'USD HKD', snippet: '1 USD = 16.5 HKD' },
    ]),
  ]
  for (const outcome of cases) assert.equal(parseRatesFromSearch(outcome), null)
})

test('a search number must sit next to its own currency keyword', () => {
  // 7.842 belongs to HKD; 6.7082 belongs to CNY. Neither may be read as the other.
  const quote = parseRatesFromSearch(searched([
    { url: 'u', title: '今日汇率', snippet: '美元兑港币 7.842，美元兑人民币 6.7082' },
  ]))
  assert.deepEqual(quote, {
    usdCny: 6.7082, usdHkd: 7.842, source: 'web-search', provider: 'web_search', asOf: null,
  })
})

test('no web capability means an explanation, not a wrong number', async () => {
  const service = new PortfolioService({ dataDir: scratch(), dotenvPath: join(scratch(), '.env') })
  try {
    const before = service.state().settings.rates
    const outcome = await service.refreshRates()
    assert.equal(outcome.ok, false)
    assert.equal(outcome.refreshed, false)
    assert.match(outcome.error, /web/)
    assert.deepEqual(service.state().settings.rates, before)
    assert.equal(service.state().settings.fx.available, false)
  } finally {
    service.close()
  }
})

test('a fetched pair is stored with its provenance, and one day is one fetch', async () => {
  const dir = scratch()
  let calls = 0
  // A clock the case can move: the guard is a calendar-day rule, not a window.
  // Local-time instants: "one day" is the reader's calendar day, so a case that
  // used UTC would pass only in UTC.
  let clock = new Date(2026, 8, 11, 9, 0, 0)
  const service = new PortfolioService({
    dataDir: dir,
    dotenvPath: join(dir, '.env'),
    now: () => clock,
    web: () => makeWeb({
      fetch: async () => {
        calls += 1
        return fetched({ base: 'USD', date: '2026-09-11', rates: { CNY: 6.7082, HKD: 7.842 } })
      },
    }),
  })
  try {
    const first = await service.refreshRates()
    assert.equal(first.ok, true)
    assert.equal(first.refreshed, true)
    const settings = service.state().settings
    assert.deepEqual(settings.rates, { HKD: 7.842, CNY: 6.7082 })
    assert.equal(settings.baseCurrency, 'CNY')
    assert.equal(settings.fx.available, true)
    assert.equal(settings.fx.source, 'web-fetch')
    assert.equal(settings.fx.provider, 'frankfurter.dev')
    assert.equal(settings.fx.asOf, '2026-09-11')
    assert.equal(settings.fx.error, null)
    assert.equal(settings.fx.updatedAt !== null, true)

    // The guard the panel relies on: every open on the SAME day is one request,
    // even hours apart, and it survives a reload because it is stored state.
    clock = new Date(2026, 8, 11, 21, 30, 0)
    const sameDay = await service.refreshRates()
    assert.equal(sameDay.ok, true)
    assert.equal(sameDay.refreshed, false)
    assert.equal(calls, 1)

    // The Settings button forces a fetch regardless.
    const forced = await service.refreshRates({ force: true })
    assert.equal(forced.refreshed, true)
    assert.equal(calls, 2)

    // The next local day fetches again.
    clock = new Date(2026, 8, 12, 1, 5, 0)
    const nextDay = await service.refreshRates()
    assert.equal(nextDay.refreshed, true)
    assert.equal(calls, 3)
    assert.equal(service.state().settings.fx.updatedAt, clock.toISOString())
  } finally {
    service.close()
  }
})

test('a failed refresh keeps the last good rates and records why', async () => {
  const dir = scratch()
  const service = new PortfolioService({
    dataDir: dir,
    dotenvPath: join(dir, '.env'),
    web: () => makeWeb({ fetch: async () => { throw new Error('offline') } }),
  })
  try {
    const outcome = await service.refreshRates({ force: true })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.refreshed, true)
    assert.equal(outcome.failures.length, FX_ENDPOINTS.length + 1)
    const settings = service.state().settings
    // The shipped default pair is untouched, and the page can say so.
    assert.deepEqual(settings.rates, { HKD: 7.8, CNY: 7.15 })
    assert.equal(settings.fx.source, 'default')
    assert.match(settings.fx.error, /offline/)
  } finally {
    service.close()
  }
})

test('a hand-typed pair is labelled manual, and does not suppress the next refresh', async () => {
  const dir = scratch()
  let calls = 0
  const service = new PortfolioService({
    dataDir: dir,
    dotenvPath: join(dir, '.env'),
    web: () => makeWeb({
      fetch: async () => {
        calls += 1
        return fetched({ base: 'USD', date: '2026-09-11', rates: { CNY: 6.7082, HKD: 7.842 } })
      },
    }),
  })
  try {
    service.updateSettings({ usdHkd: 7.75, usdCny: 7.05 })
    const typed = service.state().settings
    assert.deepEqual(typed.rates, { HKD: 7.75, CNY: 7.05 })
    assert.equal(typed.fx.source, 'manual')
    assert.equal(typed.fx.updatedAt !== null, true)

    // The guard only covers fetched rates: a manual pair is what the next open is
    // meant to replace, so it must not debounce the fetch away.
    const outcome = await service.refreshRates()
    assert.equal(outcome.refreshed, true)
    assert.equal(calls, 1)
    assert.deepEqual(service.state().settings.rates, { HKD: 7.842, CNY: 6.7082 })
    assert.equal(service.state().settings.fx.source, 'web-fetch')
  } finally {
    service.close()
  }
})
