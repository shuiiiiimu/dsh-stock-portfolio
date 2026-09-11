/**
 * The P&L engine: pure functions from a trade log plus daily closes to every
 * number the dashboard shows.
 *
 * Deliberately free of I/O and of the clock, so the whole file is table-driven
 * testable (`test/portfolio.test.mjs`). The storage layer's only job is to hand
 * it trades in a deterministic order and the latest close per symbol.
 *
 * ## Cost basis
 *
 * Moving-average cost, gross of commission:
 *
 *   buy  `q @ p`  ->  `cost += q*p`,  `quantity += q`
 *   sell `q @ p`  ->  `costSold = avgCost*q`, `realized += q*p - costSold`
 *
 * So `avgCost` is the break-even price of the open quantity and `realizedPnl` is
 * the gross result of the round trip. Fees are deliberately outside the model:
 * the plugin tracks what a position cost and what it returned, and a broker
 * statement's fee lines are a separate reconciliation.
 *
 * ## Motive attribution
 *
 * Every trade carries a free-text motive. Realized P&L is attributed to the
 * **selling** trade's motive — that is the decision being evaluated. Unrealized
 * P&L is attributed across the buying motives in proportion to the cost each
 * still contributes to the open position, which is the only split a moving
 * average supports without inventing per-lot tracking. It answers the question
 * the field exists for ("which reason for buying actually made money") without
 * pretending the attribution is exact.
 */
import { currencyOfSymbol, exchangeLabel } from './symbols.ts'
import type {
  BreakdownRow, ClosedPosition, Currency, EquityPoint, Exchange, NativeTotal, PortfolioStats, Position, Quote,
  Trade,
} from './types.ts'

/** Positions below this many shares are treated as flat (float dust from a sell-all). */
const FLAT_EPSILON = 1e-9

/** The grouping key standing for trades the user left untagged. */
const UNTAGGED = ''

/** Units of each currency per 1 USD. The base every conversion pivots through. */
export type Rates = Readonly<Record<Currency, number>>

/** One symbol's running state while the trade log is folded. */
interface SymbolLedger {
  readonly symbol: string
  readonly exchange: Exchange
  readonly currency: Currency
  name: string | null
  quantity: number
  /** All-in cost of the OPEN quantity only. */
  cost: number
  /** Cost contributed by the open quantity, split by the buying trade's motive. */
  readonly costByMotive: Map<string, number>
  /** Realized P&L booked by each selling trade's motive. */
  readonly realizedByMotive: Map<string, number>
  /** Trades counted against each motive, buys and sells alike. */
  readonly tradesByMotive: Map<string, number>
  realizedPnl: number
  tradeCount: number
  firstTradeAt: string
  lastTradeAt: string
  /** When the current episode of holding this symbol began. */
  episodeOpenedAt: string
  readonly closed: ClosedPosition[]
}

/**
 * Order trades the way the fold requires: by trade date, then by insertion
 * order, so two same-day trades keep the sequence they were entered in.
 * @param trades - trades in any order.
 * @returns a new, sorted array.
 */
export function sortTrades(trades: readonly Trade[]): Trade[] {
  return [...trades].sort((left, right) => {
    if (left.tradedAt !== right.tradedAt) return left.tradedAt < right.tradedAt ? -1 : 1
    return left.id - right.id
  })
}

/**
 * Normalize a motive into a grouping key.
 * @param motive - the raw free-text motive.
 * @returns the trimmed motive, or {@link UNTAGGED} for an empty one.
 */
function motiveKey(motive: string | null): string {
  const trimmed = motive?.trim() ?? ''
  return trimmed === '' ? UNTAGGED : trimmed
}

/**
 * Add an amount to one counter in a map, creating the entry when absent.
 * @param map - the counter map.
 * @param key - the counter's key.
 * @param amount - the amount to add.
 */
function bump(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount)
}

/**
 * Fold the whole trade log into one ledger per symbol.
 * @param trades - every trade, in any order.
 * @returns ledger entries keyed by canonical symbol.
 */
function foldTrades(trades: readonly Trade[]): Map<string, SymbolLedger> {
  const ledgers = new Map<string, SymbolLedger>()
  for (const trade of sortTrades(trades)) {
    let ledger = ledgers.get(trade.symbol)
    if (ledger === undefined) {
      ledger = openLedger(trade)
      ledgers.set(trade.symbol, ledger)
    }
    applyTrade(ledger, trade)
  }
  return ledgers
}

/**
 * Create the empty ledger for the first trade seen on a symbol.
 * @param trade - the symbol's first trade.
 * @returns a zeroed ledger.
 */
function openLedger(trade: Trade): SymbolLedger {
  return {
    symbol: trade.symbol,
    exchange: trade.exchange,
    currency: trade.currency,
    name: trade.name,
    quantity: 0,
    cost: 0,
    costByMotive: new Map(),
    realizedByMotive: new Map(),
    tradesByMotive: new Map(),
    realizedPnl: 0,
    tradeCount: 0,
    firstTradeAt: trade.tradedAt,
    lastTradeAt: trade.tradedAt,
    episodeOpenedAt: trade.tradedAt,
    closed: [],
  }
}

/**
 * Apply one trade to its symbol's ledger, in place.
 * @param ledger - the running ledger.
 * @param trade - the next trade in date order.
 */
function applyTrade(ledger: SymbolLedger, trade: Trade): void {
  const motive = motiveKey(trade.motive)
  ledger.tradeCount += 1
  ledger.lastTradeAt = trade.tradedAt
  bump(ledger.tradesByMotive, motive, 1)
  if (trade.name !== null && trade.name !== '') ledger.name = trade.name

  if (ledger.quantity <= FLAT_EPSILON) ledger.episodeOpenedAt = trade.tradedAt

  if (trade.side === 'buy') {
    const added = trade.quantity * trade.price
    ledger.quantity += trade.quantity
    ledger.cost += added
    bump(ledger.costByMotive, motive, added)
    return
  }

  // A sell beyond the held quantity is rejected at write time; the fold stays
  // defensive so a hand-edited database cannot make the numbers silently
  // nonsensical.
  const sold = Math.min(trade.quantity, ledger.quantity)
  const avgCost = ledger.quantity > FLAT_EPSILON ? ledger.cost / ledger.quantity : 0
  const costSold = avgCost * sold
  const proceeds = sold * trade.price
  const booked = proceeds - costSold
  ledger.realizedPnl += booked
  bump(ledger.realizedByMotive, motive, booked)
  reduceCost(ledger, costSold)
  ledger.quantity -= sold

  if (ledger.quantity <= FLAT_EPSILON) {
    ledger.quantity = 0
    ledger.cost = 0
    ledger.costByMotive.clear()
    ledger.closed.push({
      symbol: ledger.symbol,
      exchange: ledger.exchange,
      currency: ledger.currency,
      name: ledger.name,
      realizedPnl: ledger.realizedPnl,
      proceeds,
      costSold,
      tradeCount: ledger.tradeCount,
      openedAt: ledger.episodeOpenedAt,
      closedAt: trade.tradedAt,
    })
  }
}

/**
 * Remove sold cost from the running basis, taking it proportionally out of each
 * buying motive so the motive mix keeps describing the position that remains.
 * @param ledger - the running ledger.
 * @param costSold - cost basis removed by this sell.
 */
function reduceCost(ledger: SymbolLedger, costSold: number): void {
  if (ledger.cost <= FLAT_EPSILON) {
    ledger.cost = 0
    ledger.costByMotive.clear()
    return
  }
  const remaining = Math.max(0, ledger.cost - costSold)
  const scale = remaining / ledger.cost
  for (const [motive, value] of ledger.costByMotive) {
    ledger.costByMotive.set(motive, value * scale)
  }
  ledger.cost = remaining
}

/**
 * Convert an amount between two currencies through the USD pivot.
 * @param amount - amount in `from`.
 * @param from - the amount's currency.
 * @param to - the reporting currency.
 * @param rates - units of each currency per 1 USD.
 * @returns the converted amount.
 */
export function convert(amount: number, from: Currency, to: Currency, rates: Rates): number {
  if (from === to) return amount
  const fromRate = rates[from]
  const toRate = rates[to]
  /* v8 ignore next -- the rate table is built from two validated positive numbers. */
  if (!(fromRate > 0) || !(toRate > 0)) return amount
  return (amount / fromRate) * toRate
}

/**
 * Build the three-currency rate table from the two rates a user configures.
 * @param usdHkd - units of HKD that one USD buys.
 * @param usdCny - units of CNY that one USD buys.
 * @returns the table every conversion pivots through.
 */
export function rateTable(usdHkd: number, usdCny: number): Rates {
  return { USD: 1, HKD: usdHkd, CNY: usdCny }
}

/**
 * The fold's per-symbol result as plain, serializable data.
 *
 * This is what the `holdings` table materializes, and it is deliberately the
 * same fold {@link derivePortfolio} uses — so the materialized projection and the
 * derived statistics cannot disagree.
 */
export interface LedgerSnapshot {
  readonly symbol: string
  readonly exchange: Exchange
  readonly currency: Currency
  readonly name: string | null
  readonly quantity: number
  /** All-in cost of the open quantity. */
  readonly cost: number
  /** `cost / quantity`, or 0 when flat. */
  readonly avgCost: number
  readonly realizedPnl: number
  readonly tradeCount: number
  readonly firstTradeAt: string
  readonly lastTradeAt: string
  /** Episodes that ended flat, oldest first. */
  readonly closed: readonly ClosedPosition[]
}

/**
 * Fold the trade log into one plain snapshot per symbol.
 * @param trades - every trade, in any order.
 * @returns snapshots sorted by symbol.
 */
export function foldLedgers(trades: readonly Trade[]): LedgerSnapshot[] {
  return [...foldTrades(trades).values()]
    .map(ledger => ({
      symbol: ledger.symbol,
      exchange: ledger.exchange,
      currency: ledger.currency,
      name: ledger.name,
      quantity: ledger.quantity,
      cost: ledger.cost,
      avgCost: ledger.quantity > FLAT_EPSILON ? ledger.cost / ledger.quantity : 0,
      realizedPnl: ledger.realizedPnl,
      tradeCount: ledger.tradeCount,
      firstTradeAt: ledger.firstTradeAt,
      lastTradeAt: ledger.lastTradeAt,
      closed: ledger.closed,
    }))
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
}

/** One symbol paired with the close that prices it. */
interface ValuedLedger {
  readonly ledger: SymbolLedger
  readonly quote: Quote | null
}

/** Inputs the derivation needs beyond the trade log itself. */
export interface DeriveInput {
  readonly trades: readonly Trade[]
  readonly quotes: readonly Quote[]
  readonly baseCurrency: Currency
  readonly rates: Rates
  /** Injectable clock so the derivation stays deterministic under test. */
  readonly now: Date
}

/** The derived portfolio: open and closed positions plus every statistic. */
export interface DerivedPortfolio {
  readonly positions: readonly Position[]
  readonly closed: readonly ClosedPosition[]
  readonly stats: PortfolioStats
}

/**
 * Derive the whole portfolio from trades and daily closes.
 * @param input - trades, quotes, and the conversion settings.
 * @returns open positions, closed episodes, and portfolio statistics.
 */
export function derivePortfolio(input: DeriveInput): DerivedPortfolio {
  const { baseCurrency, rates } = input
  const quotesBySymbol = new Map(input.quotes.map(quote => [quote.symbol, quote]))
  const valued: ValuedLedger[] = [...foldTrades(input.trades)]
    .map(([, ledger]) => ({ ledger, quote: quotesBySymbol.get(ledger.symbol) ?? null }))

  const totalMarketValue = valued.reduce((sum, { ledger, quote }) => {
    if (ledger.quantity <= FLAT_EPSILON || quote === null) return sum
    return sum + convert(ledger.quantity * quote.price, ledger.currency, baseCurrency, rates)
  }, 0)

  const positions = valued
    .filter(({ ledger }) => ledger.quantity > FLAT_EPSILON)
    .map(({ ledger, quote }) => buildPosition(ledger, quote, {
      baseCurrency, rates, totalMarketValue, now: input.now,
    }))
    .sort((left, right) => (right.marketValue ?? 0) - (left.marketValue ?? 0))

  const closed = valued.flatMap(({ ledger }) => ledger.closed)
  const stats = buildStats({
    positions,
    closed,
    valued,
    baseCurrency,
    rates,
    tradeCount: input.trades.length,
    now: input.now,
  })
  return { positions, closed, stats }
}

/**
 * Project one ledger's open quantity into a {@link Position}.
 * @param ledger - the symbol ledger.
 * @param quote - the symbol's latest daily close, or `null`.
 * @param context - conversion and weighting inputs.
 * @returns the position row.
 */
function buildPosition(
  ledger: SymbolLedger,
  quote: Quote | null,
  context: { baseCurrency: Currency, rates: Rates, totalMarketValue: number, now: Date },
): Position {
  const { baseCurrency, rates } = context
  const avgCost = ledger.quantity > FLAT_EPSILON ? ledger.cost / ledger.quantity : 0
  const price = quote?.price ?? null
  const marketValue = price === null ? null : ledger.quantity * price
  const unrealizedPnl = marketValue === null ? null : marketValue - ledger.cost
  const unrealizedPct = unrealizedPnl === null || ledger.cost <= FLAT_EPSILON
    ? null
    : unrealizedPnl / ledger.cost
  const prevClose = quote?.prevClose ?? null
  const dayPnl = price === null || prevClose === null ? null : ledger.quantity * (price - prevClose)
  const dayPnlPct = price === null || prevClose === null || prevClose === 0
    ? null
    : (price - prevClose) / prevClose
  const weight = marketValue === null || context.totalMarketValue <= 0
    ? 0
    : convert(marketValue, ledger.currency, baseCurrency, rates) / context.totalMarketValue

  return {
    symbol: ledger.symbol,
    exchange: ledger.exchange,
    currency: ledger.currency,
    name: quote?.name ?? ledger.name,
    quantity: ledger.quantity,
    avgCost,
    costBasis: ledger.cost,
    price,
    prevClose,
    priceDate: quote?.date ?? null,
    marketValue,
    unrealizedPnl,
    unrealizedPct,
    dayPnl,
    dayPnlPct,
    realizedPnl: ledger.realizedPnl,
    tradeCount: ledger.tradeCount,
    firstTradeAt: ledger.firstTradeAt,
    lastTradeAt: ledger.lastTradeAt,
    holdingDays: daysSince(ledger.firstTradeAt, context.now),
    weight,
  }
}

/**
 * Reduce positions, closed episodes and ledgers into every portfolio number.
 * @param input - derived rows plus the conversion inputs.
 * @returns the statistics block.
 */
function buildStats(input: {
  positions: readonly Position[]
  closed: readonly ClosedPosition[]
  valued: readonly ValuedLedger[]
  baseCurrency: Currency
  rates: Rates
  tradeCount: number
  now: Date
}): PortfolioStats {
  const { positions, closed, valued, baseCurrency, rates } = input
  const toBase = (amount: number, currency: Currency): number => convert(amount, currency, baseCurrency, rates)
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

  const totalMarketValue = sum(positions.map(
    row => row.marketValue === null ? 0 : toBase(row.marketValue, row.currency)))
  const totalCost = sum(positions.map(row => toBase(row.costBasis, row.currency)))
  const totalUnrealizedPnl = sum(positions.map(
    row => row.unrealizedPnl === null ? 0 : toBase(row.unrealizedPnl, row.currency)))
  // Realized P&L lives on open positions too: a partial sell books profit
  // without closing the episode, and those ledgers are not in `closed`.
  const closesRealized = sum(closed.map(row => toBase(row.realizedPnl, row.currency)))
  const opensRealized = sum(valued
    .filter(({ ledger }) => ledger.quantity > FLAT_EPSILON)
    .map(({ ledger }) => toBase(ledger.realizedPnl, ledger.currency)))
  const totalRealizedPnl = closesRealized + opensRealized
  const dayPnl = sum(positions.map(row => row.dayPnl === null ? 0 : toBase(row.dayPnl, row.currency)))

  const wins = closed.filter(row => row.realizedPnl > 0)
  const losses = closed.filter(row => row.realizedPnl < 0)
  const grossProfit = sum(wins.map(row => toBase(row.realizedPnl, row.currency)))
  const grossLoss = Math.abs(sum(losses.map(row => toBase(row.realizedPnl, row.currency))))

  const ranked = valued
    .map(({ ledger, quote }) => {
      const unrealized = ledger.quantity <= FLAT_EPSILON || quote === null
        ? 0
        : ledger.quantity * quote.price - ledger.cost
      return { symbol: ledger.symbol, total: toBase(ledger.realizedPnl + unrealized, ledger.currency) }
    })
    .filter(row => row.total !== 0)
    .sort((left, right) => right.total - left.total)

  const totalPnl = totalUnrealizedPnl + totalRealizedPnl
  // Return on cost uses the capital actually committed: the open basis plus
  // whatever has already been sold out of it.
  const committed = totalCost + sum(closed.map(row => toBase(row.costSold, row.currency)))
  const priorValue = totalMarketValue - dayPnl

  // Winners and losers, counted and summed in the base currency: the count says
  // how broad the result is, the two sums say how lopsided it is.
  const unrealized = positions
    .filter(row => row.unrealizedPnl !== null)
    .map(row => toBase(row.unrealizedPnl ?? 0, row.currency))
  const winners = unrealized.filter(value => value > 0)
  const losers = unrealized.filter(value => value < 0)

  // Weights are already converted shares of the portfolio, so concentration is
  // just the sorted head of them.
  const weights = positions.map(row => row.weight).sort((left, right) => right - left)
  const largest = [...positions].sort((left, right) => right.weight - left.weight)[0]

  // Holding time runs from the first buy to today, so a position trimmed last
  // week still counts from the day it was opened.
  const holdingDays = positions
    .map(row => row.holdingDays)
    .filter((value): value is number => value !== null)

  return {
    baseCurrency,
    totalMarketValue,
    totalCost,
    totalUnrealizedPnl,
    totalUnrealizedPct: totalCost > 0 ? totalUnrealizedPnl / totalCost : null,
    totalRealizedPnl,
    totalPnl,
    totalPnlPct: committed > 0 ? totalPnl / committed : null,
    dayPnl,
    dayPnlPct: priorValue > 0 ? dayPnl / priorValue : null,
    openPositions: positions.length,
    closedPositions: closed.length,
    tradeCount: input.tradeCount,
    unrealizedWinners: winners.length,
    unrealizedLosers: losers.length,
    grossUnrealizedGain: sum(winners),
    grossUnrealizedLoss: sum(losers),
    topWeight: weights[0] ?? 0,
    topSymbol: largest === undefined || largest.marketValue === null ? null : largest.symbol,
    topThreeWeight: sum(weights.slice(0, 3)),
    avgHoldingDays: holdingDays.length === 0 ? null : sum(holdingDays) / holdingDays.length,
    longestHoldingDays: holdingDays.length === 0 ? null : Math.max(...holdingDays),
    holdingSince: positions.map(row => row.firstTradeAt).sort()[0] ?? null,
    winRate: closed.length === 0 ? null : wins.length / closed.length,
    avgWin: wins.length === 0 ? null : grossProfit / wins.length,
    avgLoss: losses.length === 0 ? null : -grossLoss / losses.length,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    bestSymbol: ranked[0]?.symbol ?? null,
    worstSymbol: ranked.length > 1 ? ranked[ranked.length - 1]?.symbol ?? null : null,
    byMarket: exchangeBreakdown(positions, closed, baseCurrency, rates),
    byMotive: motiveBreakdown(valued, baseCurrency, rates),
    native: nativeTotals(positions, closed),
    rates,
  }
}

/**
 * Whole days between a `YYYY-MM-DD` date and a reference instant.
 * @param date - the earlier date, as the trade log stores it.
 * @param now - the reference instant.
 * @returns the day count, never negative, or `null` when the date is unparseable.
 */
function daysSince(date: string, now: Date): number | null {
  const parsed = Date.parse(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed)) return null
  return Math.max(0, Math.floor((now.getTime() - parsed) / 86_400_000))
}

/**
 * Group positions and closed episodes by exchange and convert each group.
 * @param positions - open positions.
 * @param closed - closed episodes.
 * @param baseCurrency - the reporting currency.
 * @param rates - units of each currency per 1 USD.
 * @returns one row per exchange, largest absolute P&L first.
 */
function exchangeBreakdown(
  positions: readonly Position[],
  closed: readonly ClosedPosition[],
  baseCurrency: Currency,
  rates: Rates,
): BreakdownRow[] {
  const groups = new Map<string, { trades: number, realized: number, unrealized: number, marketValue: number }>()
  const touch = (exchange: string) => {
    const existing = groups.get(exchange)
    if (existing !== undefined) return existing
    const created = { trades: 0, realized: 0, unrealized: 0, marketValue: 0 }
    groups.set(exchange, created)
    return created
  }

  for (const row of positions) {
    const group = touch(row.exchange)
    group.trades += row.tradeCount
    group.realized += convert(row.realizedPnl, row.currency, baseCurrency, rates)
    group.unrealized += convert(row.unrealizedPnl ?? 0, row.currency, baseCurrency, rates)
    group.marketValue += convert(row.marketValue ?? 0, row.currency, baseCurrency, rates)
  }
  for (const row of closed) {
    const group = touch(row.exchange)
    group.trades += row.tradeCount
    group.realized += convert(row.realizedPnl, row.currency, baseCurrency, rates)
  }

  const rows = [...groups].map(([key, group]) => ({
    key,
    label: exchangeLabel(key),
    trades: group.trades,
    realizedPnl: group.realized,
    unrealizedPnl: group.unrealized,
    totalPnl: group.realized + group.unrealized,
    marketValue: group.marketValue,
    share: 0,
  }))
  return withShares(rank(rows))
}

/**
 * Attribute P&L across the motives that produced it.
 * @param valued - every symbol ledger paired with its close.
 * @param baseCurrency - the reporting currency.
 * @param rates - units of each currency per 1 USD.
 * @returns one row per motive, plus a row for untagged trades when any exist.
 */
function motiveBreakdown(
  valued: readonly ValuedLedger[],
  baseCurrency: Currency,
  rates: Rates,
): BreakdownRow[] {
  const groups = new Map<string, {
    trades: number, realized: number, unrealized: number, marketValue: number
  }>()
  const touch = (motive: string) => {
    const existing = groups.get(motive)
    if (existing !== undefined) return existing
    const created = { trades: 0, realized: 0, unrealized: 0, marketValue: 0 }
    groups.set(motive, created)
    return created
  }

  for (const { ledger, quote } of valued) {
    // Every motive that ever traded this symbol contributes its realized P&L and
    // its trade count.
    for (const [motive, amount] of ledger.realizedByMotive) {
      touch(motive).realized += convert(amount, ledger.currency, baseCurrency, rates)
    }
    for (const [motive, count] of ledger.tradesByMotive) touch(motive).trades += count

    if (ledger.quantity <= FLAT_EPSILON || quote === null || ledger.cost <= FLAT_EPSILON) continue
    // The open quantity's unrealized P&L and market value are split across the
    // buying motives in proportion to the cost each still holds.
    const unrealized = ledger.quantity * quote.price - ledger.cost
    const marketValue = ledger.quantity * quote.price
    for (const [motive, costShare] of ledger.costByMotive) {
      const ratio = costShare / ledger.cost
      const group = touch(motive)
      group.unrealized += convert(unrealized * ratio, ledger.currency, baseCurrency, rates)
      group.marketValue += convert(marketValue * ratio, ledger.currency, baseCurrency, rates)
    }
  }

  const rows = [...groups].map(([key, group]) => ({
    key: key === UNTAGGED ? '未标注动机' : key,
    label: key === UNTAGGED ? '未标注动机' : key,
    trades: group.trades,
    realizedPnl: group.realized,
    unrealizedPnl: group.unrealized,
    totalPnl: group.realized + group.unrealized,
    marketValue: group.marketValue,
    share: 0,
  }))
  return withShares(rank(rows))
}

/**
 * Sort breakdown rows by the size of their P&L contribution.
 * @param rows - rows with `share` still zero.
 * @returns a new, sorted array.
 */
function rank<T extends { totalPnl: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => Math.abs(right.totalPnl) - Math.abs(left.totalPnl))
}

/**
 * Scale each row's `share` to its slice of the largest absolute contribution.
 * @param rows - breakdown rows with `share` still zero.
 * @returns the same rows with `share` filled in.
 */
function withShares(rows: BreakdownRow[]): BreakdownRow[] {
  const peak = rows.reduce((max, row) => Math.max(max, Math.abs(row.totalPnl)), 0)
  return rows.map(row => ({ ...row, share: peak === 0 ? 0 : Math.abs(row.totalPnl) / peak }))
}

/**
 * Sum each currency's own subtotals, converting nothing.
 * @param positions - open positions.
 * @param closed - closed episodes.
 * @returns one row per currency that has activity.
 */
function nativeTotals(
  positions: readonly Position[],
  closed: readonly ClosedPosition[],
): NativeTotal[] {
  const byCurrency = new Map<Currency, NativeTotal>()
  const touch = (currency: Currency): NativeTotal => {
    const existing = byCurrency.get(currency)
    if (existing !== undefined) return existing
    const created = { currency, marketValue: 0, cost: 0, unrealizedPnl: 0, realizedPnl: 0 }
    byCurrency.set(currency, created)
    return created
  }
  for (const row of positions) {
    const running = touch(row.currency)
    byCurrency.set(row.currency, {
      ...running,
      marketValue: running.marketValue + (row.marketValue ?? 0),
      cost: running.cost + row.costBasis,
      unrealizedPnl: running.unrealizedPnl + (row.unrealizedPnl ?? 0),
      realizedPnl: running.realizedPnl + row.realizedPnl,
    })
  }
  for (const row of closed) {
    const running = touch(row.currency)
    byCurrency.set(row.currency, { ...running, realizedPnl: running.realizedPnl + row.realizedPnl })
  }
  return [...byCurrency.values()].sort((left, right) => left.currency.localeCompare(right.currency))
}

/**
 * Value the portfolio at each past trading day: the quantity held on that date
 * multiplied by that date's close.
 *
 * This is the honest reconstruction — it replays the trade log rather than
 * pretending today's holdings existed all along, so a position opened last week
 * contributes nothing to last month's curve.
 * @param input - trades, per-symbol daily closes, and the conversion settings.
 * @returns one point per date on which a held symbol had a close.
 */
export function buildEquityCurve(input: {
  trades: readonly Trade[]
  /** Daily closes keyed by canonical symbol, ascending by date. */
  closes: ReadonlyMap<string, readonly { date: string, close: number }[]>
  baseCurrency: Currency
  rates: Rates
}): EquityPoint[] {
  const { trades, closes, baseCurrency, rates } = input
  const dates = new Set<string>()
  for (const series of closes.values()) for (const point of series) dates.add(point.date)

  const sorted = sortTrades(trades)
  const points: EquityPoint[] = []
  const symbols = [...closes]
  for (const date of [...dates].sort()) {
    let marketValue = 0
    let cost = 0
    for (const [symbol, series] of symbols) {
      const close = closeOn(series, date)
      if (close === null) continue
      const state = positionOn(sorted, symbol, date)
      if (state.quantity <= FLAT_EPSILON) continue
      const currency = currencyOfSymbol(symbol)
      marketValue += convert(state.quantity * close, currency, baseCurrency, rates)
      cost += convert(state.cost, currency, baseCurrency, rates)
    }
    if (marketValue === 0 && cost === 0) continue
    points.push({ date, marketValue, cost })
  }
  return points
}

/**
 * The close on one date, or the most recent close before it.
 * @param series - ascending daily closes for one symbol.
 * @param date - the requested date.
 * @returns the close, or `null` before the series starts.
 */
function closeOn(series: readonly { date: string, close: number }[], date: string): number | null {
  let found: number | null = null
  for (const point of series) {
    if (point.date > date) break
    found = point.close
  }
  return found
}

/**
 * Replay one symbol's trades up to and including a date.
 * @param trades - the full log, already sorted.
 * @param symbol - the symbol to replay.
 * @param date - inclusive cut-off date.
 * @returns the quantity and cost held at that date.
 */
function positionOn(
  trades: readonly Trade[],
  symbol: string,
  date: string,
): { quantity: number, cost: number } {
  let quantity = 0
  let cost = 0
  for (const trade of trades) {
    if (trade.symbol !== symbol) continue
    if (trade.tradedAt > date) break
    if (trade.side === 'buy') {
      quantity += trade.quantity
      cost += trade.quantity * trade.price
      continue
    }
    const sold = Math.min(trade.quantity, quantity)
    const avgCost = quantity > FLAT_EPSILON ? cost / quantity : 0
    cost = Math.max(0, cost - avgCost * sold)
    quantity -= sold
  }
  return { quantity, cost }
}
