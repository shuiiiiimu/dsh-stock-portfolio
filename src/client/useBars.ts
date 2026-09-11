/**
 * The one place a symbol's daily series is fetched for the two views that draw
 * it: the expandable holdings row and the conversation's 提及 cards.
 *
 * The cache is keyed by symbol and tagged with the newest trading day the
 * portfolio held when it was read, which is what makes a refresh meaningful:
 * when the feed publishes a new bar, every visible row re-reads itself and
 * nothing else does.
 *
 * Requests are issued from an effect keyed on the symbols that are actually on
 * screen, so a wide portfolio costs one request per OPENED row rather than one
 * per holding — and the same series is never fetched twice while a request is in
 * flight.
 */
import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import type { SymbolBars } from './api.ts'

/**
 * Bars requested per symbol: roughly eight trading months. Enough for the 60-day
 * indicators to have their window, with a chart that still shows shape.
 */
export const DETAIL_BARS = 160

/** What one symbol's series request knows, once it has settled. */
export type BarsState =
  | { readonly status: 'ready', readonly body: SymbolBars }
  | { readonly status: 'error', readonly message: string }

/** The cache entry: one settled state plus the feed date it belongs to. */
type Bucket = BarsState & { readonly feed: string }

/**
 * Extract a displayable message from an unknown failure.
 * @param error - the thrown value.
 * @returns the message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read the stored series for a set of symbols.
 * @param symbols - the canonical symbols to load, in display order.
 * @param feedDate - the newest trading day the portfolio holds; a change
 * invalidates every cached series.
 * @returns one entry per symbol that has already loaded.
 */
export function useSymbolBars(
  symbols: readonly string[],
  feedDate: string,
): Readonly<Record<string, BarsState>> {
  const [buckets, setBuckets] = useState<Readonly<Record<string, Bucket>>>({})
  const inFlight = useRef<Set<string>>(new Set())
  const wanted = symbols.join('|')

  useEffect(() => {
    for (const symbol of symbols) {
      const key = `${symbol}|${feedDate}`
      if (buckets[symbol]?.feed === feedDate || inFlight.current.has(key)) continue
      inFlight.current.add(key)
      void (async () => {
        try {
          const body = await api.bars(symbol, DETAIL_BARS)
          // The views below read `stats.returns` and friends without a second
          // guard, so a truncated or half-written answer has to be refused here:
          // one missing field would otherwise take the whole pane down with it.
          if (!Array.isArray(body.bars) || body.stats === null || typeof body.stats !== 'object') {
            throw new Error('返回的日线数据不完整')
          }
          setBuckets(current => ({ ...current, [symbol]: { feed: feedDate, status: 'ready', body } }))
        } catch (error) {
          setBuckets(current => ({
            ...current,
            [symbol]: { feed: feedDate, status: 'error', message: messageOf(error) },
          }))
        } finally {
          inFlight.current.delete(key)
        }
      })()
    }
    // `buckets` is a dependency because the loop reads it: the guard above is
    // what makes the extra passes free, and `wanted` keeps a caller that builds
    // its array inline from re-running this on every render.
  }, [wanted, feedDate, buckets, symbols]) // eslint-disable-line react-hooks/exhaustive-deps

  const view: Record<string, BarsState> = {}
  for (const symbol of symbols) {
    const bucket = buckets[symbol]
    if (bucket !== undefined && bucket.feed === feedDate) view[symbol] = bucket
  }
  return view
}
