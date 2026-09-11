/**
 * Symbol normalization, for every market the provider covers.
 *
 * An instrument is addressed as `<code>.<exchange>`, where the exchange is
 * one of `SH`, `SZ`, `BJ`, `HK` or `US`. The markets disagree about what a code
 * looks like, so everything a user types goes through {@link normalizeSymbol}
 * first and the database, the price table and the API client only ever see
 * canonical symbols.
 *
 * | Market | Form | Note |
 * | --- | --- | --- |
 * | Shanghai / Shenzhen / Beijing | `600000.SH`, `000001.SZ`, `430047.BJ` | six digits |
 * | Hong Kong | `00700.HK` | **zero-padded to five digits** |
 * | United States | `AAPL.US` | one pseudo-exchange for NYSE, NASDAQ and AMEX |
 *
 * The Hong Kong padding is load-bearing: the API answers `700.HK` and `0700.HK`
 * with an empty result set rather than an error, so an unpadded code looks like
 * a broken feed instead of a symbol bug.
 *
 * A bare code is resolved by shape — the same inference every Chinese broker app
 * performs — because that is what a user types. The inference is always visible
 * in the resolved symbol, so a wrong guess is correctable rather than silent.
 *
 * One case is genuinely ambiguous and stays that way: an index code such as
 * `000300` (CSI 300, listed as `000300.SH`) has the same shape as a Shenzhen
 * equity. Shape cannot decide it, so the shorthand resolves to Shenzhen and the
 * suffix settles it. The instrument index is the real answer — searching for
 * `000300` or `沪深300` returns the canonical symbol directly.
 */
import type { Currency, Exchange, InstrumentType } from './types.ts'
import { PortfolioError } from './types.ts'

/** A canonical symbol together with the facts derived from its suffix. */
export interface ParsedSymbol {
  /** Canonical `CODE.SUFFIX` form. */
  readonly symbol: string
  readonly exchange: Exchange
  readonly currency: Currency
  /** The exchange-local code, without the suffix (`600000`, `00700`, `BRK.B`). */
  readonly code: string
}

/** Currencies by exchange — one per region the provider covers. */
const EXCHANGE_CURRENCY: Readonly<Record<string, Currency>> = {
  SH: 'CNY',
  SZ: 'CNY',
  BJ: 'CNY',
  HK: 'HKD',
  US: 'USD',
}

/**
 * What an unrecognized exchange falls back to.
 *
 * The provider only lists the five exchanges above, so this is unreachable in
 * practice; it exists so that adding a market upstream degrades to a plausible
 * currency instead of throwing on an otherwise valid symbol.
 */
const FALLBACK_CURRENCY: Currency = 'USD'

/** Human labels for the exchanges, shared by the host's breakdowns and the UI. */
const EXCHANGE_LABEL: Readonly<Record<string, string>> = {
  SH: '上交所',
  SZ: '深交所',
  BJ: '北交所',
  HK: '港股',
  US: '美股',
}

/** An exchange suffix: two to four upper-case letters. */
const SUFFIX_PATTERN = /^[A-Z]{2,4}$/u

/**
 * Zero-pad a Hong Kong code to the five digits the exchange uses.
 * @param code - the code as typed, e.g. `700`.
 * @returns the padded code, e.g. `00700`.
 */
export function padHongKongCode(code: string): string {
  return /^\d{1,5}$/u.test(code) ? code.padStart(5, '0') : code
}

/**
 * Resolve a bare six-digit mainland code to its exchange.
 *
 * The prefixes are the exchange's own allocation, not a heuristic: `60`/`68`/`9`
 * are Shanghai, `00`/`30`/`2` are Shenzhen, `4`/`8` are Beijing.
 * @param code - a six-digit code.
 * @returns the exchange code.
 */
export function inferMainlandExchange(code: string): Exchange {
  const head = code.slice(0, 1)
  const two = code.slice(0, 2)
  if (head === '6' || head === '9') return 'SH'
  if (head === '0' || head === '3' || head === '2') return 'SZ'
  if (head === '4' || head === '8') return 'BJ'
  // `5` is SH funds and `1` is SZ funds; anything else defaults to Shanghai,
  // which is where the largest share of six-digit instruments lives.
  if (two === '51' || two === '58' || head === '5') return 'SH'
  if (two === '15' || two === '16' || two === '18') return 'SZ'
  return 'SH'
}

/**
 * Build the parsed record for one exchange and code.
 * @param exchange - the resolved exchange.
 * @param code - the exchange-local, already-normalized code.
 * @returns the canonical symbol and its derived facts.
 * @throws {PortfolioError} when the code is empty after normalization.
 */
function parsed(exchange: Exchange, code: string): ParsedSymbol {
  // `.HK` and `..US` reach here with an empty or punctuation-only code; a symbol
  // needs at least one alphanumeric character before the suffix.
  if (!/[A-Za-z0-9]/u.test(code)) {
    throw new PortfolioError(`无法识别的股票代码「${code}.${exchange}」，缺少标的代码`)
  }
  return {
    symbol: `${code}.${exchange}`,
    exchange,
    currency: EXCHANGE_CURRENCY[exchange] ?? FALLBACK_CURRENCY,
    code,
  }
}

/**
 * Canonicalize a user-typed symbol.
 *
 * Accepts a bare code (`700`, `600000`, `aapl`), a suffixed code in any case
 * (`700.hk`, `aapl.us`), or an already-canonical symbol.
 * @param input - raw user input.
 * @returns the parsed canonical symbol.
 * @throws {PortfolioError} when the input cannot name an instrument.
 */
export function normalizeSymbol(input: string): ParsedSymbol {
  const trimmed = input.trim().toUpperCase().replace(/\s+/gu, '')
  if (trimmed === '') throw new PortfolioError('股票代码不能为空')

  const dot = trimmed.lastIndexOf('.')
  const suffix = dot > 0 ? trimmed.slice(dot + 1) : ''

  // A leading dot means the code before the suffix is empty, so there is no
  // instrument to address however recognizable the suffix looks.
  if (dot === 0) {
    throw new PortfolioError(`无法识别的股票代码「${input}」，缺少标的代码`)
  }

  if (SUFFIX_PATTERN.test(suffix)) {
    // The exchange spells a class share `BRK.B`, so a dash inside the code is
    // always the same instrument written the other way.
    const code = trimmed.slice(0, dot).replace(/-/gu, '.')
    if (code === '') throw new PortfolioError('股票代码不能为空')
    return parsed(suffix, suffix === 'HK' ? padHongKongCode(code) : code)
  }

  // A trailing dot is a typo, never a suffix.
  if (dot === trimmed.length - 1) {
    throw new PortfolioError(`无法识别的股票代码「${input}」，请写成 600000.SH / 00700.HK / AAPL.US 之类的形式`)
  }

  // A dot that is not an exchange suffix is part of the code itself (`BRK.B`).
  const code = trimmed.replace(/-/gu, '.')

  if (/^\d+$/u.test(code)) {
    if (code.length <= 5) return parsed('HK', padHongKongCode(code))
    if (code.length === 6) return parsed(inferMainlandExchange(code), code)
    throw new PortfolioError(`无法识别的股票代码「${input}」，请带上交易所后缀，例如 600000.SH`)
  }

  // Anything alphabetic is a US ticker: no other covered market uses
  // letter codes, so this needs no guess.
  return parsed('US', code)
}

/**
 * Read the exchange back out of a canonical symbol.
 * @param symbol - a canonical `CODE.SUFFIX` symbol.
 * @returns the exchange code.
 * @throws {PortfolioError} when the symbol carries no exchange suffix.
 */
export function exchangeOfSymbol(symbol: string): Exchange {
  const dot = symbol.lastIndexOf('.')
  if (dot <= 0) throw new PortfolioError(`「${symbol}」缺少交易所后缀`)
  return symbol.slice(dot + 1)
}

/**
 * The currency a canonical symbol trades in.
 * @param symbol - a canonical symbol.
 * @returns the currency.
 */
export function currencyOfSymbol(symbol: string): Currency {
  return EXCHANGE_CURRENCY[exchangeOfSymbol(symbol)] ?? FALLBACK_CURRENCY
}

/**
 * The display label for an exchange.
 * @param exchange - the exchange code.
 * @returns a Chinese label, falling back to the raw code for an unknown market.
 */
export function exchangeLabel(exchange: Exchange): string {
  return EXCHANGE_LABEL[exchange] ?? exchange
}

/**
 * Whether a string is already in canonical form.
 * @param symbol - candidate symbol.
 * @returns true when {@link normalizeSymbol} would return it unchanged.
 */
export function isCanonicalSymbol(symbol: string): boolean {
  try {
    return normalizeSymbol(symbol).symbol === symbol
  } catch {
    return false
  }
}

/**
 * Narrow an arbitrary wire string to a known instrument class.
 * @param value - the raw `type` field.
 * @returns the class, or `null` when it is absent or unrecognized.
 */
export function instrumentType(value: unknown): InstrumentType | null {
  const known: readonly InstrumentType[] = ['stock', 'etf', 'index', 'bond', 'fund', 'options', 'other']
  return typeof value === 'string' && (known as readonly string[]).includes(value)
    ? (value as InstrumentType)
    : null
}

/** Every exchange currency the plugin knows, in reporting order. */
export const KNOWN_CURRENCIES: readonly Currency[] = ['CNY', 'HKD', 'USD']

export { EXCHANGE_CURRENCY }
