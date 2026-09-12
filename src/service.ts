/**
 * The portfolio service: the one place that reads and writes portfolio state.
 *
 * Both the HTTP layer and (potentially) a future model-facing Tool talk to this
 * object rather than to the database, so validation, price refresh, and the
 * materialized `holdings` projection all happen on exactly one path.
 *
 * ## Two independent syncs
 *
 *   * **Prices** — daily bars for the symbols that have an open position. One
 *     batched request per five symbols, idempotent, driven by a configured
 *     interval rather than by a cache window: the data only changes once a day.
 *   * **Instruments** — the full symbol/name list of every exchange, fetched once
 *     and rebuilt weekly. This is what makes search work for all ~23,000
 *     instruments offline, with no API key and no per-keystroke request.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PortfolioDatabase, databasePath, displayPath, STALE_AFTER_DAYS } from './db.ts'
import type { StoredSettings } from './db.ts'
import { acquireRates } from './fx.ts'
import type { FxAcquisition, FxRateSource, WebCapability } from './fx.ts'
import { computeSymbolStats } from './indicators.ts'
import { createMentionMatcher } from './mentions.ts'
import type { MentionMatch, MentionTarget } from './mentions.ts'
import { buildEquityCurve, convert, derivePortfolio, foldLedgers, rateTable, sortTrades } from './portfolio.ts'
import type { Rates } from './portfolio.ts'
import { codeOfSymbol, currencyOfSymbol, exchangeOfSymbol, normalizeSymbol } from './symbols.ts'
import { TickFlowClient, TickFlowError } from './tickflow.ts'
import { PortfolioError } from './types.ts'
import type {
  ApiKeySource, Currency, EquityPoint, FxRefreshResult, FxStatus, Instrument, MentionFeed,
  PortfolioReviewSnapshot, PortfolioSettings, PortfolioState, PortfolioStats, Position, QuoteFeedStatus, ReviewMotive,
  ReviewNativeTotal, ReviewRow, ReviewSignals, SymbolBar, SymbolMatch, SymbolStats, Trade, TradeInput,
} from './types.ts'

/** Daily bars requested per symbol: roughly a trading year. */
const HISTORY_BARS = 260

/**
 * Cached bars below which a series is treated as absent for the equity curve.
 * A quote-path fetch may leave a handful of bars behind; that is enough to price
 * a position and not enough to draw its history.
 */
const MIN_HISTORY_BARS = 30

/**
 * Daily bars loaded for a symbol the log has just met.
 *
 * Deliberately a *recent* window rather than {@link HISTORY_BARS}: a full year of
 * bars for a stock the user just typed is a request nobody asked for. 90 calendar
 * days is roughly 60 trading days, which clears {@link MIN_HISTORY_BARS} — so the
 * position is valued AND the equity curve draws from the first day, instead of
 * staying blank until the next full refresh. That refresh still widens the series
 * to {@link HISTORY_BARS} on its own schedule.
 */
const RECENT_BARS = 90

/**
 * How long a write waits for that window before answering without it.
 *
 * A latency budget, not a correctness one: the trade is committed before the
 * fetch starts, and the provider's own timeout is 20 seconds. A panel that hangs
 * that long behind a save button is worse than a price that appears a minute
 * later, so the wait is capped and the fetch carries on in the background.
 */
const RECENT_BARS_WAIT_MS = 2_500

/** How long the instrument index stays fresh before a rebuild is attempted. */
const INSTRUMENT_INDEX_DAYS = 7

/** How long a failed price refresh suppresses the next automatic attempt. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000

/** The watermark key for the instrument index's last successful rebuild. */
const INSTRUMENTS_SYNCED_KEY = 'instrumentsSyncedAt'

/**
 * The watermark for the last successful price refresh.
 *
 * The in-memory field alone is not enough to answer "when was this last
 * refreshed?": a plugin reload or a `dsh` restart clears it while the bars it
 * fetched are still on disk, which used to render as an empty timestamp in the
 * panel header. The database remembers instead.
 */
const PRICES_REFRESHED_KEY = 'pricesRefreshedAt'

/**
 * The watermark for the last day each symbol was asked about.
 *
 * Stored as one JSON object under one key: it is a small map that is rewritten
 * whole, and a meta row per holding would be a lot of rows to keep pruned.
 */
const PRICES_ATTEMPTED_KEY = 'pricesAttemptedOn'

/** Where the current rates came from, and when they were written. */
const FX_META = {
  source: 'fxSource',
  provider: 'fxProvider',
  updatedAt: 'fxUpdatedAt',
  asOf: 'fxAsOf',
  error: 'fxError',
} as const

/** The environment variable, and `.env` key, that may carry the API key. */
const API_KEY_ENV = 'TICKFLOW_API_KEY'

/**
 * Where `.env` is looked for by default.
 *
 * `lib/index.js` is one level below the package root, and the dev copy the
 * profile row may point at sits beside it, so `..` from this module resolves to
 * the same checkout either way.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Parse one `KEY=VALUE` line out of a `.env` body.
 *
 * A deliberate subset of the format — bare or quoted values, `#` comments,
 * optional `export` — because the only consumer is one variable and a full
 * dotenv parser would be a dependency for its own sake. The file is never
 * allowed to mutate `process.env`: a plugin has no business editing the host's
 * environment, and the resolved source is reported through the feed status so
 * the user can see which layer supplied the key.
 * @param body - the file's contents.
 * @param name - the variable to look up.
 * @returns the value, or `undefined` when the key is absent.
 */
export function parseDotenv(body: string, name: string): string | undefined {
  for (const line of body.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line)
    if (match === null || match[1] !== name) continue
    const raw = (match[2] ?? '').trim()
    const unquoted = /^(['"])([\s\S]*)\1$/u.exec(raw)
    return (unquoted === null ? raw : unquoted[2])?.trim() || undefined
  }
  return undefined
}

/**
 * The local calendar day of an instant, as `YYYY-MM-DD`.
 *
 * Local, not UTC: "same day" has to mean the day the person reading the panel is
 * in, and the host runs on their machine. A bad timestamp yields an empty string,
 * which never equals a real day and therefore reads as "stale".
 * @param iso - an ISO-8601 instant.
 * @returns the local day key.
 */
function localDay(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * The newest trading day the provider can have published, as `YYYY-MM-DD`.
 *
 * Daily bars are end-of-day, so day D's bar is served on D+1: on any given day
 * the newest bar that can exist belongs to the previous weekday, and a series
 * holding it has nothing left to collect. Exchange holidays are not in any
 * calendar this plugin keeps — which is precisely why the attempt watermark
 * exists, so a holiday is asked about once rather than on every open.
 * @param now - the current instant.
 * @returns the date, in the caller's own calendar.
 */
function latestExpectedDate(now: Date): string {
  const at = new Date(now.getTime())
  do {
    at.setDate(at.getDate() - 1)
  } while (at.getDay() === 0 || at.getDay() === 6)
  return localDay(at.toISOString())
}

/** Resolved plugin configuration. */
export interface PortfolioServiceOptions {
  /** Directory holding the database file. */
  readonly dataDir: string
  /** Provider endpoint override; `undefined` picks the tier's default. */
  readonly apiBase?: string | undefined
  /** Key from the plugin row's config; the dashboard setting can override it. */
  readonly configApiKey?: string | undefined
  /** Injectable clock, for tests. */
  readonly now?: (() => Date) | undefined
  /** Injectable fetch, for tests. */
  readonly fetchImpl?: typeof fetch | undefined
  /** Where to look for `.env`. Defaults to the checkout's own file. */
  readonly dotenvPath?: string | undefined
  /**
   * The harness web capability, resolved per call.
   *
   * A getter rather than a value: the row may mount before a provider exists, and
   * a headless composition has none at all — in which case the rates stay as the
   * user left them and the dashboard says so.
   */
  readonly web?: (() => WebCapability | undefined) | undefined
}

// ─── the review read model ───────────────────────────────────────────────────

/** Trading bars one review measures each holding over. */
const REVIEW_BARS = 60

/**
 * The window a review quotes as "recent", in trading days.
 *
 * Thirty sessions is about a month of trading, and it is also one of the
 * windows {@link RETURN_WINDOWS} already publishes — a review that invented its
 * own lookback would be a second definition of "one month" in the same package.
 */
const REVIEW_WINDOW_DAYS = 30

/**
 * The same window, in portfolio curve points.
 *
 * The equity curve is one point per calendar day, not per session, so the
 * portfolio's own recent move is measured over calendar points while a
 * holding's comes from its stored bars.
 */
const REVIEW_WINDOW_POINTS = 20

/** Weights at which a single position is called moderate or high concentration. */
const CONCENTRATION_MODERATE = 0.25
const CONCENTRATION_HIGH = 0.4

/** Positions listed in each direction. */
const REVIEW_ROW_LIMIT = 8

/** Two money amounts are the same number when they agree to a cent. */
const CENT = 0.005

/**
 * Band one position's weight.
 * @param weight - the position's share of the converted portfolio.
 * @returns the band the review states.
 */
function concentrationLabel(weight: number): ReviewSignals['concentrationLabel'] {
  if (weight >= CONCENTRATION_HIGH) return 'high'
  if (weight >= CONCENTRATION_MODERATE) return 'moderate'
  return 'low'
}

/**
 * Derive every finding a review leads with from the rows it already measured.
 *
 * Pure and local: these are the sentences "how is my portfolio doing" is really
 * asking for, and computing them here means one place to change a threshold
 * rather than one place per caller.
 * @param rows - the measured holdings.
 * @param stats - the portfolio's own aggregates.
 * @param totalMarketValue - the converted total the weights are shares of.
 * @returns the findings.
 */
function signalsOf(rows: readonly ReviewRow[], stats: PortfolioStats, totalMarketValue: number): ReviewSignals {
  const ranked = [...rows].sort((left, right) => right.weight - left.weight)
  const top = ranked[0] ?? null
  const priced = rows.filter(row => row.price !== null)
  const staleCost = rows
    .filter(row => row.priceAgeDays !== null && row.priceAgeDays > STALE_AFTER_DAYS)
    .reduce((sum, row) => sum + row.costBase, 0)
  const byVolatility = [...priced]
    .filter(row => row.volatility20 !== null)
    .sort((left, right) => (right.volatility20 ?? 0) - (left.volatility20 ?? 0))[0] ?? null
  const byDrawdown = [...priced]
    .filter(row => row.maxDrawdown60 !== null)
    .sort((left, right) => (right.maxDrawdown60 ?? 0) - (left.maxDrawdown60 ?? 0))[0] ?? null
  const unrealized = rows.map(row => row.unrealizedPnl).filter((value): value is number => value !== null)
  return {
    concentration: top?.weight ?? 0,
    concentrationSymbol: top === null ? null : top.symbol,
    concentrationLabel: concentrationLabel(top?.weight ?? 0),
    topThree: ranked.slice(0, 3).reduce((sum, row) => sum + row.weight, 0),
    winners: unrealized.filter(value => value > CENT).length,
    losers: unrealized.filter(value => value < -CENT).length,
    flat: unrealized.filter(value => Math.abs(value) <= CENT).length,
    staleShare: stats.totalCost > 0 ? staleCost / stats.totalCost : 0,
    unpriced: rows.length - priced.length,
    biggestSymbol: totalMarketValue > 0 ? top?.symbol ?? null : null,
    mostVolatileSymbol: byVolatility?.symbol ?? null,
    mostVolatile: byVolatility?.volatility20 ?? null,
    deepestDrawdownSymbol: byDrawdown?.symbol ?? null,
    deepestDrawdown: byDrawdown?.maxDrawdown60 ?? null,
  }
}

/**
 * Pre-render the findings, in the order a review should state them.
 *
 * The wording is deliberately factual — it reports what the numbers are, not
 * what to do about them. Advice is the reviewing model's job, because the right
 * advice depends on what the user just asked and on what the research turns up.
 * @param stats - the portfolio's aggregates.
 * @param signals - the derived findings.
 * @param rows - the measured holdings.
 * @param baseCurrency - the currency the amounts are stated in.
 * @param windowReturnPct - the portfolio's recent move, when known.
 * @returns one line per finding.
 */
function notesOf(
  stats: PortfolioStats,
  signals: ReviewSignals,
  rows: readonly ReviewRow[],
  baseCurrency: Currency,
  windowReturnPct: number | null,
): string[] {
  const notes: string[] = []
  const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`
  notes.push(
    `持仓 ${String(rows.length)} 只，市值 ${stats.totalMarketValue.toFixed(0)} ${baseCurrency}`
    + `（成本 ${stats.totalCost.toFixed(0)}），浮动 ${stats.totalUnrealizedPnl >= 0 ? '+' : ''}${stats.totalUnrealizedPnl.toFixed(0)}`
    + `${stats.totalUnrealizedPct === null ? '' : `（${pct(stats.totalUnrealizedPct)}）`}`
    + `，已实现 ${stats.totalRealizedPnl >= 0 ? '+' : ''}${stats.totalRealizedPnl.toFixed(0)}`,
  )
  if (windowReturnPct !== null) {
    notes.push(`按日线收盘价回溯，最近约一个月（20 个交易日）组合市值${windowReturnPct >= 0 ? '上涨' : '下跌'} ${pct(Math.abs(windowReturnPct))}`)
  }
  const nameOf = (symbol: string | null): string => symbol === null
    ? '—'
    : rows.find(row => row.symbol === symbol)?.name ?? symbol
  if (signals.concentrationSymbol !== null) {
    notes.push(
      `集中度${signals.concentrationLabel === 'high' ? '偏高' : signals.concentrationLabel === 'moderate' ? '中等' : '较低'}：`
      + `第一重仓 ${nameOf(signals.concentrationSymbol)} ${pct(signals.concentration)}，前三合计 ${pct(signals.topThree)}`,
    )
  }
  notes.push(`浮盈 ${String(signals.winners)} 只、浮亏 ${String(signals.losers)} 只、基本持平 ${String(signals.flat)} 只`)
  if (signals.mostVolatileSymbol !== null && signals.mostVolatile !== null) {
    notes.push(`波动最大的是 ${nameOf(signals.mostVolatileSymbol)}（20 日年化波动率 ${pct(signals.mostVolatile)}）`)
  }
  if (signals.deepestDrawdownSymbol !== null && signals.deepestDrawdown !== null && signals.deepestDrawdown > 0) {
    notes.push(`近 60 个交易日回撤最深的是 ${nameOf(signals.deepestDrawdownSymbol)}（${pct(signals.deepestDrawdown)}）`)
  }
  const groups = stats.byMotive
  if (groups.length > 0) {
    const best = [...groups].sort((left, right) => right.totalPnl - left.totalPnl)[0]
    const worst = [...groups].sort((left, right) => left.totalPnl - right.totalPnl)[0]
    if (best !== undefined && worst !== undefined) {
      notes.push(`按交易动机：${best.label} ${best.totalPnl >= 0 ? '+' : ''}${best.totalPnl.toFixed(0)} 最好，${worst.label} ${worst.totalPnl.toFixed(0)} 最差`)
    }
  }
  return notes
}

/**
 * Pre-render what this read model cannot answer.
 *
 * A review is asked for two things and this half is only one of them, so the
 * caveat list is part of the answer rather than a footnote: an unstated gap is
 * one a reader fills with an assumption.
 * @param signals - the derived findings.
 * @returns one line per caveat.
 */
function caveatsOf(signals: ReviewSignals): string[] {
  const caveats = [
    '以上全部来自本地日线（收盘价、不含分时）与交易记录，不含行业分类，也不含券商预期、研报、公司公告与新闻。',
    '第 2 部分（未来约一个月的走势与催化）是研究任务：请用当前的搜索 / 抓取工具按标的一次查清，并标出信息日期与来源。',
  ]
  if (signals.unpriced > 0) {
    caveats.push(`有 ${String(signals.unpriced)} 只持仓还没有任何日线，未计入市值与盈亏。`)
  }
  if (signals.staleShare > 0) {
    caveats.push(`约 ${(signals.staleShare * 100).toFixed(0)}% 的成本对应的最新收盘价已超过 ${String(STALE_AFTER_DAYS)} 天，先刷新行情再看结论。`)
  }
  return caveats
}

/** Everything the dashboard needs, plus the operations that change it. */
export class PortfolioService {
  readonly db: PortfolioDatabase
  private readonly options: PortfolioServiceOptions
  private refreshedAt: string | null = null
  private lastError: string | null = null
  private lastFailureAt = 0
  private unresolved: string[] = []
  private indexSyncing = false
  private batchSupported = true
  /** `.env` is read once per path; the file changes only when someone edits it. */
  private readonly dotenvCache = new Map<string, string | undefined>()
  /** The rate fetch currently in flight, shared by every caller asking for one. */
  private fxInFlight: Promise<FxAcquisition> | null = null
  /**
   * The price refresh currently in flight.
   *
   * The panel opening and the background scheduler can arrive together, and both
   * would ask the provider for the same bars; the second caller rides this one.
   */
  private refreshInFlight: Promise<boolean> | null = null
  /** Set by {@link close}; every background continuation checks it first. */
  private closed = false
  /** The matcher for the current portfolio, rebuilt when the portfolio changes. */
  private matcherCache: { signature: string, match: (text: string) => MentionMatch[] } | null = null
  /** Where `/mentions` reads from; wired by the host plugin's projection. */
  private mentionSource: ((sessionId: string) => MentionFeed) | null = null

  constructor(options: PortfolioServiceOptions) {
    this.options = options
    this.db = new PortfolioDatabase(databasePath(options.dataDir))
  }

  /**
   * Close the database handle.
   *
   * The refresh and index syncs both continue after their caller has returned
   * (the plugin's disposer must not wait on the network), so closing sets a flag
   * that makes those continuations stop before touching a closed handle.
   */
  close(): void {
    this.closed = true
    this.db.close()
  }

  /**
   * The market-data key in effect, and where it came from.
   *
   * An explicit dashboard setting wins over the environment so that a user who
   * pastes a key into the UI sees it take effect immediately; the environment
   * variable is the fallback for a headless deployment. The key is optional —
   * every endpoint this plugin reads is served by the keyless tier too.
   * @returns the key and its source.
   */
  private resolveApiKey(): { key: string | undefined, source: ApiKeySource } {
    const stored = this.db.readSettings().apiKey.trim()
    if (stored !== '') return { key: stored, source: 'settings' }
    const fromEnv = process.env[API_KEY_ENV]?.trim() ?? ''
    if (fromEnv !== '') return { key: fromEnv, source: 'env' }
    const fromFile = this.fromDotenv(API_KEY_ENV)
    if (fromFile !== undefined) return { key: fromFile, source: 'dotenv' }
    const fromConfig = this.options.configApiKey?.trim() ?? ''
    if (fromConfig !== '') return { key: fromConfig, source: 'config' }
    return { key: undefined, source: 'none' }
  }

  /**
   * Read a key from the configured `.env` file.
   * @param name - the variable to look up.
   * @returns the value, or `undefined` when the file or key is absent.
   */
  private fromDotenv(name: string): string | undefined {
    const path = this.options.dotenvPath ?? `${PACKAGE_ROOT}/.env`
    const cached = this.dotenvCache.get(path)
    if (cached !== undefined || this.dotenvCache.has(path)) return cached
    let value: string | undefined
    try {
      value = parseDotenv(readFileSync(path, 'utf8'), name)
    } catch {
      // No `.env` is the common case, not a failure.
    }
    this.dotenvCache.set(path, value)
    return value
  }

  /**
   * Build a client for the current key.
   * @returns the client.
   */
  private client(): TickFlowClient {
    return new TickFlowClient({
      apiKey: this.resolveApiKey().key,
      baseUrl: this.options.apiBase,
      ...this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl },
    })
  }

  /** The clock, honoring an injected one. */
  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  /**
   * Build the complete dashboard payload.
   * @returns every row and statistic the UI renders.
   */
  state(): PortfolioState {
    const now = this.now()
    const settings = this.db.readSettings()
    const trades = this.db.listTrades()
    const symbols = [...new Set(trades.map(trade => trade.symbol))]
    const names = this.db.namesOf(symbols)
    const quotes = this.db.latestQuotes(now, names)
    const derived = derivePortfolio({
      trades,
      quotes,
      baseCurrency: settings.baseCurrency,
      rates: this.rates(settings),
      now,
    })
    return {
      trades,
      positions: derived.positions,
      closed: derived.closed,
      quotes,
      stats: derived.stats,
      settings: this.publicSettings(settings),
      feed: this.feedStatus(),
      motives: this.db.listMotives(),
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Everything a portfolio review states about the portfolio as it stands now.
   *
   * Local and derived: one pass over the trade log, the latest stored closes and
   * the stored daily series, with no provider call and no clock beyond "how old
   * is this bar". That makes the answer reproducible, available offline, and
   * cheap enough to hand a model — which is the point, because the alternative
   * is four separate reads the reviewing model has to reconcile itself.
   *
   * The forward-looking half of a review is deliberately absent: news, analyst
   * views and guidance are not stored facts and cannot be computed from a price
   * series, so they belong to the caller's own search tools.
   * @returns the review read model.
   */
  reviewSnapshot(): PortfolioReviewSnapshot {
    const now = this.now()
    const settings = this.db.readSettings()
    const rates = this.rates(settings)
    const baseCurrency = settings.baseCurrency
    const trades = this.db.listTrades()
    const symbols = [...new Set(trades.map(trade => trade.symbol))]
    const names = this.db.namesOf(symbols)
    const quotes = this.db.latestQuotes(now, names)
    const derived = derivePortfolio({ trades, quotes, baseCurrency, rates, now })
    const stats = derived.stats

    // One query for the whole portfolio: the stored series is the only source a
    // review measures from, so it is read once and folded into the rows below.
    const series = this.db.readBarsFor(symbols, REVIEW_BARS)
    const ageOf = (date: string | null): number | null => {
      if (date === null) return null
      const at = new Date(`${date}T00:00:00`)
      if (Number.isNaN(at.getTime())) return null
      return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000))
    }

    const rows: ReviewRow[] = derived.positions.map((position: Position) => {
      const bars = series.get(position.symbol) ?? []
      const measured = computeSymbolStats(bars)
      const window = measured.returns.find(entry => entry.days === REVIEW_WINDOW_DAYS)?.pct ?? null
      const nativeValue = position.quantity * (position.price ?? 0)
      return {
        symbol: position.symbol,
        name: position.name ?? names.get(position.symbol) ?? null,
        exchange: position.exchange,
        currency: position.currency,
        quantity: position.quantity,
        avgCost: position.avgCost,
        price: position.price,
        priceDate: position.priceDate,
        marketValueNative: position.price === null ? null : nativeValue,
        marketValueBase: position.price === null ? null : convert(nativeValue, position.currency, baseCurrency, rates),
        weight: position.weight,
        costBase: convert(position.costBasis, position.currency, baseCurrency, rates),
        unrealizedPnl: position.unrealizedPnl,
        unrealizedPct: position.unrealizedPct,
        dayPnlPct: position.dayPnlPct,
        holdingDays: position.holdingDays,
        tradeCount: position.tradeCount,
        return30Pct: window,
        volatility20: measured.volatility20,
        maxDrawdown60: measured.maxDrawdown60,
        rangePosition60: measured.rangePosition60,
        ma20Gap: measured.ma20Gap,
        streak: measured.streak,
        bars: bars.length,
        priceAgeDays: ageOf(position.priceDate),
      }
    })

    // Per-currency subtotals, each computed inside its own currency rather than
    // summed from converted values: a converted total is a convenience and must
    // never be presented as the booked number.
    const nativeCells = new Map<Currency, { marketValue: number, cost: number }>()
    for (const position of derived.positions) {
      const cell = nativeCells.get(position.currency) ?? { marketValue: 0, cost: 0 }
      cell.marketValue += position.price === null ? 0 : position.quantity * position.price
      cell.cost += position.costBasis
      nativeCells.set(position.currency, cell)
    }
    const native: ReviewNativeTotal[] = [...nativeCells]
      .map(([currency, cell]) => ({
        currency,
        marketValue: cell.marketValue,
        cost: cell.cost,
        unrealizedPnl: cell.marketValue - cell.cost,
        weight: stats.totalMarketValue > 0
          ? convert(cell.marketValue, currency, baseCurrency, rates) / stats.totalMarketValue
          : 0,
      }))
      .sort((left, right) => right.marketValue - left.marketValue)

    // The portfolio's own recent move, measured the same way a holding's is:
    // against the stored closes, so it needs no provider round trip. It is a
    // mark-to-market path over the *current* quantities, not a money-weighted
    // return — the caveat list says so rather than leaving it implied.
    const cutoffAt = new Date(now.getTime() - 60 * 86_400_000)
    const cutoff = `${String(cutoffAt.getFullYear())}-${String(cutoffAt.getMonth() + 1).padStart(2, '0')}-${String(cutoffAt.getDate()).padStart(2, '0')}`
    const curve = buildEquityCurve({
      trades,
      closes: this.db.readCloses(symbols),
      baseCurrency,
      rates,
    }).filter(point => point.date >= cutoff)
    const recent = curve.slice(-REVIEW_WINDOW_POINTS)
    const first = recent[0]
    const last = recent.at(-1)
    const windowReturnPct = first !== undefined && last !== undefined && first.marketValue > 0
      ? last.marketValue / first.marketValue - 1
      : null

    const signals = signalsOf(rows, stats, stats.totalMarketValue)
    const rankedGainers = rows
      .filter(row => (row.unrealizedPnl ?? 0) > CENT)
      .sort((left, right) => (right.unrealizedPnl ?? 0) - (left.unrealizedPnl ?? 0))
    const rankedLosers = rows
      .filter(row => (row.unrealizedPnl ?? 0) < -CENT)
      .sort((left, right) => (left.unrealizedPnl ?? 0) - (right.unrealizedPnl ?? 0))
    const byMotive: ReviewMotive[] = stats.byMotive.map(row => ({
      label: row.label,
      realizedPnl: row.realizedPnl,
      unrealizedPnl: row.unrealizedPnl,
      totalPnl: row.totalPnl,
      trades: row.trades,
    }))

    return {
      generatedAt: now.toISOString(),
      baseCurrency,
      priceDate: this.db.latestPriceDate(),
      totals: {
        marketValue: stats.totalMarketValue,
        cost: stats.totalCost,
        unrealizedPnl: stats.totalUnrealizedPnl,
        unrealizedPct: stats.totalUnrealizedPct,
        realizedPnl: stats.totalRealizedPnl,
        totalPnl: stats.totalPnl,
        dayPnl: stats.dayPnl,
        dayPnlPct: stats.dayPnlPct,
        openPositions: stats.openPositions,
        closedPositions: stats.closedPositions,
        tradeCount: stats.tradeCount,
        winRate: stats.winRate,
        profitFactor: stats.profitFactor,
      },
      native,
      rows,
      windowReturnPct,
      topGainers: rankedGainers.slice(0, REVIEW_ROW_LIMIT),
      topLosers: rankedLosers.slice(0, REVIEW_ROW_LIMIT),
      byMarket: stats.byMarket,
      byMotive,
      signals,
      notes: notesOf(stats, signals, rows, baseCurrency, windowReturnPct),
      caveats: caveatsOf(signals),
    }
  }

  /**
   * The rate table every conversion pivots through.
   * @param settings - the stored settings.
   * @returns units of each currency per 1 USD.
   */
  private rates(settings: StoredSettings): Rates {
    return rateTable(settings.usdHkd, settings.usdCny)
  }

  /**
   * Report where the current rates came from.
   * @returns the rate provenance the settings page renders.
   */
  private fxStatus(): FxStatus {
    const stored = this.db.readMeta(FX_META.source)
    const source: FxRateSource = stored === 'web-fetch' || stored === 'web-search' || stored === 'manual'
      ? stored
      : 'default'
    return {
      available: this.options.web?.() !== undefined,
      source,
      provider: this.metaOrNull(FX_META.provider),
      updatedAt: this.metaOrNull(FX_META.updatedAt),
      asOf: this.metaOrNull(FX_META.asOf),
      error: this.metaOrNull(FX_META.error),
    }
  }

  /**
   * Read a watermark, treating the empty string as "nothing recorded".
   *
   * Clearing a watermark writes `''` (the meta table stores JSON strings), and an
   * empty provider or error must reach the UI as `null`, not as a blank row.
   * @param key - the watermark name.
   * @returns the value, or `null`.
   */
  private metaOrNull(key: string): string | null {
    const value = this.db.readMeta(key)
    return value === null || value === '' ? null : value
  }

  /**
   * Project stored settings for the browser, reducing the secret to a flag.
   * @param settings - the stored settings.
   * @returns the wire-safe settings.
   */
  private publicSettings(settings: StoredSettings): PortfolioSettings {
    return {
      apiKeyConfigured: this.resolveApiKey().source !== 'none',
      apiKeySource: this.resolveApiKey().source,
      baseCurrency: settings.baseCurrency,
      rates: { HKD: settings.usdHkd, CNY: settings.usdCny },
      fx: this.fxStatus(),
      refreshIntervalMinutes: settings.refreshIntervalMinutes,
      autoRefresh: settings.autoRefresh,
      mentionPopup: settings.mentionPopup,
      dbPath: displayPath(databasePath(this.options.dataDir)),
      instrumentCount: this.db.instrumentCount(),
      instrumentsSyncedAt: this.db.readMeta(INSTRUMENTS_SYNCED_KEY),
    }
  }

  /**
   * Report the price feed's current posture.
   * @returns the feed status.
   */
  private feedStatus(): QuoteFeedStatus {
    return {
      baseUrl: this.options.apiBase ?? this.client().endpoint,
      apiKeySource: this.resolveApiKey().source,
      lastError: this.lastError,
      lastRefreshAt: this.refreshedAt ?? this.metaOrNull(PRICES_REFRESHED_KEY),
      unresolved: this.unresolved,
      latestDate: this.db.latestPriceDate(),
      batchSupported: this.batchSupported,
    }
  }

  /**
   * One symbol's trailing daily bars and the indicators measured from them.
   *
   * The stored series is the only source: expanding a row is a local read, so it
   * costs no provider quota and works offline. A symbol whose history is shorter
   * than a window answers with `null` for that window rather than with a number
   * measured over fewer bars.
   * @param symbol - the symbol to read, in any accepted spelling.
   * @param limit - how many trailing bars to return.
   * @returns the canonical symbol, its bars, and the indicator block.
   */
  symbolBars(symbol: string, limit: number): { symbol: string, bars: SymbolBar[], stats: SymbolStats } {
    const parsed = normalizeSymbol(symbol)
    const bars = this.db.readBars(parsed.symbol, limit)
    return { symbol: parsed.symbol, bars, stats: computeSymbolStats(bars) }
  }

  /**
   * Reconstruct the portfolio's value at each past trading day.
   * @param days - how many calendar days of history to return.
   * @returns ascending equity points; empty until at least one symbol prices.
   */
  async equityCurve(days = 180): Promise<EquityPoint[]> {
    const settings = this.db.readSettings()
    const held = [...new Set(this.db.listTrades().map(trade => trade.symbol))]
    if (held.length === 0) return []
    const closes = await this.ensureCloses(held)
    const cutoff = new Date(this.now().getTime() - days * 86_400_000).toISOString().slice(0, 10)
    return buildEquityCurve({
      trades: this.db.listTrades(),
      closes,
      baseCurrency: settings.baseCurrency,
      rates: this.rates(settings),
    }).filter(point => point.date >= cutoff)
  }

  /**
   * Ensure the stored daily history is deep enough to draw a curve.
   * @param symbols - canonical symbols.
   * @returns ascending closes keyed by symbol.
   */
  private async ensureCloses(symbols: readonly string[]): Promise<Map<string, { date: string, close: number }[]>> {
    const cached = this.db.readCloses(symbols)
    const missing = symbols.filter(symbol => (cached.get(symbol) ?? []).length < MIN_HISTORY_BARS)
    if (missing.length > 0) {
      try {
        const bars = await this.client().dailyBars(missing, HISTORY_BARS)
        if (this.closed) return this.db.readCloses([])
        for (const series of bars.values()) this.db.upsertPrices(series)
      } catch {
        // A missing history series only shortens the curve; it must never fail
        // the whole request.
      }
    }
    return this.db.readCloses(symbols)
  }

  /**
   * Search for instruments by symbol or name.
   *
   * Local first: the whole index is in SQLite, so the common case costs one query
   * and no API quota. Only a query the index cannot answer falls through to the
   * service, and a successful probe is written back into the index.
   * @param query - the raw search text.
   * @returns matching instruments, best first.
   */
  async lookup(query: string): Promise<SymbolMatch[]> {
    const trimmed = query.trim()
    if (trimmed === '') return []

    const local = this.db.searchInstruments(trimmed)
    if (local.length > 0) return local.map(toMatch)

    // A parseable symbol is the most direct answer, so try it before spending a
    // request on the index.
    const direct = this.parseOrNull(trimmed)
    if (direct !== null) {
      try {
        const found = await this.client().instruments([direct])
        if (this.closed) return []
        if (found.length > 0) {
          this.db.upsertInstruments(found)
          return found.map(toMatch)
        }
      } catch {
        // A lookup must never surface a provider error; the form just shows no
        // suggestions and the user can type the symbol in full.
      }
    }

    // An empty index means the first-run sync has not happened yet; the caller
    // gets its results on the next keystroke.
    if (this.db.instrumentCount() === 0) void this.syncInstruments(false)
    return []
  }

  /**
   * Resolve a query to a canonical symbol, or `null` when it is not one.
   * @param query - the raw text.
   * @returns the canonical symbol, or `null`.
   */
  private parseOrNull(query: string): string | null {
    try {
      return normalizeSymbol(query).symbol
    } catch {
      return null
    }
  }

  // ─── writes ────────────────────────────────────────────────────────────────

  /**
   * Add a trade, resolving its display name in the background.
   *
   * A symbol the log has never priced also gets its recent daily window loaded
   * before this returns, so the panel has something to value on the very next
   * read rather than after the next scheduled refresh. Both writers — the form
   * and the chat tool — go through here, so both get it.
   * @param input - the user's trade fields.
   * @returns the inserted trade.
   * @throws {PortfolioError} when the trade would make the log inconsistent.
   */
  async addTrade(input: TradeInput): Promise<Trade> {
    const trade = this.validate(input)
    const existing = this.db.listTrades()
    // Validated BEFORE the insert: the check needs the whole chronological log,
    // and running it afterwards would leave the rejected row committed.
    this.assertConsistent([...existing, { ...trade, name: null, id: Number.MAX_SAFE_INTEGER, createdAt: '' }])
    const named = { ...trade, name: this.nameFor(trade.symbol) }
    const saved = this.db.insertTrade(named)
    // A symbol the index has never seen: go and ask, without blocking the write.
    if (named.name === null) void this.resolveNames([trade.symbol])
    await this.loadRecentPrices([trade.symbol])
    return saved
  }

  /**
   * Replace a trade's fields.
   * @param id - the trade id.
   * @param input - the new fields.
   * @returns the updated trade.
   * @throws {PortfolioError} when the change would make the log inconsistent.
   */
  updateTrade(id: number, input: TradeInput): Trade {
    const trade = this.validate(input)
    const existing = this.db.listTrades()
    if (!existing.some(row => row.id === id)) {
      throw new PortfolioError(`交易记录 #${String(id)} 不存在`, 404)
    }
    this.assertConsistent(existing.map(row => (row.id === id ? { ...row, ...trade } : row)))
    const saved = this.db.updateTrade(id, { ...trade, name: this.nameFor(trade.symbol) })
    // An edit can point a trade at a symbol the portfolio has never held; the
    // gap is the same one `addTrade` closes. Nothing waits on it here, because
    // this method is synchronous and the row is already committed.
    void this.loadRecentPrices([trade.symbol])
    return saved
  }

  /**
   * Delete a trade.
   *
   * Removing a buy can strand a later sell, so the candidate log is checked
   * before the row disappears.
   * @param id - the trade id.
   * @throws {PortfolioError} when deleting would make the log inconsistent.
   */
  deleteTrade(id: number): void {
    const existing = this.db.listTrades()
    if (!existing.some(row => row.id === id)) {
      throw new PortfolioError(`交易记录 #${String(id)} 不存在`, 404)
    }
    this.assertConsistent(existing.filter(row => row.id !== id))
    this.db.deleteTrade(id)
  }

  /**
   * The display name for a symbol, when the local index already knows it.
   * @param symbol - the canonical symbol.
   * @returns the name, or `null`.
   */
  private nameFor(symbol: string): string | null {
    return this.db.namesOf([symbol]).get(symbol) ?? null
  }

  /**
   * Update user settings.
   * @param patch - the fields to change; omitted fields keep their value.
   * @returns the new wire-safe settings.
   */
  updateSettings(patch: {
    apiKey?: string | null | undefined
    baseCurrency?: Currency | undefined
    usdHkd?: number | undefined
    usdCny?: number | undefined
    refreshIntervalMinutes?: number | undefined
    autoRefresh?: boolean | undefined
    mentionPopup?: boolean | undefined
  }): PortfolioSettings {
    let typedRate = false
    if (patch.apiKey !== undefined) {
      this.db.writeSetting('apiKey', patch.apiKey === null ? '' : patch.apiKey.trim())
      // A new key may reach a different endpoint; the next refresh re-reads. The
      // stored watermark stays: it still describes the last successful fetch.
      this.refreshedAt = null
      this.lastError = null
    }
    for (const [key, value] of [['usdHkd', patch.usdHkd], ['usdCny', patch.usdCny]] as const) {
      if (value === undefined) continue
      if (!Number.isFinite(value) || value <= 0) throw new PortfolioError('汇率必须是大于 0 的数字')
      this.db.writeSetting(key, value)
      typedRate = true
    }
    // A hand-typed pair is labelled as such, so the settings page can say where
    // the number on screen came from — and that the next automatic refresh will
    // replace it.
    if (typedRate) {
      this.db.writeMeta(FX_META.source, 'manual')
      this.db.writeMeta(FX_META.provider, '')
      this.db.writeMeta(FX_META.updatedAt, this.now().toISOString())
      this.db.writeMeta(FX_META.asOf, '')
      this.db.writeMeta(FX_META.error, '')
    }
    if (patch.refreshIntervalMinutes !== undefined) {
      if (!Number.isInteger(patch.refreshIntervalMinutes) || patch.refreshIntervalMinutes < 15) {
        throw new PortfolioError('行情刷新间隔至少为 15 分钟')
      }
      this.db.writeSetting('refreshIntervalMinutes', patch.refreshIntervalMinutes)
    }
    if (patch.baseCurrency !== undefined) {
      if (patch.baseCurrency !== 'CNY' && patch.baseCurrency !== 'HKD' && patch.baseCurrency !== 'USD') {
        throw new PortfolioError('基准货币只能是 CNY、HKD 或 USD')
      }
      this.db.writeSetting('baseCurrency', patch.baseCurrency)
    }
    if (patch.autoRefresh !== undefined) this.db.writeSetting('autoRefresh', patch.autoRefresh)
    if (patch.mentionPopup !== undefined) this.db.writeSetting('mentionPopup', patch.mentionPopup)
    return this.publicSettings(this.db.readSettings())
  }

  // ─── conversation mentions ─────────────────────────────────────────────────

  /**
   * Every symbol the portfolio knows, as the mention matcher wants them.
   *
   * The whole trade log, not just the open positions: a message about a stock
   * that was sold last month is still a message about this portfolio, and the
   * pane can show its chart and its realized result even without a position.
   * @returns the targets, symbol-sorted.
   */
  mentionTargets(): MentionTarget[] {
    const trades = this.db.listTrades()
    const symbols = [...new Set(trades.map(trade => trade.symbol))].sort()
    const names = this.db.namesOf(symbols)
    const fromTrades = new Map<string, string | null>()
    for (const trade of trades) if (!fromTrades.has(trade.symbol)) fromTrades.set(trade.symbol, trade.name)
    return symbols.map((symbol) => {
      const code = codeOfSymbol(symbol)
      return {
        symbol,
        code,
        // The instrument index is the better source; the trade's own copy is the
        // fallback for a symbol the index has never listed.
        name: names.get(symbol) ?? fromTrades.get(symbol) ?? null,
      }
    })
  }

  /**
   * The matcher for the portfolio as it stands.
   *
   * Rebuilt only when the target set changes, because the session projection
   * calls this once per committed event: building three regexes per symbol for
   * every message of every session would be work nobody asked for, and the
   * portfolio changes on a human timescale.
   * @returns a function that scans one message for portfolio symbols.
   */
  mentionMatcher(): (text: string) => MentionMatch[] {
    const targets = this.mentionTargets()
    const signature = targets.map(target => `${target.symbol}\u0000${target.name ?? ''}`).join('\u0001')
    if (this.matcherCache?.signature !== signature) {
      this.matcherCache = { signature, match: createMentionMatcher(targets) }
    }
    return this.matcherCache.match
  }

  /**
   * Install the reader the `/mentions` route answers from.
   *
   * The feed belongs to the session projection, which only the host plugin can
   * register (it needs the harness's projection registry); the service keeps the
   * routing so the browser has one endpoint to poll and one place to be wrong.
   * @param source - the per-session reader, or `null` to answer with an empty feed.
   */
  useMentionSource(source: ((sessionId: string) => MentionFeed) | null): void {
    this.mentionSource = source
  }

  /**
   * One session's mention feed.
   * @param sessionId - the session the browser is showing.
   * @returns the feed; empty when nothing has been registered or folded yet.
   */
  sessionMentions(sessionId: string): MentionFeed {
    return this.mentionSource?.(sessionId) ?? { rev: 0, batches: [] }
  }

  // ─── exchange rates ────────────────────────────────────────────────────────

  /**
   * Refresh the USD→CNY / USD→HKD pair through the harness web capability.
   *
   * The panel calls this every time it opens, so the entry points are cheap: an
   * in-flight call is shared, and a pair already fetched TODAY is not fetched
   * again unless `force` says so. The stored pair is only replaced by rates that
   * passed validation — an outage leaves the previous numbers and records why,
   * which is what the settings page shows.
   * @param options - `force` bypasses the freshness guard.
   * @returns what happened, in terms the UI can display.
   */
  async refreshRates(options: { readonly force?: boolean } = {}): Promise<FxRefreshResult> {
    const web = this.options.web?.()
    if (web === undefined) {
      return {
        ok: false,
        refreshed: false,
        error: '当前 DSH 没有挂载 web 服务（ctx.web），无法自动获取汇率，可手动填写。',
        failures: [],
      }
    }

    // The guard covers rates this plugin fetched, and it is a calendar-day rule
    // rather than a rolling window: "already updated today" is what the user
    // asked for, and it still holds across a restart, a reload, or a laptop
    // waking up at 23:59. A hand-typed pair is exactly what the next open is
    // supposed to replace, so it never blocks the refresh.
    const now = this.now()
    const last = this.metaOrNull(FX_META.updatedAt)
    const source = this.metaOrNull(FX_META.source)
    const fetched = source === 'web-fetch' || source === 'web-search'
    if (options.force !== true && fetched && last !== null && this.fxInFlight === null
      && localDay(last) === localDay(now.toISOString())) {
      return { ok: true, refreshed: false, error: null, failures: [] }
    }
    // Two panels (or a panel and the settings button) can ask at the same moment;
    // one network round trip answers both.
    const pending = this.fxInFlight ?? acquireRates(web)
    this.fxInFlight = pending
    let acquisition: FxAcquisition
    try {
      acquisition = await pending
    } finally {
      this.fxInFlight = null
    }
    // The plugin can be unloaded while a route is in flight; its database handle
    // is closed by then, so nothing may be written.
    if (this.closed) {
      return { ok: false, refreshed: false, error: '插件已卸载，汇率未写入。', failures: [] }
    }

    if (!acquisition.ok) {
      const error = `汇率刷新失败：${acquisition.failures.map(failure => `${failure.route}（${failure.reason}）`).join('；')}`
      this.db.writeMeta(FX_META.error, error)
      return { ok: false, refreshed: true, error, failures: acquisition.failures }
    }

    const { quote } = acquisition
    this.db.writeSetting('usdCny', quote.usdCny)
    this.db.writeSetting('usdHkd', quote.usdHkd)
    this.db.writeMeta(FX_META.source, quote.source)
    this.db.writeMeta(FX_META.provider, quote.provider)
    this.db.writeMeta(FX_META.updatedAt, now.toISOString())
    this.db.writeMeta(FX_META.asOf, quote.asOf ?? '')
    this.db.writeMeta(FX_META.error, '')
    return { ok: true, refreshed: true, error: null, failures: acquisition.failures }
  }

  // ─── price refresh ─────────────────────────────────────────────────────────

  /**
   * Bring the stored daily bars up to date, asking the provider only for what is
   * actually missing.
   *
   * ## Why this is not a timer
   *
   * Daily bars are end-of-day: day D's bar appears on D+1. A series whose newest
   * bar is already the last trading day the provider can have published therefore
   * has nothing to collect, and asking for it again is a request spent on an
   * answer we already have. So this decides from the stored data, not from a
   * clock: a symbol is refreshed when its newest bar is behind what could exist,
   * and it is asked about at most once a day — the watermark that makes a market
   * holiday cost one request instead of one per open.
   *
   * When something IS behind, only the gap is requested (`start_time` = the day
   * after its newest stored bar), not the whole history, and one batch covers
   * several symbols at the price of one request.
   * @param force - re-read the full history for every open position, ignoring the
   *   freshness rule. This is the panel's 刷新行情 button.
   * @returns whether a network request actually ran.
   */
  async refresh(force = false): Promise<boolean> {
    const now = this.now()
    // The panel opening and the scheduler ticking can land together, and both
    // would ask for the same bars; the second caller rides the first one's work.
    if (!force && this.refreshInFlight !== null) return false
    if (!force && this.lastFailureAt !== 0 && now.getTime() - this.lastFailureAt < FAILURE_BACKOFF_MS) {
      return false
    }

    const held = [...new Set(foldLedgers(this.db.listTrades())
      .filter(ledger => ledger.quantity > 0)
      .map(ledger => ledger.symbol))]
    if (held.length === 0) return false

    // One read, used both to decide and to measure the gaps: it has to describe
    // the state BEFORE the fetch.
    const newest = this.db.latestPriceDates()
    const targets = force ? held : this.behind(held, newest, now)
    if (targets.length === 0) return false

    const run = this.fetchBars(targets, newest, force, now)
    this.refreshInFlight = run
    try {
      return await run
    } finally {
      this.refreshInFlight = null
    }
  }

  /**
   * Which held symbols have bars older than the provider can possibly serve.
   * @param held - symbols with an open position.
   * @param newest - the newest stored bar date per symbol.
   * @param now - the current instant.
   * @returns the symbols worth a request.
   */
  private behind(held: readonly string[], newest: ReadonlyMap<string, string>, now: Date): string[] {
    const expected = latestExpectedDate(now)
    const today = localDay(now.toISOString())
    const attempted = this.readAttempts()
    return held.filter((symbol) => {
      const have = newest.get(symbol)
      // Never priced, or older than the newest bar that can exist.
      if (have !== undefined && have >= expected) return false
      // Already asked today and the provider had nothing newer: this is what a
      // market holiday looks like, and it must not be re-asked on every open.
      return attempted[symbol] !== today
    })
  }

  /**
   * Request and store bars for the given symbols.
   *
   * `since` is the earliest gap among them — one batch carries one bound, and a
   * symbol with fresher data simply comes back with a little overlap, which the
   * upsert absorbs. A symbol with no bars at all asks for the recent window
   * instead, since it has no gap to speak of.
   * @param targets - symbols to fetch.
   * @param newest - the newest stored bar date per symbol, from before the fetch.
   * @param force - read the full history rather than the gap.
   * @param now - the current instant.
   * @returns whether the request succeeded.
   * @throws {TickFlowError} when the provider refuses; the caller records it.
   */
  private async fetchBars(
    targets: readonly string[],
    newest: ReadonlyMap<string, string>,
    force: boolean,
    now: Date,
  ): Promise<boolean> {
    const starts = targets.map((symbol) => {
      const last = newest.get(symbol)
      return last === undefined
        ? now.getTime() - RECENT_BARS * 86_400_000
        : Date.parse(`${last}T00:00:00Z`) + 86_400_000
    })
    const client = this.client()
    try {
      const bars = await client.dailyBars(
        targets,
        HISTORY_BARS,
        force ? {} : { since: Math.min(...starts) },
      )
      if (this.closed) return false
      for (const series of bars.values()) this.db.upsertPrices(series)
      // Only a symbol the provider has never answered for is "unresolved": a
      // series that came back empty because its gap is a holiday is up to date,
      // and calling it missing would put a false banner in the panel.
      this.unresolved = targets.filter(symbol => !bars.has(symbol) && !newest.has(symbol))
      this.batchSupported = client.batchSupported
      this.refreshedAt = now.toISOString()
      this.db.writeMeta(PRICES_REFRESHED_KEY, this.refreshedAt)
      this.rememberAttempt(targets, now)
      this.lastError = null
      this.lastFailureAt = 0
      await this.resolveNames(targets)
      // First successful refresh is also the natural moment to build the name
      // index, so search works without a separate trigger.
      void this.syncInstruments(false)
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.lastFailureAt = now.getTime()
      throw error
    }
  }

  /**
   * The day each symbol was last asked about, so a holiday is asked about once.
   * @returns the watermark map, symbol to `YYYY-MM-DD`.
   */
  private readAttempts(): Record<string, string> {
    const raw = this.db.readMeta(PRICES_ATTEMPTED_KEY)
    if (raw === null || raw === '') return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const attempts: Record<string, string> = {}
      for (const [symbol, day] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof day === 'string') attempts[symbol] = day
      }
      return attempts
    } catch {
      // A corrupt watermark is the same as an absent one: ask again.
      return {}
    }
  }

  /**
   * Record the attempt watermark for the symbols just fetched.
   *
   * Rewritten from the current holdings each time, so a symbol that left the
   * portfolio does not leave an entry behind for ever.
   * @param symbols - the symbols that were asked about.
   * @param now - the current instant.
   */
  private rememberAttempt(symbols: readonly string[], now: Date): void {
    const today = localDay(now.toISOString())
    const attempts = this.readAttempts()
    for (const symbol of symbols) attempts[symbol] = today
    const held = new Set(foldLedgers(this.db.listTrades())
      .filter(ledger => ledger.quantity > 0)
      .map(ledger => ledger.symbol))
    const kept: Record<string, string> = {}
    for (const [symbol, day] of Object.entries(attempts)) {
      if (held.has(symbol)) kept[symbol] = day
    }
    this.db.writeMeta(PRICES_ATTEMPTED_KEY, JSON.stringify(kept))
  }

  /**
   * How long until the next automatic check is due.
   *
   * Read fresh on every tick so changing the interval takes effect without
   * re-registering the timer. This is how often the background job LOOKS at the
   * stored series; whether that look turns into a request is
   * {@link refresh}'s decision, not this one's.
   * @returns the configured interval in milliseconds.
   */
  refreshIntervalMs(): number {
    return this.db.readSettings().refreshIntervalMinutes * 60_000
  }

  /**
   * Load the recent daily window for symbols that have never been priced.
   *
   * The scheduled refresh only widens series it already knows how to value, and
   * it runs on its own interval; a symbol that enters the log in between would
   * show as unpriceable — no market value, no day move, no curve — until it came
   * round again. This closes that gap at the moment the symbol arrives.
   *
   * A symbol that already has bars is skipped, so a second buy of a held stock
   * costs no request.
   * @param symbols - canonical symbols that should end up priced.
   */
  private async loadRecentPrices(symbols: readonly string[]): Promise<void> {
    try {
      if (this.closed) return
      const unpriced = symbols.filter(symbol => (this.db.readCloses([symbol]).get(symbol) ?? []).length === 0)
      if (unpriced.length === 0) return

      const loading = (async () => {
        const bars = await this.client().dailyBars(unpriced, RECENT_BARS)
        if (this.closed) return
        for (const series of bars.values()) this.db.upsertPrices(series)
      })().catch((error: unknown) => {
        // Reported where a failed refresh is reported: staying silent would leave
        // the panel looking like the symbol simply has no price.
        this.lastError = `加载 ${unpriced.join('、')} 最近 ${String(RECENT_BARS)} 天日线失败：`
          + (error instanceof Error ? error.message : String(error))
      })

      await this.settleWithin(loading, RECENT_BARS_WAIT_MS)
    } catch {
      // The caller has already committed its trade by the time this runs, and a
      // history fetch is an extra: it must never turn a successful write into a
      // failed one.
    }
  }

  /**
   * Wait for one piece of work, but no longer than a budget.
   *
   * The work keeps running after the budget: this only decides how long the
   * caller is held up, never whether the result is eventually stored.
   * @param work - the work to wait for; it must already handle its own failure.
   * @param ms - the budget in milliseconds.
   */
  private async settleWithin(work: Promise<void>, ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      // Node must not be held open by a budget nobody is waiting on any more.
      timer.unref?.()
      void work.finally(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Resolve display names for symbols the local index does not carry yet.
   * @param symbols - canonical symbols.
   */
  private async resolveNames(symbols: readonly string[]): Promise<void> {
    if (this.closed) return
    const known = this.db.namesOf(symbols)
    const wanted = symbols.filter(symbol => !known.has(symbol))
    if (wanted.length === 0) return
    try {
      const instruments = await this.client().instruments(wanted)
      if (this.closed) return
      if (instruments.length > 0) this.db.upsertInstruments(instruments)
      for (const instrument of instruments) {
        if (instrument.name !== null) this.backfillTradeName(instrument.symbol, instrument.name)
      }
    } catch {
      // Names are cosmetic; a failure here must not surface as a refresh error.
    }
  }

  /**
   * Attach a resolved name to any trade of that symbol that has none.
   * @param symbol - the canonical symbol.
   * @param name - the resolved name.
   */
  private backfillTradeName(symbol: string, name: string): void {
    for (const trade of this.db.listTrades()) {
      if (trade.symbol === symbol && (trade.name === null || trade.name === '')) {
        this.db.updateTrade(trade.id, { ...trade, name })
      }
    }
  }

  /**
   * Rebuild the local instrument index from the service's exchange listings.
   *
   * Five requests cover every market the provider carries (~23,000 instruments) and
   * the whole set is cached in SQLite, which is what makes name search instant
   * and offline. Runs at most weekly, and never twice at once.
   * @param force - rebuild even when the index is still fresh.
   * @returns whether a rebuild ran.
   */
  async syncInstruments(force = false): Promise<boolean> {
    if (this.closed || this.indexSyncing) return false
    const syncedAt = this.db.readMeta(INSTRUMENTS_SYNCED_KEY)
    if (!force && syncedAt !== null && this.db.instrumentCount() > 0) {
      const age = this.now().getTime() - Date.parse(syncedAt)
      if (Number.isFinite(age) && age < INSTRUMENT_INDEX_DAYS * 86_400_000) return false
    }

    this.indexSyncing = true
    const client = this.client()
    try {
      const exchanges = await client.exchanges()
      for (const { exchange } of exchanges) {
        const instruments = await client.exchangeInstruments(exchange)
        if (this.closed) return false
        if (instruments.length > 0) this.db.upsertInstruments(instruments)
      }
      this.db.writeMeta(INSTRUMENTS_SYNCED_KEY, this.now().toISOString())
      return true
    } catch (error) {
      // Search degrades to direct-symbol probing; it must not break the panel.
      console.warn('[stock-portfolio] instrument index sync failed:', error)
      return false
    } finally {
      this.indexSyncing = false
    }
  }

  // ─── validation ────────────────────────────────────────────────────────────

  /**
   * Validate and normalize one trade input.
   * @param input - the user's fields.
   * @returns the storage-shaped trade, without its id.
   * @throws {PortfolioError} with a user-facing message on any invalid field.
   */
  private validate(input: TradeInput): Omit<Trade, 'id' | 'createdAt' | 'name'> {
    const { symbol, exchange, currency } = normalizeSymbol(input.symbol)
    if (input.side !== 'buy' && input.side !== 'sell') {
      throw new PortfolioError('交易方向只能是买入或卖出')
    }
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new PortfolioError('数量必须是大于 0 的数字')
    }
    if (!Number.isFinite(input.price) || input.price < 0) {
      throw new PortfolioError('价格必须是非负数字')
    }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.tradedAt) || Number.isNaN(Date.parse(input.tradedAt))) {
      throw new PortfolioError('交易日期格式必须是 YYYY-MM-DD')
    }
    const motive = input.motive?.trim() ?? ''
    const note = input.note?.trim() ?? ''
    return {
      symbol,
      exchange,
      currency,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      tradedAt: input.tradedAt,
      motive: motive === '' ? null : motive,
      note: note === '' ? null : note,
    }
  }

  /**
   * Reject a trade log that sells more than it holds.
   *
   * Checked against the whole log rather than the single row, because an
   * out-of-order back-dated sale is the realistic way to create a negative
   * position, and only the chronological fold can see it.
   * @param trades - the complete log after the mutation.
   * @throws {PortfolioError} naming the symbol and date that go negative.
   */
  private assertConsistent(trades: readonly Trade[]): void {
    const held = new Map<string, number>()
    for (const trade of sortTrades(trades)) {
      const quantity = held.get(trade.symbol) ?? 0
      const next = trade.side === 'buy' ? quantity + trade.quantity : quantity - trade.quantity
      if (next < -1e-9) {
        throw new PortfolioError(
          `${trade.tradedAt} 卖出 ${trade.symbol} 的数量超过了当时持有的 ${String(quantity)} 股`,
        )
      }
      held.set(trade.symbol, Math.max(0, next))
    }
  }

  /** The currency a symbol trades in; exposed for other plugins reading the service. */
  currencyOf(symbol: string): Currency {
    return currencyOfSymbol(symbol)
  }

  /** The exchange a symbol belongs to. */
  exchangeOf(symbol: string): string {
    return exchangeOfSymbol(symbol)
  }
}

/**
 * Project an instrument onto the search-result shape.
 * @param instrument - the stored instrument.
 * @returns the wire-safe match.
 */
function toMatch(instrument: Instrument): SymbolMatch {
  return {
    symbol: instrument.symbol,
    name: instrument.name,
    exchange: instrument.exchange,
    currency: instrument.currency,
    type: instrument.type,
  }
}

export type { TickFlowError }
