/**
 * The TickFlow market-data client.
 *
 * Contract facts this file depends on, all verified against the live service and
 * its published OpenAPI document (`https://api.tickflow.org/openapi.json`):
 *
 *   * Two endpoints serve the same API. `https://api.tickflow.org` takes a key in
 *     the `x-api-key` header; `https://free-api.tickflow.org` needs none. The
 *     keyless tier serves **daily bars, the exchange list, and full per-exchange
 *     instrument lists** — everything this plugin reads. It refuses `/v1/quotes`,
 *     minute periods, and universe queries.
 *   * `/v1/klines/batch` returns `{data: {SYMBOL: bars}}`, one entry per symbol
 *     the service knows; an unknown symbol is simply absent. **Batch is a
 *     separate entitlement from single-symbol klines**: the keyless host serves
 *     it, while a key whose plan lacks it answers `403 NO_KLINE_BATCH_PERMISSION`.
 *     Measured, so {@link TickFlowClient.dailyBars} falls back to one request per
 *     symbol rather than failing the refresh.
 *   * Kline payloads are **columnar** (`{timestamp: [], close: []}`), not a list
 *     of candle objects.
 *   * `adjust` defaults to `forward`. Adjusted prices would distort every
 *     cost-basis comparison, so each request pins `adjust=none`.
 *   * There is no currency field anywhere; currency follows the exchange.
 *   * The shared free tier allows 10 requests/minute, so symbol batches are
 *     chunked and paced rather than fired off together.
 *
 * Every failure becomes a {@link TickFlowError} whose message is safe to show in
 * the dashboard.
 */
import { currencyOfSymbol, instrumentType } from './symbols.ts'
import type { Instrument, PriceBar } from './types.ts'

/** The keyed endpoint. */
export const KEYED_BASE_URL = 'https://api.tickflow.org'

/** The keyless endpoint: daily bars and instrument metadata, no realtime. */
export const FREE_BASE_URL = 'https://free-api.tickflow.org'

/** Symbols per batch on the keyless tier. The keyed tier has no stated cap. */
const FREE_TIER_BATCH = 5

/** Symbols per batch on a keyed tier; large enough to cover any real portfolio. */
const KEYED_TIER_BATCH = 50

/**
 * Pacing between keyless batches. 10 requests/minute is the documented ceiling;
 * 350 ms keeps a batch of five comfortably inside it.
 */
const FREE_TIER_PACING_MS = 350

/** Default per-request deadline. */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * The query every kline request shares.
 *
 * `adjust` is pinned to `none`: the service defaults to `forward`, and adjusted
 * prices would distort every cost-basis comparison.
 */
const KLINE_QUERY = { adjust: 'none' } as const

/** One exchange as `/v1/exchanges` describes it. */
export interface ExchangeInfo {
  readonly exchange: string
  readonly region: string
  readonly count: number
}

/** A market-data failure whose message is safe to surface to the user. */
export class TickFlowError extends Error {
  /** HTTP status when the failure came from a response; `undefined` otherwise. */
  readonly status: number | undefined
  /** The provider's own error code, when it sent one. */
  readonly code: string | undefined

  constructor(message: string, options: { status?: number, code?: string } = {}) {
    super(message)
    this.name = 'TickFlowError'
    this.status = options.status
    this.code = options.code
  }

  /** Whether the key is missing, wrong, or not entitled to this endpoint. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403
  }
}

/** Constructor inputs for {@link TickFlowClient}. */
export interface TickFlowClientOptions {
  /** The API key, or `undefined` to use the keyless tier. */
  readonly apiKey?: string | undefined
  /** Endpoint override; defaults to the tier's own base URL. */
  readonly baseUrl?: string | undefined
  /** Injectable fetch, for tests. */
  readonly fetchImpl?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

/** `/v1/instruments` row. */
interface WireInstrument {
  symbol?: unknown
  exchange?: unknown
  code?: unknown
  name?: unknown
  type?: unknown
}

/** The columnar `/v1/klines` payload. */
interface WireKlines {
  timestamp?: unknown
  open?: unknown
  high?: unknown
  low?: unknown
  close?: unknown
  volume?: unknown
  amount?: unknown
}

/**
 * Read a finite number from an unknown wire value.
 * @param value - the raw value.
 * @returns the number, or `null` when the value is absent or not finite.
 */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Read a non-empty string from an unknown wire value.
 * @param value - the raw value.
 * @returns the string, or `null`.
 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Read a numeric array from an unknown wire value.
 * @param value - the raw value.
 * @returns a number array, empty when the value is not an array of numbers.
 */
function numArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []
}

/**
 * Format an epoch-millisecond instant as `YYYY-MM-DD` in UTC.
 * @param millis - epoch milliseconds.
 * @returns the date string.
 */
export function isoDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10)
}

/**
 * Split a list into fixed-size chunks.
 * @param items - the list to split.
 * @param size - the maximum chunk length.
 * @returns consecutive chunks.
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/**
 * Pause for a fixed interval.
 * @param ms - milliseconds to wait.
 * @returns a promise resolving after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Turn one columnar kline payload into bars.
 * @param symbol - the symbol the payload belongs to.
 * @param payload - the raw `CompactKlineData` object.
 * @returns ascending daily bars.
 */
function barsOf(symbol: string, payload: WireKlines): PriceBar[] {
  const timestamps = numArray(payload.timestamp)
  const opens = numArray(payload.open)
  const highs = numArray(payload.high)
  const lows = numArray(payload.low)
  const closes = numArray(payload.close)
  const volumes = numArray(payload.volume)
  const amounts = numArray(payload.amount)
  const bars: PriceBar[] = []
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index]
    const open = opens[index]
    const high = highs[index]
    const low = lows[index]
    const close = closes[index]
    if (timestamp === undefined || open === undefined || high === undefined
      || low === undefined || close === undefined) continue
    bars.push({
      symbol,
      date: isoDate(timestamp),
      open,
      high,
      low,
      close,
      volume: volumes[index] ?? 0,
      amount: amounts[index] ?? 0,
    })
  }
  return bars
}

/**
 * Project one wire instrument onto the domain type.
 * @param row - the raw row.
 * @returns a single-element array, or empty when the row is unusable.
 */
function instrumentOf(row: WireInstrument): Instrument[] {
  const symbol = str(row.symbol)
  if (symbol === null) return []
  const dot = symbol.lastIndexOf('.')
  return [{
    symbol,
    exchange: str(row.exchange) ?? (dot > 0 ? symbol.slice(dot + 1) : ''),
    code: str(row.code) ?? (dot > 0 ? symbol.slice(0, dot) : symbol),
    name: str(row.name),
    type: instrumentType(row.type),
    currency: currencyOfSymbol(symbol),
  }]
}

/** The TickFlow HTTP client. Built per operation and reused across a refresh. */
export class TickFlowClient {
  private readonly apiKey: string | undefined
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: TickFlowClientOptions = {}) {
    this.apiKey = options.apiKey !== undefined && options.apiKey.trim() !== '' ? options.apiKey.trim() : undefined
    this.baseUrl = (options.baseUrl ?? (this.apiKey === undefined ? FREE_BASE_URL : KEYED_BASE_URL))
      .replace(/\/+$/u, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Whether this client sends a key. */
  get keyed(): boolean {
    return this.apiKey !== undefined
  }

  /** The endpoint in use, for the dashboard's feed status. */
  get endpoint(): string {
    return this.baseUrl
  }

  /** The largest symbol batch this tier accepts. */
  get batchSize(): number {
    return this.keyed ? KEYED_TIER_BATCH : FREE_TIER_BATCH
  }

  /**
   * Whether batched kline requests are usable.
   *
   * Starts optimistic and latches false the first time the service refuses the
   * batch endpoint, so the rest of the process stops paying for a request that
   * cannot succeed. The keyless host serves batch; a keyed plan may not.
   */
  get batchSupported(): boolean {
    return this.batchUsable
  }

  private batchUsable = true

  /**
   * Fetch daily bars for many symbols at once.
   *
   * A symbol with no history — a typo, or one TickFlow does not carry — is simply
   * absent from the result rather than an error, which is what lets a portfolio
   * with one bad code still refresh the rest.
   * @param symbols - canonical symbols.
   * @param count - how many bars to request per symbol, newest last.
   * @param options - `since` (ms epoch) drops every bar before that instant, which
   *   is how an up-to-date series is topped up instead of re-read: the endpoint
   *   treats it as a lower bound and `count` still selects the NEWEST bars of the
   *   range, so a stale window shorter than `count` comes back whole.
   * @returns ascending bars keyed by symbol; symbols with no data are omitted.
   */
  async dailyBars(
    symbols: readonly string[],
    count: number,
    options: { readonly since?: number | undefined } = {},
  ): Promise<Map<string, PriceBar[]>> {
    const since = options.since === undefined ? {} : { start_time: String(Math.floor(options.since)) }
    const result = new Map<string, PriceBar[]>()
    let first = true
    for (const batch of chunk(symbols, this.batchSize)) {
      if (!first && !this.keyed) await sleep(FREE_TIER_PACING_MS)
      first = false
      if (this.batchUsable) {
        try {
          const payload = await this.json('/v1/klines/batch', {
            symbols: batch.join(','),
            period: '1d',
            count: String(count),
            ...KLINE_QUERY,
            ...since,
          })
          const data = (payload as { data?: unknown }).data
          if (data === null || typeof data !== 'object') continue
          for (const [symbol, value] of Object.entries(data as Record<string, unknown>)) {
            if (value === null || typeof value !== 'object') continue
            const bars = barsOf(symbol, value as WireKlines)
            if (bars.length > 0) result.set(symbol, bars)
          }
          continue
        } catch (error) {
          // A plan without the batch entitlement is a configuration fact, not a
          // transient fault: latch the fallback and serve this batch singly.
          if (!(error instanceof TickFlowError) || !error.isAuthFailure) throw error
          this.batchUsable = false
        }
      }
      for (const symbol of batch) {
        if (!this.keyed) await sleep(FREE_TIER_PACING_MS)
        const payload = await this.json('/v1/klines', {
          symbol, period: '1d', count: String(count), ...KLINE_QUERY, ...since,
        })
        const data = (payload as { data?: unknown }).data
        if (data === null || typeof data !== 'object') continue
        const bars = barsOf(symbol, data as WireKlines)
        if (bars.length > 0) result.set(symbol, bars)
      }
    }
    return result
  }

  /**
   * List the exchanges the service carries.
   * @returns one entry per exchange.
   */
  async exchanges(): Promise<ExchangeInfo[]> {
    const payload = await this.json('/v1/exchanges', {})
    const data = (payload as { data?: unknown }).data
    if (!Array.isArray(data)) return []
    return data.flatMap((row) => {
      const record = row as { exchange?: unknown, region?: unknown, count?: unknown }
      const exchange = str(record.exchange)
      if (exchange === null) return []
      return [{ exchange, region: str(record.region) ?? '', count: num(record.count) ?? 0 }]
    })
  }

  /**
   * List every instrument on one exchange.
   *
   * This whole-inventory endpoint is what makes local name search possible
   * without a key: an exchange's list is a few thousand rows, small enough to
   * cache in SQLite and query offline forever after.
   * @param exchange - the exchange code.
   * @returns every instrument the exchange lists.
   */
  async exchangeInstruments(exchange: string): Promise<Instrument[]> {
    const payload = await this.json(`/v1/exchanges/${encodeURIComponent(exchange)}/instruments`, {})
    const data = (payload as { data?: unknown }).data
    if (!Array.isArray(data)) return []
    return data.flatMap(row => instrumentOf(row as WireInstrument))
  }

  /**
   * Resolve metadata for specific symbols.
   * @param symbols - canonical symbols.
   * @returns one entry per symbol the service knows.
   */
  async instruments(symbols: readonly string[]): Promise<Instrument[]> {
    if (symbols.length === 0) return []
    const found: Instrument[] = []
    for (const [index, batch] of chunk(symbols, this.batchSize).entries()) {
      if (index > 0 && !this.keyed) await sleep(FREE_TIER_PACING_MS)
      const payload = await this.json('/v1/instruments', { symbols: batch.join(',') })
      const data = (payload as { data?: unknown }).data
      if (!Array.isArray(data)) continue
      for (const row of data) found.push(...instrumentOf(row as WireInstrument))
    }
    return found
  }

  /**
   * Issue one GET and decode its JSON body.
   * @param path - API path beginning with `/v1`.
   * @param query - query parameters; `undefined` values are dropped.
   * @returns the decoded body.
   * @throws {TickFlowError} on any transport, status, or decoding failure.
   */
  private async json(path: string, query: Record<string, string | undefined>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.apiKey !== undefined) headers['x-api-key'] = this.apiKey

    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new TickFlowError(`无法连接 TickFlow（${url.host}）：${reason}`)
    }

    if (!response.ok) throw await this.describeFailure(response)
    try {
      return await response.json()
    } catch {
      // A non-JSON body on a 200 is a proxy or captive-portal page, not the API.
      throw new TickFlowError(`TickFlow 返回了非 JSON 响应（HTTP ${String(response.status)}）`, {
        status: response.status,
      })
    }
  }

  /**
   * Turn a failed response into a {@link TickFlowError}, preferring the API's own
   * `{code, message}` error body.
   * @param response - the failed response.
   * @returns the error to throw.
   */
  private async describeFailure(response: Response): Promise<TickFlowError> {
    let code: string | undefined
    let detail: string | undefined
    const body = await response.text().catch(() => '')
    if (body !== '') {
      try {
        const parsed = JSON.parse(body) as { code?: unknown, message?: unknown }
        code = str(parsed.code) ?? undefined
        detail = str(parsed.message) ?? undefined
      } catch {
        // The service answers some 4xx with plain text rather than the JSON
        // error envelope; the raw body is still the most useful detail.
        detail = body.slice(0, 300)
      }
    }
    const suffix = detail === undefined ? '' : `：${detail}`
    // `exactOptionalPropertyTypes` rejects an explicitly undefined value, so the
    // provider's error code is only present when it actually sent one.
    const withCode = (status: number, message: string): TickFlowError => new TickFlowError(
      message,
      code === undefined ? { status } : { status, code },
    )
    if (response.status === 401) {
      return withCode(401, `TickFlow API Key 无效或缺失（HTTP 401）${suffix}`)
    }
    if (response.status === 429) {
      return withCode(429, `TickFlow 请求过于频繁，已被限流（HTTP 429），稍后再试${suffix}`)
    }
    return withCode(response.status, `TickFlow 请求失败（HTTP ${String(response.status)}）${suffix}`)
  }
}
