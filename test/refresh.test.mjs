/**
 * When the plugin talks to the provider, and how much it asks for.
 *
 * Daily bars are end-of-day — day D's bar is served on D+1 — so a portfolio whose
 * newest bar is already the last published trading day has nothing to collect.
 * These cases pin that rule down from the outside: what gets requested, with what
 * range, and how often. The provider is a stub that honours `start_time` the way
 * the real endpoint does (a lower bound, newest `count` bars of the range), so the
 * assertions are about the request the plugin would really send.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { PortfolioService } from '../lib/index.js'

/** A Thursday; the newest published bar is therefore Wednesday 2026-09-09. */
const THURSDAY = new Date(2026, 8, 10, 12, 0, 0)

/** The dates the stub serves per symbol, oldest first. */
const SERIES = {
  '00700.HK': [['2026-09-03', 410.0], ['2026-09-04', 415.0], ['2026-09-07', 420.0], ['2026-09-08', 425.6], ['2026-09-09', 428.4]],
  'AAPL.US': [['2026-09-08', 318.2], ['2026-09-09', 326.57]],
}

/** Everything a case opened, torn down when the file finishes. */
const opened = []

/**
 * Turn `[date, close]` pairs into the columnar shape the provider returns.
 * @param pairs - the series.
 * @returns the `CompactKlineData` object.
 */
function columnar(pairs) {
  return {
    timestamp: pairs.map(([date]) => Date.parse(`${date}T00:00:00Z`)),
    open: pairs.map(([, close]) => close),
    high: pairs.map(([, close]) => close),
    low: pairs.map(([, close]) => close),
    close: pairs.map(([, close]) => close),
    volume: pairs.map(() => 1000),
    amount: pairs.map(() => 0),
  }
}

/**
 * Build a service over a throwaway database, with a recording provider stub.
 * @param options - `now` overrides the clock; `series` overrides the served bars.
 * @returns the service, the recorded requests, and a clock setter.
 */
function makeService(options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsp-refresh-'))
  const calls = []
  let now = options.now ?? THURSDAY
  const series = options.series ?? SERIES
  const stub = async (input) => {
    const url = new URL(String(input))
    const json = body => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) })
    if (url.pathname === '/v1/klines/batch') {
      const since = url.searchParams.get('start_time')
      const floor = since === null ? null : Number(since)
      const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
      const data = {}
      for (const symbol of symbols) {
        const rows = (series[symbol] ?? [])
          .filter(([date]) => floor === null || Date.parse(`${date}T00:00:00Z`) >= floor)
        if (rows.length > 0) data[symbol] = columnar(rows)
      }
      return json({ data })
    }
    // The name index and the exchange list are not what these cases are about;
    // answering them keeps the background parts of a refresh quiet.
    if (url.pathname === '/v1/instruments') return json({ data: [] })
    if (url.pathname === '/v1/exchanges') return json({ data: [] })
    return new Response('not found', { status: 404 })
  }
  const service = new PortfolioService({
    dataDir, fetchImpl: stub, dotenvPath: join(dataDir, '.env'), now: () => now,
  })
  opened.push({ service, dataDir })
  return {
    service,
    calls,
    klineCalls: () => calls.filter(call => call.path.startsWith('/v1/klines')),
    at: (when) => { now = when },
  }
}

/**
 * Record one holding directly in the log, without going through `addTrade`
 * (which would fetch a history of its own).
 * @param service - the service.
 * @param symbol - canonical symbol.
 * @param tradedAt - the trade date.
 */
function hold(service, symbol, tradedAt = '2026-08-03') {
  service.db.insertTrade({
    symbol,
    exchange: symbol.slice(symbol.lastIndexOf('.') + 1),
    currency: symbol.endsWith('.HK') ? 'HKD' : symbol.endsWith('.US') ? 'USD' : 'CNY',
    name: null,
    side: 'buy',
    quantity: 100,
    price: 400,
    tradedAt,
    motive: null,
    note: null,
  })
}

after(() => {
  for (const { service, dataDir } of opened) {
    service.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a series holding the newest published bar costs no request', async () => {
  const { service, klineCalls } = makeService()
  hold(service, '00700.HK')
  // 2026-09-09 is the newest bar the provider can have published on the 10th.
  service.db.upsertPrices([
    { symbol: '00700.HK', date: '2026-09-08', open: 1, high: 1, low: 1, close: 425.6, volume: 1, amount: 0 },
    { symbol: '00700.HK', date: '2026-09-09', open: 1, high: 1, low: 1, close: 428.4, volume: 1, amount: 0 },
  ])

  assert.equal(await service.refresh(false), false, 'nothing to collect')
  assert.deepEqual(klineCalls(), [])
  assert.equal(service.state().feed.latestDate, '2026-09-09')
})

test('a series behind by a few days asks only for the gap', async () => {
  const { service, klineCalls } = makeService()
  hold(service, '00700.HK')
  service.db.upsertPrices([
    { symbol: '00700.HK', date: '2026-09-03', open: 1, high: 1, low: 1, close: 410, volume: 1, amount: 0 },
    { symbol: '00700.HK', date: '2026-09-04', open: 1, high: 1, low: 1, close: 415, volume: 1, amount: 0 },
  ])

  assert.equal(await service.refresh(false), true)
  assert.equal(klineCalls().length, 1, 'one batch, one request')
  assert.equal(klineCalls()[0].params.symbols, '00700.HK')
  assert.equal(klineCalls()[0].params.start_time, String(Date.parse('2026-09-05T00:00:00Z')))
  assert.equal(klineCalls()[0].params.count, '260', 'the range is bounded by the year we keep')
  // The gap came back, and the bars already held are untouched.
  assert.deepEqual(
    service.db.readCloses(['00700.HK']).get('00700.HK').map(bar => bar.date),
    ['2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09'],
  )
  assert.equal(service.state().feed.latestDate, '2026-09-09')

  // Now that it is current, the next check asks for nothing.
  assert.equal(await service.refresh(false), false)
  assert.equal(klineCalls().length, 1)
})

test('two symbols with different gaps travel in one request, from the earliest gap', async () => {
  const { service, klineCalls } = makeService()
  hold(service, '00700.HK')
  hold(service, 'AAPL.US')
  service.db.upsertPrices([
    { symbol: '00700.HK', date: '2026-09-04', open: 1, high: 1, low: 1, close: 415, volume: 1, amount: 0 },
    { symbol: 'AAPL.US', date: '2026-09-08', open: 1, high: 1, low: 1, close: 318.2, volume: 1, amount: 0 },
  ])

  assert.equal(await service.refresh(false), true)
  assert.equal(klineCalls().length, 1)
  assert.deepEqual(klineCalls()[0].params.symbols.split(','), ['00700.HK', 'AAPL.US'])
  assert.equal(klineCalls()[0].params.start_time, String(Date.parse('2026-09-05T00:00:00Z')))
  assert.equal(service.state().feed.latestDate, '2026-09-09')
})

test('a day the provider has nothing new is asked about once', async () => {
  // The stub serves nothing past 2026-09-04, which is what a market holiday
  // looks like from here: the series stays behind, and the watermark is the only
  // thing standing between that and a request on every open.
  const { service, klineCalls, at } = makeService({
    series: { '00700.HK': [['2026-09-03', 410.0], ['2026-09-04', 415.0]] },
  })
  hold(service, '00700.HK')
  service.db.upsertPrices([
    { symbol: '00700.HK', date: '2026-09-04', open: 1, high: 1, low: 1, close: 415, volume: 1, amount: 0 },
  ])

  assert.equal(await service.refresh(false), true)
  assert.equal(klineCalls().length, 1)
  assert.equal(await service.refresh(false), false, 'asked once today')
  assert.equal(await service.refresh(false), false)
  assert.equal(klineCalls().length, 1)

  // The next day the question is worth asking again.
  at(new Date(2026, 8, 11, 9, 30, 0))
  assert.equal(await service.refresh(false), true)
  assert.equal(klineCalls().length, 2)
})

test('a symbol that has never been priced asks for the recent window', async () => {
  const { service, klineCalls, calls } = makeService()
  hold(service, '600519.SH')

  assert.equal(await service.refresh(false), true)
  assert.equal(klineCalls().length, 1)
  // 90 days before the clock, because there is no gap to speak of.
  assert.equal(
    klineCalls()[0].params.start_time,
    String(THURSDAY.getTime() - 90 * 86_400_000),
  )
  // The provider does not carry it, so it is reported as unresolved — and a
  // series that came back empty because it is merely current is not.
  assert.deepEqual(service.state().feed.unresolved, ['600519.SH'])
  assert.ok(calls.every(call => call.path.startsWith('/v1/')))
})

test('force reads the whole history instead of the gap', async () => {
  const { service, klineCalls } = makeService()
  hold(service, '00700.HK')
  service.db.upsertPrices([
    { symbol: '00700.HK', date: '2026-09-09', open: 1, high: 1, low: 1, close: 428.4, volume: 1, amount: 0 },
  ])

  assert.equal(await service.refresh(true), true, 'the button does not consult the stored dates')
  assert.equal(klineCalls().length, 1)
  assert.equal(klineCalls()[0].params.start_time, undefined)
  assert.equal(klineCalls()[0].params.count, '260')
})

test('callers that arrive together share one request', async () => {
  const { service, klineCalls } = makeService()
  hold(service, '00700.HK')

  const [first, second] = await Promise.all([service.refresh(false), service.refresh(false)])
  assert.equal(klineCalls().length, 1)
  assert.deepEqual([first, second].sort(), [false, true], 'one caller did the work, the other rode it')
})
