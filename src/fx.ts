/**
 * Exchange rates for the dashboard, read through the harness's own web
 * capability.
 *
 * The plugin reports cross-market totals in one base currency, so it needs
 * USD→CNY and USD→HKD. Those two numbers used to be an editable constant pair;
 * they are now refreshed from the web by {@link acquireRates}, which is the only
 * network path here and never touches the market-data provider.
 *
 * ## Two routes, one shape
 *
 *   1. **`ctx.web.fetch` on a JSON rate endpoint** — authoritative, ~200 ms, and
 *      it states the rate's own date. This is the route that runs almost always.
 *   2. **`ctx.web.search`** — only when every endpoint refuses. The numbers are
 *      then mined out of citation snippets, so they pass a plausibility band and
 *      a cross-rate check before anyone believes them.
 *
 * Both are harness providers: this module never hard-codes an HTTP client, and a
 * deployment with no web capability simply fails with a message instead of a
 * wrong number.
 */

/** What one search-capable backend returns; mirrors `@deepseek-ai/dsh-web`. */
export interface WebSearchOutcome {
  readonly content?: string | undefined
  readonly sources: readonly {
    readonly url: string
    readonly title?: string | undefined
    readonly snippet?: string | undefined
  }[]
  readonly truncated: boolean
}

/** What one fetch-capable backend returns; mirrors `@deepseek-ai/dsh-web`. */
export interface WebFetchOutcome {
  readonly url: string
  readonly statusCode: number
  readonly body: { readonly kind: string, readonly content: string }
  readonly truncated: boolean
}

/** The slice of `ctx.web` this plugin uses. */
export interface WebCapability {
  search(request: { readonly query: string, readonly maxResults?: number }, signal?: AbortSignal): Promise<WebSearchOutcome>
  fetch(request: { readonly url: string }, signal?: AbortSignal): Promise<WebFetchOutcome>
}

/** Which route produced the rates currently stored. */
export type FxRateSource = 'web-fetch' | 'web-search' | 'manual' | 'default'

/** One accepted set of rates. */
export interface FxQuote {
  /** Units of CNY that one USD buys. */
  readonly usdCny: number
  /** Units of HKD that one USD buys. */
  readonly usdHkd: number
  readonly source: Exclude<FxRateSource, 'manual' | 'default'>
  /** The endpoint id or route that answered, for display. */
  readonly provider: string
  /** The provider's own rate date (`YYYY-MM-DD`), when it states one. */
  readonly asOf: string | null
}

/** One route that did not produce rates. */
export interface FxFailure {
  readonly route: string
  readonly reason: string
}

/** The outcome of one acquisition: rates, or every reason none arrived. */
export type FxAcquisition =
  | { readonly ok: true, readonly quote: FxQuote, readonly failures: readonly FxFailure[] }
  | { readonly ok: false, readonly failures: readonly FxFailure[] }

/**
 * Plausible bands for the two pairs.
 *
 * A band, not a check: it is what keeps a percentage, a share price, or a
 * headline about another currency out of the rate table. Both are wide enough to
 * survive a real devaluation and narrow enough to reject anything that is
 * obviously not this pair.
 */
const PLAUSIBLE: Readonly<Record<'CNY' | 'HKD', readonly [number, number]>> = {
  CNY: [4, 12],
  HKD: [7, 8.5],
}

/**
 * How far a candidate number may sit from its currency keyword.
 *
 * Wide enough for `1 美元 = 7.1234 人民币` and for a snippet that names the pair
 * before the number, narrow enough that a neighbouring rate is not picked up.
 */
const KEYWORD_WINDOW = 48

/** A number with the two-to-five decimals every published rate has. */
const NUMBER_PATTERN = /\d{1,2}\.\d{2,5}/gu

/** Keywords that identify each side of a pair, Chinese and English. */
const KEYWORDS: Readonly<Record<'CNY' | 'HKD', readonly string[]>> = {
  CNY: ['人民币', '人民幣', 'CNY', 'RMB', 'yuan', 'Yuan'],
  HKD: ['港币', '港幣', '港元', 'HKD', 'Hong Kong dollar'],
}

/** How long one JSON endpoint gets before the next route is tried. */
const FETCH_TIMEOUT_MS = 12_000

/** How long the search fallback gets. A search is a model request, not a GET. */
const SEARCH_TIMEOUT_MS = 45_000

/** The query the search fallback runs. One query answers both pairs. */
export const FX_SEARCH_QUERY = '今日 1 美元 兑 人民币 港币 汇率 USD CNY HKD exchange rate today'

/** The JSON rate endpoints, in the order they are tried. */
export const FX_ENDPOINTS: readonly {
  readonly id: string
  readonly url: string
  readonly parse: (payload: unknown) => FxQuote | null
}[] = [
  {
    id: 'frankfurter.dev',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY,HKD',
    // { base: 'USD', date: '2026-09-11', rates: { CNY: 6.7082, HKD: 7.842 } }
    parse: payload => {
      const record = asRecord(payload)
      const rates = asRecord(record?.['rates'])
      return quoteFromRates(rates, 'frankfurter.dev', asDate(record?.['date']))
    },
  },
  {
    id: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    // { result: 'success', time_last_update_unix: 1757..., rates: { CNY: 6.7, HKD: 7.84 } }
    parse: payload => {
      const record = asRecord(payload)
      if (record?.['result'] !== undefined && record['result'] !== 'success') return null
      const asOf = typeof record?.['time_last_update_unix'] === 'number'
        ? new Date(record['time_last_update_unix'] * 1000).toISOString().slice(0, 10)
        : null
      return quoteFromRates(asRecord(record?.['rates']), 'open.er-api.com', asOf)
    },
  },
]

/**
 * Narrow an unknown value to a plain object.
 * @param value - the value to inspect.
 * @returns the record, or `null`.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Read a `YYYY-MM-DD` string out of an unknown value.
 * @param value - the value to inspect.
 * @returns the date, or `null`.
 */
function asDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null
}

/**
 * Accept one `{ CNY, HKD }` pair when both members are plausible.
 * @param rates - the decoded `rates` object.
 * @param provider - the route id, for display.
 * @param asOf - the provider's own date.
 * @returns the quote, or `null` when a member is missing or out of band.
 */
function quoteFromRates(
  rates: Record<string, unknown> | null,
  provider: string,
  asOf: string | null,
): FxQuote | null {
  const cny = rates?.['CNY']
  const hkd = rates?.['HKD']
  if (typeof cny !== 'number' || typeof hkd !== 'number') return null
  if (!plausible('CNY', cny) || !plausible('HKD', hkd)) return null
  return { usdCny: round4(cny), usdHkd: round4(hkd), source: 'web-fetch', provider, asOf }
}

/**
 * Whether a value sits inside its pair's plausible band.
 * @param pair - the pair.
 * @param value - the candidate rate.
 * @returns true when the value could be that pair's rate.
 */
function plausible(pair: 'CNY' | 'HKD', value: number): boolean {
  const [min, max] = PLAUSIBLE[pair]
  return Number.isFinite(value) && value >= min && value <= max
}

/**
 * Round to four decimals, the precision every published rate carries.
 * @param value - the raw rate.
 * @returns the rounded rate.
 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * Find the number nearest a currency keyword.
 *
 * The search route returns prose, so a bare regex over it would happily read a
 * percentage or a date as a rate. Anchoring to the keyword and then requiring the
 * value to fall inside the pair's band is what makes the fallback trustworthy
 * enough to use at all.
 * @param text - the snippet, title, or answer text.
 * @param pair - which pair's keywords to anchor on.
 * @returns the nearest plausible number, or `null`.
 */
function nearestRate(text: string, pair: 'CNY' | 'HKD'): number | null {
  const [min, max] = PLAUSIBLE[pair]
  const candidates: { index: number, value: number }[] = []
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const value = Number(match[0])
    const at = match.index
    if (at === undefined || !Number.isFinite(value) || value < min || value > max) continue
    // `2.35%` is a change, not a rate.
    if (text[at + match[0].length] === '%') continue
    candidates.push({ index: at, value })
  }
  if (candidates.length === 0) return null

  let best: { distance: number, value: number } | null = null
  for (const keyword of KEYWORDS[pair]) {
    for (let at = text.indexOf(keyword); at !== -1; at = text.indexOf(keyword, at + keyword.length)) {
      for (const candidate of candidates) {
        const distance = Math.abs(candidate.index - at)
        if (distance > KEYWORD_WINDOW) continue
        if (best === null || distance < best.distance) best = { distance, value: candidate.value }
      }
    }
  }
  return best?.value ?? null
}

/**
 * Mine both rates out of one search outcome.
 *
 * Exported for its own tests: this is the only heuristic in the plugin, and it is
 * the part that must not silently invent a number.
 * @param outcome - the search result.
 * @returns the accepted quote, or `null` when either pair is missing.
 */
export function parseRatesFromSearch(outcome: WebSearchOutcome): FxQuote | null {
  const text = [
    outcome.content ?? '',
    ...outcome.sources.flatMap(source => [source.title ?? '', source.snippet ?? '']),
  ].join('\n')
  const cny = nearestRate(text, 'CNY')
  const hkd = nearestRate(text, 'HKD')
  if (cny === null || hkd === null) return null
  // A snippet about two unrelated currencies can carry one good number each, so
  // the implied cross rate has to be believable too (HKD/CNY ≈ 0.86).
  const cross = cny / hkd
  if (cross < 0.6 || cross > 1.2) return null
  return { usdCny: round4(cny), usdHkd: round4(hkd), source: 'web-search', provider: 'web_search', asOf: null }
}

/**
 * Parse one endpoint's JSON body.
 * @param body - the decoded body text.
 * @returns the rate quote, or `null` when the payload is not usable.
 */
function parseEndpointBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}

/**
 * Refresh both rates through the harness web capability.
 *
 * Endpoints first (fast, exact, dated), search only as the fallback. Every route
 * that fails is reported, so the caller can say *why* the rates are unchanged
 * instead of leaving the user with a stale number and no explanation.
 * @param web - the harness web capability.
 * @param options - `signal` cancels both routes.
 * @returns the quote, or every failure.
 */
export async function acquireRates(
  web: WebCapability,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<FxAcquisition> {
  const failures: FxFailure[] = []

  for (const endpoint of FX_ENDPOINTS) {
    try {
      const outcome = await web.fetch(
        { url: endpoint.url },
        options.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      )
      if (outcome.statusCode !== 200) {
        failures.push({ route: endpoint.id, reason: `HTTP ${String(outcome.statusCode)}` })
        continue
      }
      const quote = endpoint.parse(parseEndpointBody(outcome.body.content))
      if (quote === null) {
        failures.push({ route: endpoint.id, reason: '响应中没有可用的 USD→CNY / USD→HKD 汇率' })
        continue
      }
      return { ok: true, quote, failures }
    } catch (error) {
      failures.push({ route: endpoint.id, reason: messageOf(error) })
    }
  }

  try {
    const outcome = await web.search(
      { query: FX_SEARCH_QUERY, maxResults: 6 },
      options.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    )
    const quote = parseRatesFromSearch(outcome)
    if (quote !== null) return { ok: true, quote, failures }
    failures.push({ route: 'web_search', reason: '搜索结果里没有可解析的汇率' })
  } catch (error) {
    failures.push({ route: 'web_search', reason: messageOf(error) })
  }

  return { ok: false, failures }
}

/**
 * Render an unknown failure as a one-line reason.
 * @param error - the thrown value.
 * @returns the message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
