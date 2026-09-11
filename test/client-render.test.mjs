/**
 * The dashboard's render smoke test.
 *
 * `test/client-bundle.test.mjs` proves the bundle LOADS; this file proves the
 * tabs MOUNT. The two failure modes it exists for both look like nothing until a
 * user opens the panel: a JSX prop the primitives reject, and a read off a value
 * that only exists once data arrives (`stats.topSymbol`, `stats.returns`, a row
 * with no bars yet).
 *
 * The markup comes from React's own server renderer against the real bundle, and
 * the numbers come from the real host half — `derivePortfolio` and
 * `computeSymbolStats` — so a fixture cannot agree with a client that has drifted
 * away from the host.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

import { computeSymbolStats, derivePortfolio, rateTable } from '../lib/index.js'

const BUNDLE = new URL('../lib/client.js', import.meta.url)
const SOURCE = readFileSync(BUNDLE, 'utf8')

/** A fixed "now", so the holding-day counts in the markup never drift. */
const NOW = new Date('2026-09-11T12:00:00.000Z')

/**
 * Load the bundle and hand back its module exports.
 * @returns the plugin the browser half registers.
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
  const run = new Function('window', 'document', SOURCE)
  run(window, document)
  // The primitives are the one platform module the shell owns: every icon is
  // replaced by a null-rendering component here, so the assertions below are
  // about THIS plugin's markup rather than about the harness's glyphs.
  const icon = () => null
  const require_ = (specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return new Proxy({}, { get: () => icon })
    }
    throw new Error(`client-modules: require("${specifier}") missed the module table`)
  }
  return registration.factory(require_)
}

const client = loadClient()

/** The trades the fixture portfolio is built from. */
const TRADES = [
  {
    id: 1, symbol: '600000.SH', exchange: 'SH', currency: 'CNY', name: '浦发银行', side: 'buy',
    quantity: 1000, price: 9, tradedAt: '2026-09-01', motive: '低估值买入', note: null,
    createdAt: '2026-09-01T02:00:00.000Z',
  },
  {
    id: 2, symbol: '600000.SH', exchange: 'SH', currency: 'CNY', name: '浦发银行', side: 'sell',
    quantity: 200, price: 9.8, tradedAt: '2026-09-05', motive: '止盈', note: null,
    createdAt: '2026-09-05T02:00:00.000Z',
  },
  {
    id: 3, symbol: '00700.HK', exchange: 'HK', currency: 'HKD', name: '腾讯控股', side: 'buy',
    quantity: 100, price: 430, tradedAt: '2026-08-20', motive: '财报超预期', note: null,
    createdAt: '2026-08-20T02:00:00.000Z',
  },
]

/** The closes that price the fixture, newest bar on 2026-09-10. */
const QUOTES = [
  {
    symbol: '600000.SH', name: '浦发银行', exchange: 'SH', currency: 'CNY', price: 9.26, prevClose: 9.35,
    open: 9.3, high: 9.4, low: 9.2, volume: 1_000_000, date: '2026-09-10', change: -0.09,
    changePct: -0.0096, stale: false,
  },
  {
    symbol: '00700.HK', name: '腾讯控股', exchange: 'HK', currency: 'HKD', price: 428.4, prevClose: 425.6,
    open: 426, high: 430, low: 424, volume: 20_000_000, date: '2026-09-10', change: 2.8,
    changePct: 0.0066, stale: false,
  },
]

const DERIVED = derivePortfolio({
  trades: TRADES,
  quotes: QUOTES,
  baseCurrency: 'CNY',
  rates: rateTable(7.8, 7.15),
  now: NOW,
})

/** One full dashboard payload, built by the same code the host half runs. */
const STATE = {
  trades: TRADES,
  positions: DERIVED.positions,
  closed: DERIVED.closed,
  quotes: QUOTES,
  stats: DERIVED.stats,
  settings: {
    apiKeyConfigured: false,
    apiKeySource: 'none',
    baseCurrency: 'CNY',
    rates: { HKD: 7.8, CNY: 7.15 },
    fx: { available: true, source: 'default', provider: null, updatedAt: null, asOf: null, error: null },
    refreshIntervalMinutes: 30,
    autoRefresh: true,
    mentionPopup: true,
    dbPath: '~/.dsh/storages/stock-portfolio/portfolio.db',
    instrumentCount: 23_450,
    instrumentsSyncedAt: '2026-09-10T00:00:00.000Z',
  },
  feed: {
    baseUrl: 'https://free-api.tickflow.org',
    apiKeySource: 'none',
    batchSupported: true,
    lastError: null,
    lastRefreshAt: '2026-09-11T01:00:00.000Z',
    unresolved: [],
    latestDate: '2026-09-10',
  },
  motives: ['低估值买入', '止盈'],
  generatedAt: '2026-09-11T12:00:00.000Z',
}

/**
 * Render one of the client's exported components.
 * @param component - the component.
 * @param props - its props.
 * @returns the static markup.
 */
function render(component, props) {
  return renderToStaticMarkup(React.createElement(component, props))
}

/**
 * A stand-in for the renderer's `usePortfolio(selector)` prop.
 * @param snapshot - the snapshot to select from.
 * @returns the hook.
 */
function hookOf(snapshot) {
  return selector => selector(snapshot)
}

/** A store stub: the dashboard only ever calls actions from event handlers. */
const noopStore = {
  close: () => {}, selectTab: () => {}, refresh: () => {}, refreshRates: () => {},
  saveSettings: () => {}, syncInstruments: () => {}, addTrade: () => {}, updateTrade: () => {},
  deleteTrade: () => {}, dismissToast: () => {}, open: () => {}, toggle: () => {},
}

test('the overview renders every headline card, including the new ones', () => {
  const html = render(client.Dashboard, {
    store: noopStore,
    usePortfolio: hookOf({
      open: true, tab: 'overview', status: 'ready', state: STATE, error: null, busy: null,
      toast: null, equity: [], equityStatus: 'idle', mentions: [], mentionRev: null, mentionSession: null,
    }),
  })

  for (const label of ['持仓市值', '总盈亏', '未实现盈亏', '当日盈亏', '已实现盈亏', '胜率', '持仓集中度', '平均持有天数']) {
    assert.ok(html.includes(label), `the overview is missing the ${label} card`)
  }
  // The unrealized card carries its own breakdown, and the concentration card
  // names the position that dominates it.
  assert.match(html, /个浮盈 · \d+ 个浮亏/u)
  assert.match(html, /最大 00700\.HK/u)
  assert.match(html, /最长 \d+ 天/u)
  assert.ok(!html.includes('NaN'), 'a card rendered NaN')
})

test('the overview renders without a single priced position', () => {
  // A fresh log with one trade and no bars: every derived number is null or
  // zero, which is exactly when a read off a missing value crashes a panel.
  const bare = derivePortfolio({
    trades: [TRADES[0]],
    quotes: [],
    baseCurrency: 'CNY',
    rates: rateTable(7.8, 7.15),
    now: NOW,
  })
  const html = render(client.Overview, {
    state: { ...STATE, quotes: [], positions: bare.positions, closed: bare.closed, stats: bare.stats },
    equity: [],
    equityStatus: 'error',
  })
  assert.ok(html.includes('未实现盈亏'))
  assert.ok(html.includes('无法读取历史日线'))
  assert.equal(bare.stats.topSymbol, null)
})

test('the holdings table renders a collapsed row per position', () => {
  const html = render(client.Holdings, { state: STATE })
  assert.ok(html.includes('600000.SH'))
  assert.ok(html.includes('00700.HK'))
  // The disclosure control is present and closed, and no detail row is rendered
  // until it is opened.
  assert.match(html, /class="dsp-caret" data-open="false"/u)
  assert.ok(html.includes('aria-expanded="false"'))
  assert.ok(!html.includes('dsp-detail-row'))
})

test('an expanded row draws the chart and the measured windows', () => {
  // Sixty bars ending on the newest trading day, with a decline in them, so every
  // indicator has its window AND both recorded trades fall inside the chart.
  const LAST = Date.UTC(2026, 8, 10)
  const bars = Array.from({ length: 60 }, (_, index) => {
    const close = index < 40 ? 9 + index * 0.02 : 9.8 - (index - 40) * 0.03
    return {
      date: new Date(LAST - (59 - index) * 86_400_000).toISOString().slice(0, 10),
      high: close + 0.05, low: close - 0.05, close, volume: 1_000_000 + index * 10_000,
    }
  })
  const html = render(client.SymbolDetail, {
    subject: DERIVED.positions.find(position => position.symbol === '600000.SH'),
    detail: { status: 'ready', body: { symbol: '600000.SH', bars, stats: computeSymbolStats(bars) } },
    trades: TRADES.filter(trade => trade.symbol === '600000.SH'),
  })

  for (const label of ['区间涨跌幅', '3 日', '15 日', '30 日', '60 日', '20 日波动率', '量比', '60 日最大回撤', '这笔持仓', '持有天数']) {
    assert.ok(html.includes(label), `the facts panel is missing ${label}`)
  }
  // The chart is drawn, the cost line is on it, and both recorded trades are
  // marked.
  assert.ok(html.includes('<svg'))
  assert.ok(html.includes('dsp-chart-cost'))
  assert.equal((html.match(/<polygon/gu) ?? []).length, 2)
  assert.ok(html.includes('收盘价'))
  assert.ok(html.includes('成交量'))
  // A single NaN coordinate silently empties the whole path, so the geometry the
  // renderer produced is checked rather than assumed.
  assert.ok(!html.includes('NaN'), 'the chart geometry contains NaN')
})

test('a trade whose trading day has no bar yet is reported rather than silently missing', () => {
  const LAST = Date.UTC(2026, 8, 10)
  const bars = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(LAST - (29 - index) * 86_400_000).toISOString().slice(0, 10),
    high: 10, low: 9, close: 9.5, volume: 1_000_000,
  }))
  // The trade is dated the day after the newest bar — the normal state of a
  // position recorded today, since daily bars are published after the close.
  const trades = [{
    ...TRADES[0], id: 9, symbol: '600000.SH', tradedAt: '2026-09-11', quantity: 100, price: 9.3,
  }]
  const html = render(client.SymbolDetail, {
    subject: DERIVED.positions.find(position => position.symbol === '600000.SH'),
    detail: { status: 'ready', body: { symbol: '600000.SH', bars, stats: computeSymbolStats(bars) } },
    trades,
  })
  assert.equal((html.match(/<polygon/gu) ?? []).length, 0)
  assert.match(html, /图上未标记的 1 笔交易/u)
  assert.match(html, /2026-09-11 买入 100 @ ¥9\.30/u)
})

test('the mention pane renders the holding statistics and the detail block', () => {
  const batches = [{
    rev: 1,
    sessionId: 'session-1',
    source: 'assistant',
    at: Date.parse('2026-09-11T12:00:00.000Z'),
    symbols: ['600000.SH'],
    excerpt: '…600000 的净息差…',
  }]
  const html = render(client.MentionsPanel, {
    store: { load: () => {}, watchSession: () => {} },
    sessionId: 'session-1',
    usePortfolio: hookOf({ state: STATE, mentions: batches, mentionSession: 'session-1' }),
  })

  // The holding's own numbers come first: quantity, cost, price, both P&L legs.
  for (const label of ['持仓', '成本价', '收盘价', '当日盈亏', '市值', '浮动盈亏', '仓位占比', '已实现盈亏', '持有天数']) {
    assert.ok(html.includes(label), `the mention card is missing ${label}`)
  }
  // The detail block the holdings row expands into — which, in a static render,
  // is still waiting for its series (the fetch is an effect, so effects do not
  // run here). The provenance line is deliberately absent.
  assert.ok(!html.includes('提到过它'))
  assert.ok(!html.includes('…600000 的净息差…'))
  assert.ok(html.includes('正在读取 600000.SH 的日线'))
  assert.ok(html.includes('dsp-mention-panel'))
  assert.ok(!html.includes('NaN'))
})

test('a mention of a position with no series yet still renders its statistics', () => {
  const html = render(client.MentionsPanel, {
    store: { load: () => {}, watchSession: () => {} },
    sessionId: 'session-1',
    usePortfolio: hookOf({
      state: STATE,
      mentionSession: 'session-1',
      mentions: [{
        rev: 2,
        sessionId: 'session-1',
        source: 'user',
        at: Date.parse('2026-09-11T12:00:00.000Z'),
        symbols: ['00700.HK'],
        excerpt: '…00700…',
      }],
    }),
  })
  assert.ok(html.includes('HK$428.40'))
  assert.ok(html.includes('正在读取 00700.HK 的日线'))
})

test('an empty pane explains the rule instead of showing a blank column', () => {
  const empty = render(client.MentionsPanel, {
    store: { load: () => {}, watchSession: () => {} },
    sessionId: 'session-1',
    usePortfolio: hookOf({ state: STATE, mentions: [], mentionSession: 'session-1' }),
  })
  assert.ok(empty.includes('还没有提到持仓标的'))
  assert.ok(empty.includes('600519'))
})

test('the pane waits for the portfolio instead of rendering an empty card', () => {
  const html = render(client.MentionsPanel, {
    store: { load: () => {}, watchSession: () => {} },
    sessionId: 'session-1',
    usePortfolio: hookOf({ state: null, mentions: [], mentionSession: 'session-1' }),
  })
  assert.ok(html.includes('正在读取持仓数据'))

  // A pane that has not been told which conversation it belongs to yet shows
  // neither another session's symbols nor an empty state that looks final.
  const unattached = render(client.MentionsPanel, {
    store: { load: () => {}, watchSession: () => {} },
    usePortfolio: hookOf({ state: STATE, mentions: [], mentionSession: null }),
  })
  assert.ok(unattached.includes('正在读取会话'))
})

test('a row with no bars yet says so instead of drawing an empty chart', () => {
  const html = render(client.SymbolDetail, {
    subject: DERIVED.positions.find(position => position.symbol === '600000.SH'),
    detail: { status: 'ready', body: { symbol: '600000.SH', bars: [], stats: computeSymbolStats([]) } },
    trades: [],
  })
  assert.ok(html.includes('还没有可画的日线'))
  assert.ok(!html.includes('<svg'))
})

test('a failed history read is reported in the row that asked for it', () => {
  const html = render(client.SymbolDetail, {
    subject: DERIVED.positions.find(position => position.symbol === '00700.HK'),
    detail: { status: 'error', message: '行情服务不可用' },
    trades: [],
  })
  assert.ok(html.includes('无法读取 00700.HK 的日线'))
  assert.ok(html.includes('行情服务不可用'))
})
