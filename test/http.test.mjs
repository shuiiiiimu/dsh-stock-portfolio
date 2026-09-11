/**
 * The HTTP surface, exercised over a real socket with a stubbed market-data
 * provider.
 *
 * The stub is the point: every case here runs offline and deterministically, so
 * the suite asserts the plugin's own contract — status codes, normalization,
 * what a rejected trade leaves behind, and that a settings write never echoes the
 * key — rather than TickFlow's uptime.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { API_PREFIX, PortfolioService, createRouter } from '../lib/index.js'

/** Daily closes the stub serves, by symbol: [date, close] newest last. */
const SERIES = {
  '00700.HK': [['2026-09-08', 420.0], ['2026-09-09', 425.6], ['2026-09-10', 428.4]],
  'AAPL.US': [['2026-09-08', 318.2], ['2026-09-09', 315.34], ['2026-09-10', 326.57]],
  '600000.SH': [['2026-09-08', 9.4], ['2026-09-09', 9.35], ['2026-09-10', 9.26]],
  '510300.SH': [['2026-09-08', 4.6], ['2026-09-09', 4.617], ['2026-09-10', 4.579]],
  '000300.SH': [['2026-09-08', 4548.39], ['2026-09-09', 4548.39], ['2026-09-10', 4510.15]],
}

/** The instrument inventory the stub serves, by exchange. */
const INVENTORY = {
  SH: [
    { symbol: '600000.SH', exchange: 'SH', code: '600000', name: '浦发银行', type: 'stock' },
    { symbol: '510300.SH', exchange: 'SH', code: '510300', name: '沪深300ETF华泰柏瑞', type: 'etf' },
    { symbol: '000300.SH', exchange: 'SH', code: '000300', name: '沪深300', type: 'index' },
  ],
  SZ: [{ symbol: '000001.SZ', exchange: 'SZ', code: '000001', name: '平安银行', type: 'stock' }],
  BJ: [],
  HK: [{ symbol: '00700.HK', exchange: 'HK', code: '00700', name: '腾讯控股', type: 'stock' }],
  US: [{ symbol: 'AAPL.US', exchange: 'US', code: 'AAPL', name: '苹果', type: 'stock' }],
}

/**
 * Turn a columnar bar list into the wire shape TickFlow returns.
 * @param series - `[date, close]` pairs.
 * @returns the `CompactKlineData` object.
 */
function columnar(series) {
  return {
    timestamp: series.map(([date]) => Date.parse(`${date}T00:00:00Z`)),
    open: series.map(([, close]) => close),
    high: series.map(([, close]) => close),
    low: series.map(([, close]) => close),
    close: series.map(([, close]) => close),
    volume: series.map(() => 1000),
    amount: series.map(() => 0),
  }
}

/**
 * Build a fetch stand-in that answers only the endpoints this plugin calls.
 * @param options - `denyBatch` makes `/v1/klines/batch` answer the 403 a keyed
 * plan without the batch entitlement receives.
 * @returns the fetch function.
 */
function makeStub(options = {}) {
  return async (input) => {
  const url = new URL(String(input))
  const json = body => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  if (url.pathname === '/v1/klines/batch') {
    if (options.denyBatch === true) {
      return new Response(JSON.stringify({
        code: 'NO_KLINE_BATCH_PERMISSION', message: '无日/周/月K线查询批量查询权限',
      }), { status: 403, headers: { 'content-type': 'application/json' } })
    }
    const wanted = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
    const data = {}
    for (const symbol of wanted) if (SERIES[symbol]) data[symbol] = columnar(SERIES[symbol])
    return json({ data })
  }
  if (url.pathname === '/v1/klines') {
    const symbol = url.searchParams.get('symbol') ?? ''
    return json({ data: SERIES[symbol] ? columnar(SERIES[symbol]) : {} })
  }
  if (url.pathname === '/v1/exchanges') {
    return json({
      data: [
        { exchange: 'HK', region: 'HK', count: 1 },
        { exchange: 'US', region: 'US', count: 1 },
        { exchange: 'SH', region: 'CN', count: 3 },
        { exchange: 'SZ', region: 'CN', count: 1 },
        { exchange: 'BJ', region: 'CN', count: 0 },
      ],
    })
  }
  const inventory = /^\/v1\/exchanges\/([A-Z]+)\/instruments$/u.exec(url.pathname)
  if (inventory !== null) {
    const rows = INVENTORY[inventory[1]] ?? []
    return json({ exchange: inventory[1], count: rows.length, data: rows })
  }
  if (url.pathname === '/v1/instruments') {
    const wanted = (url.searchParams.get('symbols') ?? '').split(',')
    const all = Object.values(INVENTORY).flat()
    return json({ data: all.filter(row => wanted.includes(row.symbol)) })
  }
  return new Response('not found', { status: 404 })
  }
}

/** The default stub: batch is permitted. */
const stubFetch = makeStub()

let service
let server
let base
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'dsp-http-'))
  // Point `.env` at a path that does not exist: the developer's own file must
  // never change what these cases assert.
  service = new PortfolioService({ dataDir, fetchImpl: stubFetch, dotenvPath: join(dataDir, '.env') })
  server = createServer(createRouter(service, () => false))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`
})

after(async () => {
  await new Promise(resolve => { server.close(resolve) })
  service.close()
  rmSync(dataDir, { recursive: true, force: true })
})

/**
 * Call one endpoint.
 * @param path - path below the API prefix.
 * @param init - fetch options.
 * @returns the status and decoded body.
 */
async function call(path, init) {
  const response = await fetch(`${base}${path}`, {
    headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
    ...init,
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

/** A valid A-share trade payload. */
const SAMPLE = {
  symbol: '600000',
  side: 'buy',
  quantity: 1000,
  price: 9,
  tradedAt: '2026-06-01',
  motive: '低估值买入',
  note: null,
}

test('an empty store answers with a complete, renderable snapshot', async () => {
  const { status, body } = await call('/state')
  assert.equal(status, 200)
  assert.deepEqual(body.trades, [])
  assert.deepEqual(body.positions, [])
  assert.equal(body.stats.totalMarketValue, 0)
  assert.equal(body.settings.apiKeyConfigured, false)
  // CNY is the default base: a fresh install reports in 人民币 until the user says
  // otherwise, and the shipped rate pair is labelled as the placeholder it is.
  assert.equal(body.settings.baseCurrency, 'CNY')
  assert.equal(body.settings.fx.source, 'default')
  assert.equal(body.settings.fx.available, false)
  assert.equal(body.settings.fx.updatedAt, null)
  assert.equal(body.settings.fx.error, null)
  assert.deepEqual(body.settings.rates, { HKD: 7.8, CNY: 7.15 })
  assert.equal(body.settings.instrumentCount, 0)
  assert.equal(body.feed.latestDate, null)
})

test('a trade is normalized on the way in, for any market', async () => {
  const a = await call('/trades', { method: 'POST', body: JSON.stringify(SAMPLE) })
  assert.equal(a.status, 201)
  // The host owns exchange and currency; the browser never sends them.
  assert.equal(a.body.trade.symbol, '600000.SH')
  assert.equal(a.body.trade.exchange, 'SH')
  assert.equal(a.body.trade.currency, 'CNY')

  const hk = await call('/trades', {
    method: 'POST',
    body: JSON.stringify({ ...SAMPLE, symbol: '700', quantity: 100, price: 400, tradedAt: '2026-06-02' }),
  })
  assert.equal(hk.body.trade.symbol, '00700.HK')
  assert.equal(hk.body.trade.currency, 'HKD')

  const us = await call('/trades', {
    method: 'POST',
    body: JSON.stringify({ ...SAMPLE, symbol: 'AAPL.US', quantity: 10, price: 200, tradedAt: '2026-06-03' }),
  })
  assert.equal(us.body.trade.currency, 'USD')
  assert.equal(us.body.state.trades.length, 3)
})

test('an ETF and an index are ordinary symbols, not special cases', async () => {
  const etf = await call('/trades', {
    method: 'POST',
    body: JSON.stringify({ ...SAMPLE, symbol: '510300.SH', quantity: 1000, price: 4.6, tradedAt: '2026-06-04' }),
  })
  assert.equal(etf.status, 201)
  assert.equal(etf.body.trade.symbol, '510300.SH')
  // The bare index code is genuinely ambiguous and resolves to Shenzhen by shape;
  // the explicit suffix is what settles it.
  const index = await call('/trades', {
    method: 'POST',
    body: JSON.stringify({ ...SAMPLE, symbol: '000300.SH', quantity: 1, price: 4500, tradedAt: '2026-06-05' }),
  })
  assert.equal(index.body.trade.symbol, '000300.SH')
})

test('the holdings table is materialized on every write', async () => {
  const { body } = await call('/holdings')
  const sh = body.holdings.find(row => row.symbol === '600000.SH')
  assert.equal(sh.quantity, 1000)
  assert.equal(sh.avgCost, 9)
  assert.equal(sh.exchange, 'SH')
  assert.equal(sh.currency, 'CNY')
})

test('an oversell is refused and changes nothing', async () => {
  const before = (await call('/state')).body.trades.length
  const { status, body } = await call('/trades', {
    method: 'POST',
    body: JSON.stringify({ ...SAMPLE, side: 'sell', quantity: 5_000_000, tradedAt: '2026-06-06' }),
  })
  assert.equal(status, 400)
  assert.match(body.error, /超过/)
  assert.equal((await call('/state')).body.trades.length, before)
})

test('a malformed field names itself', async () => {
  const { status, body } = await call('/trades', {
    method: 'POST',
    body: JSON.stringify({ ...SAMPLE, quantity: 'many' }),
  })
  assert.equal(status, 400)
  assert.match(body.error, /quantity|数量/)
})

test('an edit recomputes the derived numbers, and a delete restores the log', async () => {
  // TSLA.US is touched by no other case, so the position reads as this log alone.
  const created = await call('/trades', {
    method: 'POST',
    body: JSON.stringify({ ...SAMPLE, symbol: 'TSLA.US', quantity: 10, price: 200, tradedAt: '2026-07-15' }),
  })
  const id = created.body.trade.id
  const updated = await call(`/trades/${String(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ ...SAMPLE, symbol: 'TSLA.US', quantity: 20, price: 200, tradedAt: '2026-07-15' }),
  })
  assert.equal(updated.status, 200)
  const position = updated.body.state.positions.find(row => row.symbol === 'TSLA.US')
  assert.equal(position.quantity, 20)
  assert.equal(position.costBasis, 4000)

  const removed = await call(`/trades/${String(id)}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.state.positions.some(row => row.symbol === 'TSLA.US'), false)
})

test('a missing trade id is a 404, not a silent success', async () => {
  const { status, body } = await call('/trades/99999', { method: 'DELETE' })
  assert.equal(status, 404)
  assert.match(body.error, /不存在/)
})

test('refresh stores daily bars for every held market', async () => {
  const { status, body } = await call('/refresh', { method: 'POST', body: JSON.stringify({ force: true }) })
  assert.equal(status, 200)
  assert.equal(body.feed.latestDate, '2026-09-10')
  assert.deepEqual(body.feed.unresolved, [])
  assert.equal(body.feed.lastError, null)
  assert.equal(body.feed.batchSupported, true)

  const sh = body.positions.find(row => row.symbol === '600000.SH')
  assert.equal(sh.price, 9.26)
  assert.equal(sh.prevClose, 9.35)
  assert.equal(sh.priceDate, '2026-09-10')
  // 1000 shares at 9 against a 9.26 close.
  assert.equal(Math.round(sh.unrealizedPnl * 100) / 100, 260)
  assert.equal(Math.round(sh.marketValue * 100) / 100, 9260)

  const hk = body.positions.find(row => row.symbol === '00700.HK')
  assert.equal(hk.price, 428.4)
  assert.equal(hk.currency, 'HKD')
})

test('a symbol the provider does not carry is reported, not silently dropped', async () => {
  const created = await call('/trades', {
    method: 'POST',
    body: JSON.stringify({ ...SAMPLE, symbol: 'ZZZZ.US', quantity: 1, price: 1, tradedAt: '2026-07-20' }),
  })
  const id = created.body.trade.id
  try {
    const { body } = await call('/refresh', { method: 'POST', body: JSON.stringify({ force: true }) })
    assert.ok(body.feed.unresolved.includes('ZZZZ.US'))
    const unpriced = body.positions.find(row => row.symbol === 'ZZZZ.US')
    assert.equal(unpriced.price, null)
    // Its cost still counts against the portfolio.
    assert.ok(body.stats.totalCost > 0)
  } finally {
    await call(`/trades/${String(id)}`, { method: 'DELETE' })
  }
})

test('the instrument index builds from the exchange listings and answers search', async () => {
  const { status, body } = await call('/instruments/sync', { method: 'POST', body: JSON.stringify({}) })
  assert.equal(status, 200)
  assert.equal(body.settings.instrumentCount, 6)
  assert.equal(body.settings.instrumentsSyncedAt !== null, true)

  // By name, in Chinese.
  const byName = await call(`/lookup?q=${encodeURIComponent('腾讯')}`)
  assert.equal(byName.body.matches[0].symbol, '00700.HK')
  assert.equal(byName.body.matches[0].name, '腾讯控股')

  // By bare code prefix.
  const byCode = await call('/lookup?q=600000')
  assert.equal(byCode.body.matches[0].symbol, '600000.SH')

  // An index found by name even though its bare code is ambiguous.
  const byIndexName = await call(`/lookup?q=${encodeURIComponent('沪深300')}`)
  assert.ok(byIndexName.body.matches.some(row => row.symbol === '000300.SH'))
})

test('names resolve onto trades once the index knows them', async () => {
  const { body } = await call('/state')
  const trade = body.trades.find(row => row.symbol === '00700.HK')
  assert.equal(trade.name, '腾讯控股')
})

test('the equity curve reconstructs history from the stored bars', async () => {
  const { status, body } = await call('/equity?days=3650')
  assert.equal(status, 200)
  assert.ok(body.points.length >= 2)
  const last = body.points.at(-1)
  assert.equal(last.date, '2026-09-10')
  assert.ok(last.marketValue > 0)
})

test('settings round-trip without ever echoing the key', async () => {
  const saved = await call('/settings', {
    method: 'PUT',
    body: JSON.stringify({ apiKey: 'tf-secret-value', baseCurrency: 'HKD', usdHkd: 7.75, usdCny: 7.1 }),
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.settings.apiKeyConfigured, true)
  assert.equal(saved.body.settings.apiKeySource, 'settings')
  assert.equal(saved.body.settings.baseCurrency, 'HKD')
  assert.equal(saved.body.settings.rates.HKD, 7.75)
  assert.equal(saved.body.settings.rates.CNY, 7.1)
  // The secret must not travel back over the wire in any form.
  assert.equal(JSON.stringify(saved.body).includes('tf-secret-value'), false)

  // Re-basing the portfolio changes every converted number.
  assert.equal(saved.body.state.stats.baseCurrency, 'HKD')

  const cleared = await call('/settings', { method: 'PUT', body: JSON.stringify({ apiKey: null }) })
  assert.equal(cleared.body.settings.apiKeyConfigured, false)
})

test('nonsensical settings are refused rather than silently stored', async () => {
  for (const patch of [{ usdHkd: -1 }, { usdCny: 0 }, { refreshIntervalMinutes: 5 }, { baseCurrency: 'JPY' }]) {
    const { status, body } = await call('/settings', { method: 'PUT', body: JSON.stringify(patch) })
    assert.equal(status, 400, `${JSON.stringify(patch)} should be refused`)
    assert.equal(typeof body.error, 'string')
  }
})

test('the rate-refresh endpoint answers a refusal as a result, not as an HTTP failure', async () => {
  // This composition has no `web` service mounted: the panel must be told why the
  // rates did not move, while the snapshot it renders stays valid.
  const { status, body } = await call('/rates/refresh', { method: 'POST', body: JSON.stringify({ force: true }) })
  assert.equal(status, 200)
  assert.equal(body.result.ok, false)
  assert.equal(body.result.refreshed, false)
  assert.match(body.result.error, /web/)
  assert.equal(body.state.settings.fx.available, false)
  // The rates themselves are whatever earlier writes left; a refused refresh
  // reports provenance and never invents a number.
  assert.deepEqual(body.state.settings.rates, { HKD: 7.75, CNY: 7.1 })
})

test('unknown endpoints and malformed bodies are rejected clearly', async () => {
  assert.equal((await call('/nope')).status, 404)
  const bad = await fetch(`${base}/trades`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /JSON/)
})

test('the key is picked up from .env, and the dashboard still wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-dotenv-'))
  const envPath = join(dir, '.env')
  writeFileSync(envPath, [
    '# TickFlow key for this checkout',
    'SOME_OTHER=ignored',
    'export TICKFLOW_API_KEY="tk_from_dotenv"',
    '',
  ].join('\n'))
  const local = new PortfolioService({ dataDir: dir, fetchImpl: stubFetch, dotenvPath: envPath })
  try {
    const fromFile = local.state().settings
    assert.equal(fromFile.apiKeyConfigured, true)
    assert.equal(fromFile.apiKeySource, 'dotenv')

    // The .env value is never echoed, only its presence and origin.
    assert.equal(JSON.stringify(local.state()).includes('tk_from_dotenv'), false)

    // A dashboard setting outranks the file.
    local.updateSettings({ apiKey: 'tk_from_dashboard' })
    assert.equal(local.state().settings.apiKeySource, 'settings')

    // Clearing it falls back to the file rather than to nothing.
    local.updateSettings({ apiKey: null })
    assert.equal(local.state().settings.apiKeySource, 'dotenv')
  } finally {
    local.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a key without the batch entitlement degrades to per-symbol requests', async () => {
  // Measured against the live service: the keyless host serves /v1/klines/batch,
  // while a keyed plan may answer 403 NO_KLINE_BATCH_PERMISSION. The refresh must
  // still complete, one request per symbol.
  const dir = mkdtempSync(join(tmpdir(), 'dsp-nobatch-'))
  const local = new PortfolioService({
    dataDir: dir, fetchImpl: makeStub({ denyBatch: true }), dotenvPath: join(dir, '.env'),
  })
  const server = createServer(createRouter(local, () => false))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}${API_PREFIX}`
  const post = (path, payload) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async response => await response.json())
  try {
    await post('/trades', {
      symbol: '600000.SH', side: 'buy', quantity: 100, price: 9, tradedAt: '2026-06-01',
    })
    await post('/trades', {
      symbol: '00700.HK', side: 'buy', quantity: 10, price: 400, tradedAt: '2026-06-01',
    })
    const state = await post('/refresh', { force: true })
    assert.equal(state.feed.batchSupported, false)
    assert.equal(state.feed.latestDate, '2026-09-10')
    assert.deepEqual(state.feed.unresolved, [])
    assert.equal(state.positions.find(row => row.symbol === '600000.SH').price, 9.26)
    assert.equal(state.positions.find(row => row.symbol === '00700.HK').price, 428.4)

    // The latch holds: a second refresh does not retry the refused endpoint.
    const again = await post('/refresh', { force: true })
    assert.equal(again.feed.batchSupported, false)
    assert.equal(again.feed.latestDate, '2026-09-10')
  } finally {
    await new Promise(resolve => { server.close(resolve) })
    local.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a symbol the log has just met is priced on the spot, with the recent window', async () => {
  // The panel reads its snapshot straight off the POST that created the trade, so
  // a symbol the log has never held must be valued by the time that POST answers —
  // not after the next scheduled refresh, which can be a whole interval away.
  const dir = mkdtempSync(join(tmpdir(), 'dsp-recent-'))
  const calls = []
  const recording = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/v1/klines')) calls.push(Object.fromEntries(url.searchParams))
    return await stubFetch(input, init)
  }
  const local = new PortfolioService({
    dataDir: dir, fetchImpl: recording, dotenvPath: join(dir, '.env'),
  })
  const server = createServer(createRouter(local, () => false))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}${API_PREFIX}`
  const post = (path, payload) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async response => await response.json())
  try {
    const { state } = await post('/trades', {
      symbol: '00700.HK', side: 'buy', quantity: 100, price: 400, tradedAt: '2026-09-01',
    })
    const row = state.positions.find(item => item.symbol === '00700.HK')
    assert.equal(row.price, 428.4, 'priced by the time the write answers')
    assert.equal(row.priceDate, '2026-09-10')
    assert.equal(row.marketValue, 42840)

    // One recent window for one symbol — not the full year the scheduled refresh
    // maintains, and not a request per symbol the portfolio already prices.
    assert.equal(calls.length, 1)
    assert.equal(calls[0].symbols, '00700.HK')
    assert.equal(calls[0].count, '90')

    calls.length = 0
    const again = await post('/trades', {
      symbol: '00700.HK', side: 'buy', quantity: 100, price: 410, tradedAt: '2026-09-02',
    })
    assert.deepEqual(calls, [], 'a second buy of a priced symbol asks for nothing')
    assert.equal(again.state.positions.find(item => item.symbol === '00700.HK').quantity, 200)
  } finally {
    await new Promise(resolve => { server.close(resolve) })
    local.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused history is reported, and the trade it was for is still committed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-recent-fail-'))
  const refusing = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/v1/klines')) {
      return new Response(JSON.stringify({ code: 'BOOM', message: '行情服务不可用' }), {
        status: 500, headers: { 'content-type': 'application/json' },
      })
    }
    return await stubFetch(input, init)
  }
  const local = new PortfolioService({
    dataDir: dir, fetchImpl: refusing, dotenvPath: join(dir, '.env'),
  })
  const server = createServer(createRouter(local, () => false))
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}${API_PREFIX}`
  try {
    const response = await fetch(`${origin}/trades`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: '600000.SH', side: 'buy', quantity: 100, price: 9, tradedAt: '2026-09-01' }),
    })
    const { state } = await response.json()
    assert.equal(response.status, 201, 'a provider fault is not an HTTP failure for the write')
    assert.equal(state.trades.length, 1)
    assert.equal(state.positions.find(item => item.symbol === '600000.SH').price, null)
    assert.match(state.feed.lastError, /加载 600000\.SH 最近 90 天日线失败/)
  } finally {
    await new Promise(resolve => { server.close(resolve) })
    local.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the trust fence runs before any business logic', async () => {
  const guarded = createServer(createRouter(service, (_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
    return true
  }))
  await new Promise(resolve => { guarded.listen(0, '127.0.0.1', resolve) })
  const url = `http://127.0.0.1:${guarded.address().port}${API_PREFIX}/state`
  try {
    const response = await fetch(url)
    assert.equal(response.status, 401)
    assert.equal(await response.text(), 'unauthorized')
  } finally {
    await new Promise(resolve => { guarded.close(resolve) })
  }
})
