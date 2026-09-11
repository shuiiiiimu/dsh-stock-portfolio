/**
 * The per-symbol indicators behind an expanded holdings row.
 *
 * The rule these cases exist to pin down is the one that is easy to get wrong and
 * invisible when it is: a window longer than the stored series answers `null`,
 * never a number measured over fewer bars. A 60-day drawdown computed from eleven
 * sessions looks exactly like a real one on screen.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computeSymbolStats, RETURN_WINDOWS } from '../lib/index.js'

/** The first trading date of every synthetic series, so dates stay comparable. */
const EPOCH = Date.UTC(2026, 0, 1)

/**
 * Build a daily series from closes.
 * @param closes - the closes, oldest first.
 * @param options - `volumes`, `highs` and `lows` override the per-bar derivations.
 * @returns the bars, ascending.
 */
function bars(closes, options = {}) {
  return closes.map((close, index) => ({
    date: new Date(EPOCH + index * 86_400_000).toISOString().slice(0, 10),
    high: options.highs?.[index] ?? close,
    low: options.lows?.[index] ?? close,
    close,
    volume: options.volumes?.[index] ?? 100,
  }))
}

/**
 * A series of `count` bars whose closes step by one.
 * @param count - how many bars.
 * @param start - the first close.
 * @returns the bars, ascending.
 */
function ramp(count, start = 100) {
  return bars(Array.from({ length: count }, (_, index) => start + index))
}

test('the windows are measured in bars, back from the latest close', () => {
  const stats = computeSymbolStats(ramp(80))
  assert.equal(stats.barCount, 80)
  assert.equal(stats.lastClose, 179)
  assert.deepEqual(stats.returns.map(row => row.days), [...RETURN_WINDOWS])

  // 80 bars ending at 179: three bars back is 176, sixty bars back is 119.
  const three = stats.returns.find(row => row.days === 3)
  assert.equal(three.change, 3)
  assert.equal(three.pct, 3 / 176)
  const sixty = stats.returns.find(row => row.days === 60)
  assert.equal(sixty.change, 60)
  assert.equal(sixty.pct, 60 / 119)
})

test('a window longer than the series answers null rather than a shorter window', () => {
  const short = computeSymbolStats(ramp(59))
  // Every 60-bar measure refuses, and the 30-bar ones still answer.
  assert.equal(short.maxDrawdown60, null)
  assert.equal(short.rangePosition60, null)
  assert.equal(short.high60, null)
  assert.equal(short.low60, null)
  assert.notEqual(short.returns.find(row => row.days === 30)?.pct, null)

  const oneBar = computeSymbolStats(ramp(1))
  assert.deepEqual(oneBar.returns.map(row => row.pct), [null, null, null, null, null])
  assert.equal(oneBar.ma20, null)
  assert.equal(oneBar.volatility20, null)
  assert.equal(oneBar.volumeRatio, null)
  assert.equal(oneBar.streak, 0)
  assert.equal(oneBar.lastClose, 100)

  const empty = computeSymbolStats([])
  assert.equal(empty.barCount, 0)
  assert.equal(empty.lastClose, null)
  assert.equal(empty.firstDate, null)
  assert.equal(empty.lastDate, null)
})

test('the 20-day mean and its gap are the mean of the last twenty closes', () => {
  const stats = computeSymbolStats(ramp(80))
  // The last twenty closes run 160…179.
  assert.equal(stats.ma20, 169.5)
  assert.equal(stats.ma20Gap, 179 / 169.5 - 1)
})

test('volatility is the annualized deviation of the daily returns', () => {
  // Alternating +1% / −1%: the standard deviation is ~0.995% a day, so a year of
  // them is ~15.8%.
  const closes = [100]
  for (let index = 1; index <= 20; index += 1) {
    closes.push((closes[index - 1] ?? 0) * (index % 2 === 1 ? 1.01 : 1 / 1.01))
  }
  const stats = computeSymbolStats(bars(closes))
  assert.ok(stats.volatility20 !== null)
  assert.ok(Math.abs(stats.volatility20 - 0.158) < 0.005, `got ${String(stats.volatility20)}`)
})

test('the volume ratio compares the latest bar against the twenty before it', () => {
  const closes = Array.from({ length: 21 }, (_, index) => 100 + index)
  const volumes = closes.map((_, index) => (index === 20 ? 250 : 100))
  const stats = computeSymbolStats(bars(closes, { volumes }))
  assert.equal(stats.volumeRatio, 2.5)

  // Twenty bars is not enough for a baseline of twenty, so the ratio refuses.
  assert.equal(computeSymbolStats(bars(closes.slice(0, 20), { volumes: volumes.slice(0, 20) })).volumeRatio, null)
})

test('the 60-day drawdown is measured from the running peak, not the window open', () => {
  // Up from 100 to 195, down to 127.5, back up to 157: the decline's trough is
  // 67.5 under the peak, while the window's own low is still the 100 it opened
  // at — the two are different numbers, and the drawdown uses the first.
  const closes = [
    ...Array.from({ length: 20 }, (_, index) => 100 + index * 5),
    ...Array.from({ length: 10 }, (_, index) => 195 - index * 7.5),
    ...Array.from({ length: 30 }, (_, index) => 128 + index),
  ]
  const stats = computeSymbolStats(bars(closes))
  assert.equal(stats.barCount, 60)
  assert.equal(stats.high60, 195)
  assert.equal(stats.low60, 100)
  assert.ok(stats.maxDrawdown60 !== null)
  assert.ok(Math.abs(stats.maxDrawdown60 - 67.5 / 195) < 1e-9, `got ${String(stats.maxDrawdown60)}`)
  // The latest close (157) sits 57 of the 95 points above the window's low.
  assert.ok(stats.rangePosition60 !== null)
  assert.ok(Math.abs(stats.rangePosition60 - 57 / 95) < 1e-9, `got ${String(stats.rangePosition60)}`)
})

test('a flat window has no position inside its range', () => {
  const stats = computeSymbolStats(bars(Array.from({ length: 60 }, () => 42)))
  assert.equal(stats.maxDrawdown60, 0)
  assert.equal(stats.rangePosition60, null)
  assert.equal(stats.high60, 42)
  assert.equal(stats.low60, 42)
})

test('the streak is signed and stops at the first bar moving the other way', () => {
  const rising = computeSymbolStats(bars([10, 11, 12, 13]))
  assert.equal(rising.streak, 3)
  const falling = computeSymbolStats(bars([10, 13, 12, 11, 9]))
  assert.equal(falling.streak, -3)
  const flat = computeSymbolStats(bars([10, 11, 11]))
  assert.equal(flat.streak, 0)
  // An up move after a flat close still counts only the unbroken run.
  const mixed = computeSymbolStats(bars([10, 11, 11, 12, 13]))
  assert.equal(mixed.streak, 2)
})
