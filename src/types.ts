/**
 * Shared portfolio vocabulary.
 *
 * This module is imported by BOTH halves of the plugin. The browser half only
 * ever uses `import type`, which esbuild erases, so nothing here reaches the
 * client bundle — the types are a compile-time contract, not a runtime one.
 *
 * ## Prices are daily
 *
 * The plugin stores one row per symbol per trading day and nothing finer. A
 * position is valued at the **latest daily close**, and "today's move" is the
 * change against the previous close. That is the whole price model: no intraday
 * snapshots, no streaming, no cache-invalidation window. It is also what makes a
 * keyless deployment viable, because the provider's free tier serves daily bars and
 * instrument metadata for every market it covers.
 *
 * ## Money and currency
 *
 * Money is carried as plain `number`. Every amount is in the currency of the row
 * it belongs to; a portfolio total is converted into the configured base
 * currency at the configured rates, and the per-currency subtotals are always
 * reported alongside it so a converted total is never mistaken for a booked one.
 * The rates themselves are refreshed from the web (see `fx.ts`), except when the
 * user types their own.
 */
import type { FxFailure, FxRateSource } from './fx.ts'

/** A currency this plugin can book — one per region the provider covers. */
export type Currency = 'CNY' | 'HKD' | 'USD'

/**
 * An exchange code. `SH`, `SZ`, `BJ`, `HK` and `US` are the ones the provider
 * currently lists; the type stays open so a new exchange needs no code change —
 * an unknown suffix is passed through and the API answers for it.
 */
export type Exchange = string

/** Which direction a trade moved the position. */
export type TradeSide = 'buy' | 'sell'

/** The instrument classes the provider reports. */
export type InstrumentType = 'stock' | 'etf' | 'index' | 'bond' | 'fund' | 'options' | 'other'

/** One tradable (or referenceable) symbol and its market metadata. */
export interface Instrument {
  /** Canonical symbol, e.g. `600000.SH`, `00700.HK`, `AAPL.US`. */
  readonly symbol: string
  readonly exchange: Exchange
  readonly code: string
  /** Display name, in the language the provider serves (Chinese for CN and HK). */
  readonly name: string | null
  readonly type: InstrumentType | null
  readonly currency: Currency
}

/** One executed trade. The unit of record; positions are derived from these. */
export interface Trade {
  readonly id: number
  /** Canonical symbol. */
  readonly symbol: string
  readonly exchange: Exchange
  readonly currency: Currency
  /** Display name resolved from the instrument index; may be absent offline. */
  readonly name: string | null
  readonly side: TradeSide
  readonly quantity: number
  readonly price: number
  /** Trade date, `YYYY-MM-DD`. */
  readonly tradedAt: string
  /** Why the trade was made. Free text, the analysis key. */
  readonly motive: string | null
  readonly note: string | null
  /** Insert time, ISO-8601 UTC. */
  readonly createdAt: string
}

/** The writable projection of a trade: everything except server-owned fields. */
export type TradeInput = Omit<Trade, 'id' | 'createdAt' | 'exchange' | 'currency' | 'name'> & {
  /** Accepted for convenience; the server re-derives exchange/currency from it. */
  readonly symbol: string
}

/** One daily bar, exactly as stored. */
export interface PriceBar {
  readonly symbol: string
  /** Trading date, `YYYY-MM-DD`. */
  readonly date: string
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly amount: number
}

/** The latest daily view of one symbol: the close, and the move since the one before. */
export interface Quote {
  readonly symbol: string
  readonly name: string | null
  readonly exchange: Exchange
  readonly currency: Currency
  /** The most recent daily close. */
  readonly price: number
  /** The close of the previous trading day, or `null` for a single-bar history. */
  readonly prevClose: number | null
  readonly open: number | null
  readonly high: number | null
  readonly low: number | null
  readonly volume: number | null
  /** The trading date `price` belongs to. */
  readonly date: string
  readonly change: number | null
  readonly changePct: number | null
  /** True when the close is older than the configured staleness window. */
  readonly stale: boolean
}

/** One open position, fully derived from the trade log plus the latest closes. */
export interface Position {
  readonly symbol: string
  readonly exchange: Exchange
  readonly currency: Currency
  readonly name: string | null
  readonly quantity: number
  /** Moving-average cost per share. */
  readonly avgCost: number
  /** `quantity * avgCost`. */
  readonly costBasis: number
  /** Latest daily close, or `null` when no bar has ever been fetched. */
  readonly price: number | null
  readonly prevClose: number | null
  /** The trading date behind `price`. */
  readonly priceDate: string | null
  /** `quantity * price`, or `null` without a price. */
  readonly marketValue: number | null
  readonly unrealizedPnl: number | null
  readonly unrealizedPct: number | null
  /** Change against the previous close, for the position as a whole. */
  readonly dayPnl: number | null
  readonly dayPnlPct: number | null
  /** Already-booked profit on the shares that were sold. */
  readonly realizedPnl: number
  readonly tradeCount: number
  readonly firstTradeAt: string
  readonly lastTradeAt: string
  /** Share of the portfolio's converted market value; 0 when nothing has a price. */
  readonly weight: number
}

/** A symbol that has been fully closed out, kept for realized-P&L statistics. */
export interface ClosedPosition {
  readonly symbol: string
  readonly exchange: Exchange
  readonly currency: Currency
  readonly name: string | null
  readonly realizedPnl: number
  readonly proceeds: number
  readonly costSold: number
  readonly tradeCount: number
  readonly openedAt: string
  readonly closedAt: string
}

/** One row of a grouped breakdown (by market, or by motive). */
export interface BreakdownRow {
  /** Stable key: an exchange code, or the motive text. */
  readonly key: string
  /** Display label. */
  readonly label: string
  readonly trades: number
  readonly realizedPnl: number
  readonly unrealizedPnl: number
  readonly totalPnl: number
  /** Market value in the row's own currency terms, converted to base. */
  readonly marketValue: number
  /** Share of the largest absolute contribution; used for bar widths. */
  readonly share: number
}

/**
 * One currency's own, unconverted subtotals. A converted portfolio total is a
 * convenience; this is the booked truth, so the two are always shown together.
 */
export interface NativeTotal {
  readonly currency: Currency
  readonly marketValue: number
  readonly cost: number
  readonly unrealizedPnl: number
  readonly realizedPnl: number
}

/** Every portfolio-level number the dashboard shows. */
export interface PortfolioStats {
  readonly baseCurrency: Currency
  /** Market value of every open position, converted to the base currency. */
  readonly totalMarketValue: number
  /** Cost basis of every open position, converted to the base currency. */
  readonly totalCost: number
  readonly totalUnrealizedPnl: number
  /** `totalUnrealizedPnl / totalCost`, or `null` with a zero cost basis. */
  readonly totalUnrealizedPct: number | null
  readonly totalRealizedPnl: number
  readonly totalPnl: number
  readonly totalPnlPct: number | null
  readonly dayPnl: number
  readonly dayPnlPct: number | null
  readonly openPositions: number
  readonly closedPositions: number
  readonly tradeCount: number
  /** Closed positions that ended in profit, over all closed positions. */
  readonly winRate: number | null
  readonly avgWin: number | null
  readonly avgLoss: number | null
  /** Gross profit over gross loss; `null` when nothing lost money yet. */
  readonly profitFactor: number | null
  readonly bestSymbol: string | null
  readonly worstSymbol: string | null
  readonly byMarket: readonly BreakdownRow[]
  readonly byMotive: readonly BreakdownRow[]
  /** Per-currency subtotals, never converted. */
  readonly native: readonly NativeTotal[]
  /** The rate table the conversion used: units of each currency per 1 USD. */
  readonly rates: Readonly<Record<Currency, number>>
}

/** A price point on the portfolio equity curve. */
export interface EquityPoint {
  readonly date: string
  readonly marketValue: number
  readonly cost: number
}

/**
 * Which layer supplied the market-data API key.
 *
 * Ordered by precedence: a dashboard setting beats the process environment,
 * which beats the checkout's `.env`, which beats the plugin row's `config`.
 */
export type ApiKeySource = 'settings' | 'env' | 'dotenv' | 'config' | 'none'

/** What the price feed is doing, and what it last managed to do. */
export interface QuoteFeedStatus {
  readonly baseUrl: string
  readonly apiKeySource: ApiKeySource
  /** Whether the service accepts batched kline requests for this key. */
  readonly batchSupported: boolean
  /** Set when the last refresh failed; the message is user-facing. */
  readonly lastError: string | null
  readonly lastRefreshAt: string | null
  /** Symbols the last refresh could not price. */
  readonly unresolved: readonly string[]
  /** Newest trading date held across all positions, or `null` before any fetch. */
  readonly latestDate: string | null
}

/** Where the current rates came from, and whether they can be refreshed at all. */
export interface FxStatus {
  /**
   * Whether this deployment mounts a web capability (`ctx.web`).
   *
   * False in a headless composition: the dashboard then keeps the stored pair and
   * says so, rather than reporting a refresh that was never attempted.
   */
  readonly available: boolean
  /** Which route wrote the current rates. */
  readonly source: FxRateSource
  /** The endpoint id or route that answered, for display. */
  readonly provider: string | null
  /** When this plugin last wrote the rates. */
  readonly updatedAt: string | null
  /** The rate's own date as the provider stated it, when it states one. */
  readonly asOf: string | null
  /** Why the last automatic refresh failed, or `null` when it succeeded. */
  readonly error: string | null
}

/** The user-editable configuration, with the secret reduced to a presence flag. */
export interface PortfolioSettings {
  readonly apiKeyConfigured: boolean
  readonly apiKeySource: ApiKeySource
  readonly baseCurrency: Currency
  /** Units of HKD and CNY that one USD buys. Used only to convert totals. */
  readonly rates: Readonly<Record<'HKD' | 'CNY', number>>
  /** How those two rates were obtained, and when. */
  readonly fx: FxStatus
  /** How often the background job re-reads daily bars. */
  readonly refreshIntervalMinutes: number
  readonly autoRefresh: boolean
  readonly dbPath: string
  /** How many instruments the local name index holds. */
  readonly instrumentCount: number
  /** When the instrument index was last rebuilt. */
  readonly instrumentsSyncedAt: string | null
}

/** What one rate-refresh request did, as the browser half reads it. */
export interface FxRefreshResult {
  /** True when the stored rates are current — including "fetched a minute ago". */
  readonly ok: boolean
  /** True when this call actually ran the network routes. */
  readonly refreshed: boolean
  /** The message to show when `ok` is false, or `null`. */
  readonly error: string | null
  /** Every route that was tried and refused, in the order they were tried. */
  readonly failures: readonly FxFailure[]
}

/** One candidate from the local instrument index. */
export interface SymbolMatch {
  readonly symbol: string
  readonly name: string | null
  readonly exchange: Exchange
  readonly currency: Currency
  readonly type: InstrumentType | null
}

/** The complete dashboard payload: one request fills every tab. */
export interface PortfolioState {
  readonly trades: readonly Trade[]
  readonly positions: readonly Position[]
  readonly closed: readonly ClosedPosition[]
  readonly quotes: readonly Quote[]
  readonly stats: PortfolioStats
  readonly settings: PortfolioSettings
  readonly feed: QuoteFeedStatus
  /** Motive strings already used, offered as suggestions in the trade form. */
  readonly motives: readonly string[]
  readonly generatedAt: string
}

/** An error the HTTP layer turns into a `4xx` with a user-facing message. */
export class PortfolioError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'PortfolioError'
    this.status = status
  }
}
