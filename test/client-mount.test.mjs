/**
 * The mention pane, mounted in a real DOM.
 *
 * `test/client-render.test.mjs` renders to a string, which is enough for copy and
 * structure and says nothing about EFFECTS — and the pane's whole content arrives
 * through one: the series is fetched from `/bars` after mount, and the chart and
 * the measured windows only exist once that request settles. A pane that renders
 * its header and then sits on "正在读取…" looks correct in a static render and is
 * exactly the failure a user reports as "the detail is missing".
 *
 * So this file mounts the real bundle with `react-dom/client` under jsdom,
 * answers the two endpoints the pane calls, and asserts what a user would see.
 * The REST of the suite stays DOM-free; only these cases need one.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

import { computeSymbolStats } from '../lib/index.js'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const SOURCE = readFileSync(BUNDLE, 'utf8')

/** One day of the synthetic series, in milliseconds. */
const DAY = 86_400_000

/**
 * Install a jsdom document as this process's DOM.
 *
 * The bundle reads `document` while it is evaluated (it injects its stylesheet)
 * and the pane reads it again on every render, so the globals have to exist
 * before the factory runs, not merely before the mount.
 * @returns the window the tests mount into.
 */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
  const window = dom.window
  const globals = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  }
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return window
}

/**
 * Evaluate the client bundle against the installed DOM.
 * @param window - the jsdom window the bundle's module loader hangs off.
 * @returns the browser half's exports.
 */
function loadClient(window) {
  let registration
  window.__ModuleLoader__ = { load: value => { registration = value } }
  // eslint-disable-next-line no-new-func -- the artifact under test is a script by construction.
  new Function('window', 'document', SOURCE)(window, window.document)
  const icon = () => null
  return registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => icon })
    throw new Error(`client-modules: require("${specifier}") missed the module table`)
  })
}

/** A rising-then-falling series ending on the portfolio's newest trading day. */
const BARS = Array.from({ length: 70 }, (_, index) => {
  const close = index < 50 ? 1290 - index * 2.4 : 1170 + (index - 50) * 3.1
  return {
    date: new Date(Date.UTC(2026, 8, 10) - (69 - index) * DAY).toISOString().slice(0, 10),
    high: close + 12,
    low: close - 12,
    close,
    volume: 2_000_000 + index * 50_000,
  }
})

/** One held symbol: enough of a position and a trade to render a card. */
function heldSymbol(symbol, name, currency, price) {
  const cost = price * 1.04
  return {
    trade: {
      id: symbol.length, symbol, exchange: symbol.slice(symbol.lastIndexOf('.') + 1), currency, name,
      side: 'buy', quantity: 100, price: cost, tradedAt: '2026-09-08', motive: null, note: null,
      createdAt: '2026-09-08T02:00:00.000Z',
    },
    position: {
      symbol, exchange: symbol.slice(symbol.lastIndexOf('.') + 1), currency, name, quantity: 100,
      avgCost: cost, costBasis: cost * 100, price, prevClose: price * 1.01, priceDate: '2026-09-10',
      marketValue: price * 100, unrealizedPnl: price * 100 - cost * 100, unrealizedPct: -0.038,
      dayPnl: -price, dayPnlPct: -0.0099, realizedPnl: 0, tradeCount: 1, firstTradeAt: '2026-09-08',
      lastTradeAt: '2026-09-08', holdingDays: 3, weight: 1,
    },
  };
}

/** Three held symbols: the case a single-symbol pane hid a crash for. */
const HELD = [
  heldSymbol('00001.HK', '长和', 'HKD', 66.66),
  heldSymbol('600519.SH', '贵州茅台', 'CNY', 1170),
  heldSymbol('AAPL.US', '苹果', 'USD', 326.57),
]

/** The portfolio the pane resolves a mention against. */
const STATE = {
  trades: HELD.map(entry => entry.trade),
  positions: HELD.map(entry => entry.position),
  closed: [],
  quotes: [],
  stats: {
    baseCurrency: 'CNY', totalMarketValue: 117_000, totalCost: 126_850, totalUnrealizedPnl: -9850,
    totalUnrealizedPct: -0.0777, totalRealizedPnl: 0, totalPnl: -9850, totalPnlPct: -0.0777,
    dayPnl: -1000, dayPnlPct: -0.0085, openPositions: 3, closedPositions: 0, tradeCount: 3,
    unrealizedWinners: 0, unrealizedLosers: 1, grossUnrealizedGain: 0, grossUnrealizedLoss: -9850,
    topWeight: 1, topSymbol: '600519.SH', topThreeWeight: 1, avgHoldingDays: 3, longestHoldingDays: 3,
    holdingSince: '2026-09-08', winRate: null, avgWin: null, avgLoss: null, profitFactor: null,
    bestSymbol: null, worstSymbol: null, byMarket: [], byMotive: [], native: [],
    rates: { USD: 1, HKD: 7.8, CNY: 7.15 },
  },
  settings: {
    apiKeyConfigured: false, apiKeySource: 'none', baseCurrency: 'CNY', rates: { HKD: 7.8, CNY: 7.15 },
    fx: { available: true, source: 'default', provider: null, updatedAt: null, asOf: null, error: null },
    refreshIntervalMinutes: 360, autoRefresh: true, mentionPopup: true, dbPath: '~/.dsh/portfolio.db',
    instrumentCount: 23_450, instrumentsSyncedAt: null,
  },
  feed: {
    baseUrl: 'https://free-api.tickflow.org', apiKeySource: 'none', batchSupported: true,
    lastError: null, lastRefreshAt: null, unresolved: [], latestDate: '2026-09-10',
  },
  motives: [],
  generatedAt: '2026-09-11T00:00:00.000Z',
}

/**
 * Mount the mention pane and let its effects settle.
 * @param options - `bars` overrides the series the stub serves, `mentions` the feed.
 * @returns the rendered markup plus every request the pane made.
 */
async function mountPane(options = {}) {
  const window = installDom()
  const client = loadClient(window)
  const requests = []
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost')
    requests.push(`${parsed.pathname}${parsed.search}`)
    const series = options.bars ?? BARS
    const body = parsed.pathname.endsWith('/bars')
      ? {
          symbol: parsed.searchParams.get('symbol') ?? '',
          bars: series,
          stats: computeSymbolStats(series),
        }
      : STATE
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }

  const snapshot = {
    state: options.state === undefined ? STATE : options.state,
    mentions: options.mentions ?? [{
      rev: 1, source: 'assistant', at: Date.now() - 60_000,
      symbols: ['600519.SH'], excerpt: '…600519.SH 的成本…',
    }],
    mentionSession: 'session-1',
  }
  const store = { load: async () => {}, dispose: () => {}, watchSession: () => {} }
  const root = createRoot(window.document.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(client.MentionsPanel, {
      store,
      sessionId: 'session-1',
      usePortfolio: selector => selector(snapshot),
    }))
    // One turn of the event loop for the series request to settle inside act().
    await new Promise(resolve => { setTimeout(resolve, 30) })
  })
  const html = window.document.getElementById('root').innerHTML
  await act(async () => { root.unmount() })
  return { html, requests }
}

// jsdom is the one dependency in this suite that has to be installed; without it
// the cases below would silently assert against a string render instead.
test('the pane draws the series after it loads, not just its placeholders', async () => {
  const { html, requests } = await mountPane()

  // The fetch is the pane's own: one request per symbol, no round trip per render.
  assert.deepEqual(requests, ['/dsh-stock-portfolio/api/bars?symbol=600519.SH&limit=160'])
  assert.ok(!html.includes('正在读取'), 'the pane never left its loading state')

  // The reused detail block: the chart, with its volume columns, the cost line,
  // and the trade markers the holdings row draws.
  assert.ok(html.includes('class="dsp-chart dsp-chart-compact"'), 'no chart')
  assert.ok(html.includes('dsp-chart-vol'), 'no volume columns')
  assert.ok(html.includes('dsp-chart-cost'), 'no cost line')
  assert.ok(html.includes('<polygon'), 'no trade marker')
  // And the measurements beside it.
  for (const label of ['区间涨跌幅', '波动与量能', '3 日', '15 日', '30 日', '60 日', '20 日波动率', '量比', '60 日最大回撤']) {
    assert.ok(html.includes(label), `the detail block is missing ${label}`)
  }
  // The position's own numbers close the card, and the pane says why it is here.
  for (const label of ['持仓', '成本价', '收盘价', '当日盈亏', '市值', '浮动盈亏', '仓位占比', '已实现盈亏', '持有天数']) {
    assert.ok(html.includes(label), `the holding strip is missing ${label}`)
  }
  // The provenance line is gone: the pane is open, so the reason is not news.
  assert.ok(!html.includes('提到过它'))
  assert.ok(!html.includes('…600519.SH 的成本…'))
  // Nothing to clear: the pane follows the conversation, it is not a list to tidy.
  assert.ok(!html.includes('清空'), 'the clear button is still there')
  assert.ok(!html.includes('NaN'))
})

test('the empty pane, and a pane with no series yet, both still render', async () => {
  const empty = await mountPane({ mentions: [] })
  assert.ok(empty.html.includes('还没有提到持仓标的'))
  assert.deepEqual(empty.requests, [], 'an empty pane asks for nothing')

  const blank = await mountPane({ bars: [] })
  assert.ok(blank.html.includes('还没有可画的日线'))
  assert.ok(blank.html.includes('成本价'), 'the holding numbers survive a missing series')

  // A portfolio that has not loaded yet blocks the card rather than showing a
  // half-filled one.
  const loading = await mountPane({ state: null })
  assert.ok(loading.html.includes('正在读取持仓数据'))
})

test('three mentioned symbols each get their own chart and numbers', async () => {
  // The case that a one-symbol pane hid: a pane whose tab is restored mounts
  // before its session is watched, and an early return above the series loader
  // made the NEXT render call one hook more than the first — React throws on
  // that, and the whole pane goes with it: no chart, no statistics, no column.
  const { html, requests } = await mountPane({
    mentions: [
      { rev: 1, source: 'user', at: Date.now() - 120_000, symbols: ['600519.SH'], excerpt: '…' },
      { rev: 2, source: 'assistant', at: Date.now() - 60_000, symbols: ['AAPL.US', '00001.HK'], excerpt: '…' },
    ],
  })

  // One series request per mentioned symbol, newest conversation first.
  assert.equal(requests.length, 3)
  for (const symbol of ['00001.HK', 'AAPL.US', '600519.SH']) {
    assert.ok(requests.some(url => url.includes(`symbol=${symbol}`)), `no series was asked for ${symbol}`)
  }

  // Three cards, and EVERY card carries the reused detail block: the chart with
  // its volume columns and cost line, plus the measured windows.
  assert.equal((html.match(/dsp-mention-card/g) ?? []).length, 3)
  assert.equal((html.match(/class="dsp-chart dsp-chart-compact"/g) ?? []).length, 3)
  assert.equal((html.match(/dsp-chart-vol/g) ?? []).length, 3 * BARS.length)
  assert.equal((html.match(/dsp-chart-cost/g) ?? []).length, 3)
  for (const label of ['区间涨跌幅', '20 日波动率', '60 日最大回撤', '浮动盈亏', '持有天数']) {
    assert.ok(html.includes(label), `the cards are missing ${label}`)
  }
  assert.ok(!html.includes('提到过它'), 'the provenance line is gone')

  // Each header leads with the position's result — amount, ratio, holding
  // period — and leaves the price to the chart and the statistics below it.
  const headers = html.match(/<header class="dsp-mention-head">[\s\S]*?<\/header>/gu) ?? []
  assert.equal(headers.length, 3)
  for (const header of headers) {
    assert.ok(header.includes('-3.80%'), `no ratio in: ${header}`)
    assert.ok(header.includes('持有 3 天'), `no holding period in: ${header}`)
    assert.ok(header.includes('dsp-down'), 'a loss must carry the down tone')
    assert.ok(!header.includes('1,170.00'), 'the header still repeats the price')
    assert.ok(!header.includes('2026-09-10'), 'the header still repeats the price date')
  }
  // Twice per card, and neither is the header: the chart's x-axis ends on that
  // day, and the 收盘价 statistic says which close it is quoting.
  assert.equal((html.match(/2026-09-10/g) ?? []).length, 3 * 2, 'the date belongs to the chart and the price statistic')

  // A mentioned symbol nobody holds still renders, from its trade log alone.
  const unheld = await mountPane({
    mentions: [{ rev: 1, source: 'user', at: Date.now(), symbols: ['600519.SH', 'MSFT.US'], excerpt: '…' }],
  })
  assert.equal((unheld.html.match(/dsp-mention-card/g) ?? []).length, 2)
})

test('a pane restored before its session is watched survives the first answers', async () => {
  // The exact crash: a refresh with the 「持仓提及」 tab already open mounts the
  // pane while the store has no feed and no session yet, and the answers arrive
  // one render later. A hook called only after the loading guard makes that
  // second render illegal — React throws, and the user sees a dead column.
  const window = installDom()
  const client = loadClient(window)

  const requests = []
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url), 'http://localhost')
    requests.push(`${parsed.pathname}${parsed.search}`)
    const body = parsed.pathname.endsWith('/bars')
      ? { symbol: parsed.searchParams.get('symbol') ?? '', bars: BARS, stats: computeSymbolStats(BARS) }
      : STATE
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }

  let push = null
  const store = {
    // The portfolio arrives with the first load…
    load: async () => { push?.(current => ({ ...current, state: STATE })) },
    // …and the conversation with the first poll.
    watchSession: () => { push?.(current => ({ ...current, mentionSession: 'session-1' })) },
    dispose: () => {},
  }

  function Harness() {
    const [snapshot, setSnapshot] = React.useState({ state: null, mentions: [], mentionSession: null })
    push = setSnapshot
    return React.createElement(client.MentionsPanel, {
      store,
      sessionId: 'session-1',
      usePortfolio: selector => selector(snapshot),
    })
  }

  const errors = []
  const root = createRoot(window.document.getElementById('root'))
  const onError = (error) => { errors.push(String((error && error.message) || error)) }
  process.on('uncaughtException', onError)
  try {
    await act(async () => {
      root.render(React.createElement(Harness))
      await new Promise(resolve => { setTimeout(resolve, 30) })
    })
    // The feed answers a moment later: one symbol, then a second one.
    await act(async () => {
      push?.(current => ({
        ...current,
        mentions: [{ rev: 1, source: 'user', at: Date.now(), symbols: ['600519.SH'], excerpt: '…' }],
      }))
      await new Promise(resolve => { setTimeout(resolve, 40) })
    })

    const html = window.document.getElementById('root').innerHTML
    assert.deepEqual(errors, [], `React reported: ${errors.join(' | ')}`)
    assert.equal((html.match(/dsp-mention-card/g) ?? []).length, 1)
    assert.ok(html.includes('dsp-chart-vol'), 'the chart is missing after the late answer')
    assert.ok(html.includes('区间涨跌幅'), 'the statistics are missing after the late answer')
  } finally {
    process.off('uncaughtException', onError)
    await act(async () => { root.unmount() })
  }
})
