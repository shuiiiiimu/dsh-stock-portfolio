/**
 * The browser half's client for the host plugin's JSON API.
 *
 * Same-origin `fetch()` against the route the host half registers under
 * {@link API_PREFIX}. The browser attaches the session cookie automatically, so
 * there is no token to thread through and no DSH client service to inject — the
 * whole transport is `fetch`, which is why the dashboard bundle stays small.
 */
import type {
  Currency, EquityPoint, FxRefreshResult, MentionFeed, PortfolioSettings, PortfolioState, SymbolBar, SymbolMatch,
  SymbolStats, Trade, TradeInput,
} from '../types.ts'

/** Must match the host half's `API_PREFIX`. */
export const API_PREFIX = '/dsh-stock-portfolio/api'

/** What `GET /bars` answers: one symbol's series and the indicators over it. */
export interface SymbolBars {
  readonly symbol: string
  readonly bars: readonly SymbolBar[]
  readonly stats: SymbolStats
}

/** An error whose message came from the host and is safe to display. */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * Issue one API request and decode the JSON response.
 * @param path - path below {@link API_PREFIX}.
 * @param init - fetch options.
 * @returns the decoded body.
 * @throws {ApiError} when the response is not ok.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    headers: { accept: 'application/json', ...init?.body === undefined ? {} : { 'content-type': 'application/json' } },
    ...init,
  })
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new ApiError(`服务返回了非 JSON 响应（HTTP ${String(response.status)}）`, response.status)
  }
  if (!response.ok) {
    const message = (body as { error?: unknown } | undefined)?.error
    throw new ApiError(
      typeof message === 'string' ? message : `请求失败（HTTP ${String(response.status)}）`,
      response.status,
    )
  }
  return body as T
}

/** Serialize a value for a request body. */
function body(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value) }
}

/** Every host endpoint the dashboard uses. */
export const api = {
  /**
   * Read the complete portfolio snapshot.
   * @returns trades, positions, quotes and statistics.
   */
  state: (): Promise<PortfolioState> => request<PortfolioState>('/state'),

  /**
   * Add a trade.
   * @param trade - the trade fields.
   * @returns the inserted trade plus a fresh snapshot.
   */
  addTrade: (trade: TradeInput): Promise<{ trade: Trade, state: PortfolioState }> =>
    request('/trades', body(trade)),

  /**
   * Replace a trade's fields.
   * @param id - the trade id.
   * @param trade - the new fields.
   * @returns the updated trade plus a fresh snapshot.
   */
  updateTrade: (id: number, trade: TradeInput): Promise<{ trade: Trade, state: PortfolioState }> =>
    request(`/trades/${String(id)}`, { ...body(trade), method: 'PUT' }),

  /**
   * Delete a trade.
   * @param id - the trade id.
   * @returns a fresh snapshot.
   */
  deleteTrade: (id: number): Promise<{ state: PortfolioState }> =>
    request(`/trades/${String(id)}`, { method: 'DELETE' }),

  /**
   * Fetch fresh prices.
   * @param force - bypass the cache.
   * @returns a fresh snapshot.
   */
  refresh: (force = false): Promise<PortfolioState> =>
    request('/refresh', body({ force })),

  /**
   * Change settings.
   * @param patch - the fields to change.
   * @returns the new settings plus a fresh snapshot.
   */
  saveSettings: (patch: {
    apiKey?: string | null
    baseCurrency?: Currency
    usdHkd?: number
    usdCny?: number
    refreshIntervalMinutes?: number
    autoRefresh?: boolean
  }): Promise<{ settings: PortfolioSettings, state: PortfolioState }> =>
    request('/settings', { ...body(patch), method: 'PUT' }),

  /**
   * Rebuild the local instrument name index from the service's exchange lists.
   * @returns a fresh snapshot, carrying the rebuilt index's size.
   */
  syncInstruments: (): Promise<PortfolioState> =>
    request('/instruments/sync', body({})),

  /**
   * Refresh the USD→CNY / USD→HKD pair through the host's web capability.
   * @param force - fetch even when the host's freshness guard would skip.
   * @returns the outcome plus a fresh snapshot carrying the new rates.
   */
  refreshRates: (force = false): Promise<{ result: FxRefreshResult, state: PortfolioState }> =>
    request('/rates/refresh', body({ force })),

  /**
   * Load the reconstructed equity curve.
   * @param days - how many calendar days of history to request.
   * @returns ascending points.
   */
  equity: (days: number): Promise<{ points: EquityPoint[] }> =>
    request(`/equity?days=${String(days)}`),

  /**
   * Load one symbol's trailing daily bars and their indicators, for the row a
   * user just expanded.
   * @param symbol - the canonical symbol.
   * @param limit - how many trailing bars to draw.
   * @returns the canonical symbol, its bars, and the indicator block.
   */
  bars: (symbol: string, limit = 160): Promise<SymbolBars> =>
    request(`/bars?symbol=${encodeURIComponent(symbol)}&limit=${String(limit)}`),

  /**
   * Read one session's conversation mention feed.
   * @param sessionId - the session on screen.
   * @returns that session's newest revision plus its recent batches.
   */
  mentions: (sessionId: string): Promise<MentionFeed> =>
    request<MentionFeed>(`/mentions?session=${encodeURIComponent(sessionId)}`),

  /**
   * Search the instrument index for a symbol or name.
   * @param query - the symbol or name fragment.
   * @returns matching instruments.
   */
  lookup: (query: string): Promise<{ matches: SymbolMatch[] }> =>
    request(`/lookup?q=${encodeURIComponent(query)}`),
}
