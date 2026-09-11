/**
 * Number and date formatting for the dashboard.
 *
 * Chinese trading conventions drive two choices here: thousands separators with
 * two decimals for money, and a red-up / green-down colour pairing (the
 * opposite of a Western equity UI). Both are applied through CSS classes so the
 * theme owns the actual colours.
 */
import type { Currency } from '../types.ts'

/** Currency symbols for the three markets this plugin books. */
const SYMBOLS: Readonly<Record<Currency, string>> = { CNY: '¥', HKD: 'HK$', USD: 'US$' }

/**
 * Format a money amount.
 * @param value - the amount, or `null` when it is not known.
 * @param currency - the amount's currency.
 * @param options - `signed` prefixes a `+` for positives.
 * @returns the formatted string, or an em dash when the value is missing.
 */
export function money(
  value: number | null | undefined,
  currency: Currency,
  options: { signed?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const formatted = Math.abs(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const sign = value < 0 ? '-' : options.signed === true && value > 0 ? '+' : ''
  return `${sign}${SYMBOLS[currency]}${formatted}`
}

/**
 * Format a raw number with fixed decimals.
 * @param value - the number, or `null`.
 * @param digits - decimal places.
 * @returns the formatted string, or an em dash.
 */
export function number(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

/**
 * Format a share count, trimming trailing zeros a broker statement would drop.
 * @param value - the quantity, or `null`.
 * @returns the formatted string, or an em dash.
 */
export function quantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
}

/**
 * Format a ratio as a percentage.
 * @param value - the ratio (`0.0123` is `1.23%`), or `null`.
 * @param options - `signed` prefixes a `+` for positives.
 * @returns the formatted string, or an em dash.
 */
export function percent(value: number | null | undefined, options: { signed?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const sign = value > 0 && options.signed === true ? '+' : ''
  return `${sign}${(value * 100).toFixed(2)}%`
}

/**
 * Format a money amount and a ratio together, the way a P&L cell reads.
 * @param amount - the money amount, or `null`.
 * @param ratio - the ratio, or `null`.
 * @param currency - the amount's currency.
 * @returns e.g. `+HK$1,234.00 (+2.31%)`, or `—` when nothing is known.
 */
export function moneyWithPercent(
  amount: number | null | undefined,
  ratio: number | null | undefined,
  currency: Currency,
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—'
  return ratio === null || ratio === undefined
    ? money(amount, currency, { signed: true })
    : `${money(amount, currency, { signed: true })} (${percent(ratio, { signed: true })})`
}

/**
 * The CSS class carrying the up/down direction of a number.
 * @param value - the number, or `null`.
 * @returns the direction class.
 */
export function tone(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return 'dsp-flat'
  return value > 0 ? 'dsp-up' : 'dsp-down'
}

/**
 * Render an ISO instant as a short local date-time.
 * @param iso - the ISO-8601 string, or `null`.
 * @returns e.g. `09-11 21:30`, or an em dash.
 */
export function timestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return '—'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/**
 * Render how long ago an instant was, in the coarsest useful unit.
 * @param iso - the ISO-8601 string, or `null`.
 * @param now - the reference instant.
 * @returns e.g. `刚刚`, `5 分钟前`, `2 小时前`, `3 天前`.
 */
export function relative(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return '—'
  const seconds = Math.max(0, Math.round((now.getTime() - parsed) / 1000))
  if (seconds < 45) return '刚刚'
  if (seconds < 3600) return `${String(Math.round(seconds / 60))} 分钟前`
  if (seconds < 86_400) return `${String(Math.round(seconds / 3600))} 小时前`
  return `${String(Math.round(seconds / 86_400))} 天前`
}

/**
 * Today as `YYYY-MM-DD` in the browser's own timezone.
 * @param now - the reference instant.
 * @returns the date string.
 */
export function today(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Shorten a symbol for a table cell, keeping the exchange suffix visible.
 * @param symbol - the canonical symbol.
 * @returns the code and suffix separately.
 */
export function splitSymbol(symbol: string): { code: string, suffix: string } {
  const dot = symbol.lastIndexOf('.')
  return dot <= 0
    ? { code: symbol, suffix: '' }
    : { code: symbol.slice(0, dot), suffix: symbol.slice(dot + 1) }
}
