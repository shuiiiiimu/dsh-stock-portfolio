/**
 * Per-symbol indicators for the expanded holdings row.
 *
 * Everything here reads the stored daily bars and nothing else: no provider
 * call, no second table, no clock. That is deliberate — the panel opens a row
 * on a click, so the numbers have to be free, and a pure function of the series
 * is also the only kind of indicator that can be pinned down by a test without
 * a network stub.
 *
 * Every window below is counted in **bars**, not calendar days. The bars are
 * trading days, so "3 日" means the last three sessions, which is what a broker
 * app means by it too; a week of holidays simply does not consume a slot.
 *
 * A window longer than the series is answered with `null` rather than with the
 * bars that do exist. Truncating a 60-day drawdown to eleven bars would print a
 * number that looks like the others and means something else.
 */
import type { PeriodReturn, SymbolBar, SymbolStats } from './types.ts'

/** The windows the detail panel reports, in trading days. */
export const RETURN_WINDOWS: readonly number[] = [3, 5, 15, 30, 60]

/** Bars behind the moving average and the volatility measure. */
const MA_WINDOW = 20

/** Bars behind the volume ratio, the drawdown and the range position. */
const RANGE_WINDOW = 60

/** Bars used to average volume before the latest one. */
const VOLUME_WINDOW = 20

/** Trading sessions in a year, for annualizing a daily standard deviation. */
const TRADING_DAYS = 252

/**
 * Read a close `days` bars back from the end.
 * @param bars - the series, ascending (oldest first).
 * @param days - the lookback in bars; 0 is the latest bar.
 * @returns the close, or `null` when the series does not reach back that far.
 */
function closeBack(bars: readonly SymbolBar[], days: number): number | null {
  const index = bars.length - 1 - days
  if (index < 0) return null
  return bars[index]?.close ?? null
}

/**
 * The move over each configured window.
 * @param bars - the series, ascending.
 * @returns one row per window, in {@link RETURN_WINDOWS} order.
 */
function periodReturns(bars: readonly SymbolBar[]): PeriodReturn[] {
  const last = bars.at(-1)?.close ?? null
  return RETURN_WINDOWS.map((days) => {
    const past = closeBack(bars, days)
    if (last === null || past === null || past === 0) {
      return { days, change: null, pct: null }
    }
    const change = last - past
    return { days, change, pct: change / past }
  })
}

/**
 * The mean of a slice of closes.
 * @param bars - the series, ascending.
 * @param count - how many trailing bars to average.
 * @returns the mean, or `null` when the series is shorter than the window.
 */
function trailingMean(bars: readonly SymbolBar[], count: number): number | null {
  if (bars.length < count) return null
  const slice = bars.slice(bars.length - count)
  return slice.reduce((sum, bar) => sum + bar.close, 0) / slice.length
}

/**
 * Annualized volatility of the trailing daily returns.
 * @param bars - the series, ascending.
 * @param count - how many trailing returns to measure.
 * @returns the annualized standard deviation, or `null` with too few bars.
 */
function volatility(bars: readonly SymbolBar[], count: number): number | null {
  if (bars.length < count + 1) return null
  const slice = bars.slice(bars.length - (count + 1))
  const returns: number[] = []
  for (let index = 1; index < slice.length; index += 1) {
    const previous = slice[index - 1]?.close ?? 0
    const current = slice[index]?.close ?? 0
    if (previous > 0) returns.push(current / previous - 1)
  }
  if (returns.length < 2) return null
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  // Sample variance: the returns are a sample of the process, not the process.
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS)
}

/**
 * The deepest peak-to-trough fall inside a window.
 * @param window - the trailing bars to measure.
 * @returns the drawdown as a positive ratio, or `null` with too few bars.
 */
function maxDrawdown(window: readonly SymbolBar[]): number | null {
  if (window.length < 2) return null
  let peak = window[0]?.close ?? 0
  let worst = 0
  for (const bar of window) {
    if (bar.close > peak) peak = bar.close
    if (peak <= 0) continue
    worst = Math.max(worst, (peak - bar.close) / peak)
  }
  return worst
}

/**
 * Count the consecutive closes moving the same way as the latest one.
 * @param bars - the series, ascending.
 * @returns a positive run of up days, a negative run of down days, or 0.
 */
function streak(bars: readonly SymbolBar[]): number {
  if (bars.length < 2) return 0
  const last = bars.at(-1)?.close ?? 0
  const previous = bars.at(-2)?.close ?? 0
  if (last === previous) return 0
  const rising = last > previous
  let count = 0
  for (let index = bars.length - 1; index > 0; index -= 1) {
    const current = bars[index]?.close ?? 0
    const before = bars[index - 1]?.close ?? 0
    if (current === before || (current > before) !== rising) break
    count += 1
  }
  return rising ? count : -count
}

/**
 * Measure one symbol's series.
 *
 * An empty series is answered with an all-null block rather than an error: a
 * position whose bars were never fetched is a normal state in this plugin (the
 * code may not resolve at the provider), and the row still has to render.
 * @param bars - the stored daily bars, ascending.
 * @returns the indicator block.
 */
export function computeSymbolStats(bars: readonly SymbolBar[]): SymbolStats {
  const lastClose = bars.at(-1)?.close ?? null
  const ma20 = trailingMean(bars, MA_WINDOW)
  const window = bars.length >= RANGE_WINDOW ? bars.slice(bars.length - RANGE_WINDOW) : []
  const high60 = window.length === 0 ? null : Math.max(...window.map(bar => bar.high))
  const low60 = window.length === 0 ? null : Math.min(...window.map(bar => bar.low))

  // The volume ratio compares the latest bar against the twenty BEFORE it: a
  // day that is part of its own baseline can never read as unusual.
  const hasVolumeBase = bars.length >= VOLUME_WINDOW + 1
  const trailingVolume = hasVolumeBase ? bars.slice(bars.length - 1 - VOLUME_WINDOW, bars.length - 1) : []
  const averageVolume = trailingVolume.length === 0
    ? null
    : trailingVolume.reduce((sum, bar) => sum + bar.volume, 0) / trailingVolume.length
  const lastVolume = bars.at(-1)?.volume ?? null

  const rangePosition60 = high60 === null || low60 === null || high60 === low60 || lastClose === null
    ? null
    : (lastClose - low60) / (high60 - low60)

  return {
    barCount: bars.length,
    firstDate: bars[0]?.date ?? null,
    lastDate: bars.at(-1)?.date ?? null,
    lastClose,
    returns: periodReturns(bars),
    ma20,
    ma20Gap: lastClose === null || ma20 === null || ma20 === 0 ? null : lastClose / ma20 - 1,
    volatility20: volatility(bars, MA_WINDOW),
    volumeRatio: averageVolume === null || averageVolume === 0 || lastVolume === null
      ? null
      : lastVolume / averageVolume,
    maxDrawdown60: maxDrawdown(window),
    rangePosition60,
    high60,
    low60,
    streak: streak(bars),
  }
}
