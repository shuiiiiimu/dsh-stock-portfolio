/**
 * The P&L engine. Every case here is written as a broker statement would show
 * it, so a regression reads as "the numbers stopped matching the account".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildEquityCurve, derivePortfolio, foldLedgers, rateTable } from '../lib/index.js'

/** A fixed "now" so staleness never enters the arithmetic. */
const NOW = new Date('2026-09-11T12:00:00.000Z')

/** The rate table the cases convert through: 1 USD = 7.8 HKD = 7.15 CNY. */
const RATES = rateTable(7.8, 7.15)

/**
 * The exchange a symbol belongs to, for building fixtures.
 * @param symbol - the canonical symbol.
 * @returns the exchange code.
 */
function exchangeOf(symbol) {
  return symbol.slice(symbol.lastIndexOf('.') + 1)
}

/**
 * The currency a symbol trades in, for building fixtures.
 * @param symbol - the canonical symbol.
 * @returns the currency code.
 */
function currencyOf(symbol) {
  const exchange = exchangeOf(symbol)
  return exchange === 'HK' ? 'HKD' : exchange === 'US' ? 'USD' : 'CNY'
}

/**
 * Build a trade with sensible defaults.
 * @param fields - the fields to override.
 * @returns the trade.
 */
function trade(fields) {
  const symbol = fields.symbol ?? 'AAPL.US'
  return {
    id: fields.id ?? 1,
    symbol,
    exchange: exchangeOf(symbol),
    currency: currencyOf(symbol),
    name: fields.name ?? null,
    side: fields.side ?? 'buy',
    quantity: fields.quantity ?? 100,
    price: fields.price ?? 10,
    tradedAt: fields.tradedAt ?? '2026-01-02',
    motive: fields.motive ?? null,
    note: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  }
}

/**
 * Build a daily-close quote with sensible defaults.
 * @param fields - the fields to override.
 * @returns the quote.
 */
function quote(fields) {
  const symbol = fields.symbol ?? 'AAPL.US'
  return {
    symbol,
    name: fields.name ?? null,
    exchange: exchangeOf(symbol),
    currency: currencyOf(symbol),
    price: fields.price ?? 10,
    prevClose: fields.prevClose ?? null,
    open: null,
    high: null,
    low: null,
    volume: null,
    date: fields.date ?? '2026-09-10',
    change: null,
    changePct: null,
    stale: false,
  }
}

/**
 * Derive a portfolio with the shared defaults.
 * @param trades - the trade log.
 * @param quotes - the quote table.
 * @param overrides - conversion settings to override.
 * @returns the derived portfolio.
 */
function derive(trades, quotes, overrides = {}) {
  return derivePortfolio({
    trades,
    quotes,
    baseCurrency: 'USD',
    rates: RATES,
    now: NOW,
    ...overrides,
  })
}

test('a plain buy produces a position at its cost', () => {
  const { positions, stats } = derive(
    [trade({ quantity: 100, price: 10 })],
    [quote({ price: 12 })],
  )
  const [row] = positions
  assert.equal(positions.length, 1)
  assert.equal(row.quantity, 100)
  // 100 * 10 = 1000, so the break-even price is 10.
  assert.equal(row.costBasis, 1000)
  assert.equal(row.avgCost, 10)
  assert.equal(row.marketValue, 1200)
  assert.equal(row.unrealizedPnl, 200)
  assert.equal(row.unrealizedPct, 200 / 1000)
  assert.equal(row.priceDate, '2026-09-10')
  assert.equal(stats.totalMarketValue, 1200)
  assert.equal(stats.totalRealizedPnl, 0)
})

test('a sell books realized P&L against the moving average', () => {
  const { positions, stats } = derive([
    trade({ id: 1, quantity: 100, price: 10, tradedAt: '2026-01-02' }),
    trade({ id: 2, side: 'sell', quantity: 40, price: 15, tradedAt: '2026-02-02' }),
  ], [quote({ price: 15 })])

  const [row] = positions
  // avgCost = 10; sold 40 -> costSold = 400, proceeds = 40*15 = 600.
  assert.equal(row.realizedPnl, 200)
  assert.equal(row.quantity, 60)
  // Remaining basis: 1000 - 400 = 600.
  assert.equal(Math.round(row.costBasis * 100) / 100, 600)
  assert.equal(stats.totalRealizedPnl, 200)
  // The 60 left are worth 900 and cost 600.
  assert.equal(stats.totalUnrealizedPnl, 300)
  assert.equal(stats.totalPnl, 500)
})

test('selling everything closes the episode and keeps its realized P&L', () => {
  const { positions, closed, stats } = derive([
    trade({ id: 1, quantity: 100, price: 10, tradedAt: '2026-01-02' }),
    trade({ id: 2, side: 'sell', quantity: 100, price: 11, tradedAt: '2026-03-02' }),
  ], [])

  assert.equal(positions.length, 0)
  assert.equal(closed.length, 1)
  assert.equal(closed[0].realizedPnl, 100)
  assert.equal(closed[0].exchange, 'US')
  assert.equal(closed[0].openedAt, '2026-01-02')
  assert.equal(closed[0].closedAt, '2026-03-02')
  assert.equal(stats.totalRealizedPnl, 100)
  assert.equal(stats.totalMarketValue, 0)
  assert.equal(stats.winRate, 1)
})

test('sells are matched chronologically even when entered out of order', () => {
  // The sell is inserted first but dated later; the fold must sort by date, or
  // the position would read as a short sale for one step.
  const { positions } = derive([
    trade({ id: 2, side: 'sell', quantity: 50, price: 20, tradedAt: '2026-05-01' }),
    trade({ id: 1, quantity: 100, price: 10, tradedAt: '2026-01-01' }),
  ], [quote({ price: 20 })])

  assert.equal(positions[0].quantity, 50)
  assert.equal(positions[0].realizedPnl, 500)
})

test('statistics separate wins from losses', () => {
  const { stats } = derive([
    // Winner: buy 100 @ 10, sell 100 @ 13.
    trade({ id: 1, symbol: 'AAPL.US', quantity: 100, price: 10, tradedAt: '2026-01-01' }),
    trade({ id: 2, symbol: 'AAPL.US', side: 'sell', quantity: 100, price: 13, tradedAt: '2026-02-01' }),
    // Loser: buy 100 @ 10, sell 100 @ 8.
    trade({ id: 3, symbol: 'TSLA.US', quantity: 100, price: 10, tradedAt: '2026-01-01' }),
    trade({ id: 4, symbol: 'TSLA.US', side: 'sell', quantity: 100, price: 8, tradedAt: '2026-02-01' }),
  ], [])

  assert.equal(stats.closedPositions, 2)
  assert.equal(stats.winRate, 0.5)
  assert.equal(stats.avgWin, 300)
  assert.equal(stats.avgLoss, -200)
  assert.equal(stats.profitFactor, 1.5)
  assert.equal(stats.bestSymbol, 'AAPL.US')
  assert.equal(stats.worstSymbol, 'TSLA.US')
})

test('the unrealized block separates winners from losers, and concentration from the weights', () => {
  const { stats, positions } = derive([
    // Two winners of different sizes and one loser, all in USD.
    trade({ id: 1, symbol: 'AAPL.US', quantity: 150, price: 10, tradedAt: '2026-09-01' }),
    trade({ id: 2, symbol: 'MSFT.US', quantity: 50, price: 20, tradedAt: '2026-08-01' }),
    trade({ id: 3, symbol: 'TSLA.US', quantity: 20, price: 30, tradedAt: '2026-01-02' }),
  ], [
    quote({ symbol: 'AAPL.US', price: 12 }),
    quote({ symbol: 'MSFT.US', price: 24 }),
    quote({ symbol: 'TSLA.US', price: 21 }),
  ])

  // 1800 + 1200 + 420 = 3420 of market value.
  assert.equal(stats.totalMarketValue, 3420)
  assert.equal(stats.unrealizedWinners, 2)
  assert.equal(stats.unrealizedLosers, 1)
  assert.equal(stats.grossUnrealizedGain, 300 + 200)
  assert.equal(stats.grossUnrealizedLoss, -180)

  // The largest position is AAPL at 1800/3420, and the top three are everything.
  assert.equal(stats.topSymbol, 'AAPL.US')
  assert.ok(Math.abs(stats.topWeight - 1800 / 3420) < 1e-12)
  assert.ok(Math.abs(stats.topThreeWeight - 1) < 1e-12)

  // Holding time runs from the first buy in THIS symbol's log; NOW is 2026-09-11.
  const bySymbol = new Map(positions.map(row => [row.symbol, row]))
  assert.equal(bySymbol.get('AAPL.US').holdingDays, 10)
  assert.equal(bySymbol.get('MSFT.US').holdingDays, 41)
  assert.equal(bySymbol.get('TSLA.US').holdingDays, 252)
  assert.equal(stats.longestHoldingDays, 252)
  assert.ok(Math.abs(stats.avgHoldingDays - (10 + 41 + 252) / 3) < 1e-12)
  assert.equal(stats.holdingSince, '2026-01-02')
})

test('a position with no quote is outside both the counts and the sums', () => {
  const { stats } = derive([
    trade({ id: 1, symbol: 'AAPL.US', quantity: 100, price: 10, tradedAt: '2026-01-02' }),
    trade({ id: 2, symbol: 'TSLA.US', quantity: 10, price: 10, tradedAt: '2026-01-02' }),
  ], [quote({ symbol: 'AAPL.US', price: 11 })])

  // TSLA has no bar at all, so it cannot be called a winner or a loser.
  assert.equal(stats.unrealizedWinners, 1)
  assert.equal(stats.unrealizedLosers, 0)
  assert.equal(stats.grossUnrealizedGain, 100)
  assert.equal(stats.grossUnrealizedLoss, 0)
  assert.equal(stats.topSymbol, 'AAPL.US')
})

test('converts three currencies through one pivot, and reports native subtotals', () => {
  const { stats } = derive([
    trade({ id: 1, symbol: 'AAPL.US', quantity: 10, price: 100, tradedAt: '2026-01-01' }),
    trade({ id: 2, symbol: '00700.HK', quantity: 100, price: 400, tradedAt: '2026-01-01' }),
    trade({ id: 3, symbol: '600000.SH', quantity: 1000, price: 9, tradedAt: '2026-01-01' }),
  ], [
    quote({ symbol: 'AAPL.US', price: 110 }),
    quote({ symbol: '00700.HK', price: 440 }),
    quote({ symbol: '600000.SH', price: 9.5 }),
  ], { baseCurrency: 'USD' })

  // USD position: 10 * 110 = 1100 USD.
  // HKD position: 100 * 440 = 44000 HKD -> / 7.8 USD.
  // CNY position: 1000 * 9.5 = 9500 CNY -> / 7.15 USD.
  const expected = 1100 + 44_000 / 7.8 + 9500 / 7.15
  assert.equal(Math.round(stats.totalMarketValue * 100) / 100, Math.round(expected * 100) / 100)

  const native = new Map(stats.native.map(row => [row.currency, row]))
  assert.equal(native.get('USD').marketValue, 1100)
  assert.equal(native.get('HKD').marketValue, 44_000)
  assert.equal(native.get('CNY').marketValue, 9500)

  // Market breakdown is by exchange now, and carries the localized labels.
  const byExchange = new Map(stats.byMarket.map(row => [row.key, row]))
  assert.deepEqual([...byExchange.keys()].sort(), ['HK', 'SH', 'US'])
  assert.equal(byExchange.get('SH').label, '上交所')
  assert.equal(byExchange.get('HK').label, '港股')
})

test('a symbol with no daily close never contributes a zero to the totals', () => {
  const { positions, stats } = derive([
    trade({ id: 1, symbol: 'AAPL.US', quantity: 10, price: 100 }),
    trade({ id: 2, symbol: 'ZZZZ.US', quantity: 5, price: 50 }),
  ], [quote({ symbol: 'AAPL.US', price: 110 })])

  const unpriced = positions.find(row => row.symbol === 'ZZZZ.US')
  assert.equal(unpriced.price, null)
  assert.equal(unpriced.marketValue, null)
  assert.equal(unpriced.unrealizedPnl, null)
  assert.equal(unpriced.priceDate, null)
  // The cost is still counted, because the money was really spent.
  assert.equal(stats.totalCost, 1000 + 250)
  assert.equal(stats.totalMarketValue, 1100)
})

test('day P&L uses the previous daily close for the whole position', () => {
  const { positions, stats } = derive(
    [trade({ quantity: 100, price: 10 })],
    [quote({ price: 12, prevClose: 11 })],
  )
  assert.equal(positions[0].dayPnl, 100)
  assert.equal(positions[0].dayPnlPct, 1 / 11)
  assert.equal(stats.dayPnl, 100)
  assert.equal(stats.dayPnlPct, 100 / (1200 - 100))
})

test('a single daily bar leaves the day move unknown rather than zero', () => {
  const { positions, stats } = derive(
    [trade({ quantity: 100, price: 10 })],
    [quote({ price: 12, prevClose: null })],
  )
  assert.equal(positions[0].dayPnl, null)
  assert.equal(positions[0].dayPnlPct, null)
  assert.equal(stats.dayPnl, 0)
})

test('motive attribution splits the position across its buying reasons', () => {
  const { stats } = derive([
    trade({ id: 1, quantity: 100, price: 10, motive: '财报超预期', tradedAt: '2026-01-01' }),
    trade({ id: 2, quantity: 100, price: 20, motive: '回调加仓', tradedAt: '2026-02-01' }),
    trade({ id: 3, side: 'sell', quantity: 50, price: 25, motive: '止盈', tradedAt: '2026-03-01' }),
  ], [quote({ price: 25 })])

  const rows = new Map(stats.byMotive.map(row => [row.key, row]))
  // Realized: avgCost 15, sold 50 -> costSold 750, proceeds 1250, booked 500.
  assert.equal(rows.get('止盈').realizedPnl, 500)
  // Unrealized: 150 shares worth 3750 against a basis of 2250 -> 1500.
  const unrealized = stats.byMotive.reduce((sum, row) => sum + row.unrealizedPnl, 0)
  assert.equal(Math.round(unrealized * 100) / 100, 1500)
  // The two buying motives split it by the cost each still holds: 2250 remains,
  // of which 750 came in at 10 and 1500 at 20 — a 1:2 split of 1500.
  assert.equal(rows.get('财报超预期').unrealizedPnl, 500)
  assert.equal(rows.get('回调加仓').unrealizedPnl, 1000)
  assert.equal(rows.get('止盈').trades, 1)
})

test('untagged trades get their own motive row rather than hiding in a real one', () => {
  const { stats } = derive([
    trade({ id: 1, quantity: 100, price: 10, motive: '定投', tradedAt: '2026-01-01' }),
    trade({ id: 2, quantity: 100, price: 10, motive: null, tradedAt: '2026-02-01' }),
  ], [quote({ price: 12 })])

  const keys = stats.byMotive.map(row => row.key)
  assert.deepEqual(keys.sort(), ['定投', '未标注动机'].sort())
  assert.equal(stats.byMotive.reduce((sum, row) => sum + row.trades, 0), 2)
})

test('the holdings projection is the same fold the statistics use', () => {
  const trades = [
    trade({ id: 1, quantity: 100, price: 10, tradedAt: '2026-01-01' }),
    trade({ id: 2, side: 'sell', quantity: 40, price: 15, tradedAt: '2026-02-01' }),
    trade({ id: 3, symbol: '600000.SH', quantity: 1000, price: 9, tradedAt: '2026-02-15' }),
  ]
  const ledgers = foldLedgers(trades)
  const { positions } = derive(trades, [quote({ price: 15 })])

  const open = ledgers.filter(ledger => ledger.quantity > 0)
  assert.equal(open.length, positions.length)
  for (const position of positions) {
    const ledger = ledgers.find(row => row.symbol === position.symbol)
    assert.equal(ledger.quantity, position.quantity)
    assert.equal(ledger.cost, position.costBasis)
    assert.equal(ledger.avgCost, position.avgCost)
    assert.equal(ledger.realizedPnl, position.realizedPnl)
    assert.equal(ledger.exchange, position.exchange)
  }
})

test('the equity curve replays the log instead of assuming today holdings', () => {
  const closes = new Map([['AAPL.US', [
    { date: '2026-01-01', close: 10 },
    { date: '2026-02-01', close: 20 },
    { date: '2026-03-01', close: 30 },
  ]]])
  const points = buildEquityCurve({
    // Bought in February, so January must value at zero and be dropped.
    trades: [trade({ quantity: 10, price: 20, tradedAt: '2026-02-01' })],
    closes,
    baseCurrency: 'USD',
    rates: RATES,
  })

  assert.deepEqual(points.map(point => point.date), ['2026-02-01', '2026-03-01'])
  assert.equal(points[0].marketValue, 200)
  assert.equal(points[0].cost, 200)
  assert.equal(points[1].marketValue, 300)
  // The cost basis does not move with the market.
  assert.equal(points[1].cost, 200)
})

test('the equity curve converts a mixed-currency portfolio per point', () => {
  const closes = new Map([
    ['00700.HK', [{ date: '2026-03-01', close: 400 }]],
    ['AAPL.US', [{ date: '2026-03-01', close: 100 }]],
  ])
  const points = buildEquityCurve({
    trades: [
      trade({ id: 1, symbol: '00700.HK', quantity: 10, price: 300, tradedAt: '2026-01-01' }),
      trade({ id: 2, symbol: 'AAPL.US', quantity: 10, price: 90, tradedAt: '2026-01-01' }),
    ],
    closes,
    baseCurrency: 'USD',
    rates: RATES,
  })

  assert.equal(points.length, 1)
  assert.equal(Math.round(points[0].marketValue * 100) / 100, Math.round((4000 / 7.8 + 1000) * 100) / 100)
  assert.equal(Math.round(points[0].cost * 100) / 100, Math.round((3000 / 7.8 + 900) * 100) / 100)
})

test('an empty portfolio derives cleanly rather than dividing by zero', () => {
  const { positions, stats } = derive([], [])
  assert.equal(positions.length, 0)
  assert.equal(stats.totalMarketValue, 0)
  assert.equal(stats.totalUnrealizedPct, null)
  assert.equal(stats.totalPnlPct, null)
  assert.equal(stats.winRate, null)
  assert.equal(stats.profitFactor, null)
  assert.equal(stats.bestSymbol, null)
  assert.deepEqual(stats.byMarket, [])
})
