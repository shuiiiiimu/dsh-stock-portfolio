/**
 * The expanded holdings row's chart: the daily close as a line over the volume
 * that traded, plus a dashed cost line and a marker per recorded trade.
 *
 * Hand-drawn SVG, for the same reason {@link EquityChart} is: the client bundle
 * may only `require` React and the DSH primitives, so a charting library would
 * have to be inlined whole.
 *
 * Volumes hang below the price band on a scale of their own — a closed price of
 * ¥12 and a volume of 3.4亿 share no axis, and putting them on one is the classic
 * way a price chart becomes unreadable. The two bands are drawn in one SVG so a
 * vertical crosshair, a trade marker, and the hovered bar all line up.
 */
import { useState } from 'react'
import { compact, money } from './format.ts'
import type { Currency, SymbolBar, Trade } from '../types.ts'

/** Plot geometry, in viewBox units. */
const WIDTH = 640
const HEIGHT = 196
const PAD = { top: 10, right: 44, bottom: 20, left: 8 }
/** Where the price band ends and the volume band begins. */
const PRICE_BOTTOM = 118
const VOLUME_TOP = 132

/**
 * Render one symbol's price and volume history.
 * @param props - the bars, the reporting currency, the position's cost, and the
 * trades recorded on this symbol.
 * @returns the chart element.
 */
export function SymbolChart({ bars, currency, cost, trades }: {
  bars: readonly SymbolBar[]
  currency: Currency
  cost: number | null
  trades: readonly Trade[]
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (bars.length < 2) return null

  const plotWidth = WIDTH - PAD.left - PAD.right
  const priceHeight = PRICE_BOTTOM - PAD.top
  const volumeHeight = HEIGHT - PAD.bottom - VOLUME_TOP

  // The cost line belongs in the same frame as the prices it is compared with,
  // so it widens the range when it falls outside it. That is the honest picture:
  // a position 40% under water IS a chart whose line sits near the top.
  const closes = bars.map(bar => bar.close)
  const rawMin = Math.min(...closes, ...cost === null ? [] : [cost])
  const rawMax = Math.max(...closes, ...cost === null ? [] : [cost])
  const span = rawMax - rawMin
  const pad = span === 0 ? Math.max(1, rawMax * 0.02) : span * 0.06
  const min = rawMin - pad
  const max = rawMax + pad

  const xOf = (index: number): number => PAD.left + (plotWidth * index) / (bars.length - 1)
  const yOf = (value: number): number => PAD.top + priceHeight * (1 - (value - min) / (max - min))
  const maxVolume = Math.max(...bars.map(bar => bar.volume), 1)
  const barWidth = Math.max(0.6, (plotWidth / bars.length) * 0.62)

  const line = bars
    .map((bar, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(bar.close).toFixed(1)}`)
    .join(' ')
  const area = `${line} L${xOf(bars.length - 1).toFixed(1)},${String(PRICE_BOTTOM)} L${xOf(0).toFixed(1)},${String(PRICE_BOTTOM)} Z`
  const rising = (bars.at(-1)?.close ?? 0) >= (bars[0]?.close ?? 0)
  const stroke = rising ? 'var(--dsp-up)' : 'var(--dsp-down)'

  // Trade dates are matched against the drawn window: a trade older than the
  // series has no x to sit at, and inventing one would be a lie about the range.
  const indexByDate = new Map(bars.map((bar, index) => [bar.date, index]))
  const markers = trades.flatMap((trade) => {
    const index = indexByDate.get(trade.tradedAt)
    if (index === undefined) return []
    const y = Math.min(PRICE_BOTTOM, Math.max(PAD.top, yOf(trade.price)))
    const x = xOf(index)
    const points = trade.side === 'buy'
      ? `${x.toFixed(1)},${(y - 5).toFixed(1)} ${(x - 3.6).toFixed(1)},${(y + 2.4).toFixed(1)} ${(x + 3.6).toFixed(1)},${(y + 2.4).toFixed(1)}`
      : `${x.toFixed(1)},${(y + 5).toFixed(1)} ${(x - 3.6).toFixed(1)},${(y - 2.4).toFixed(1)} ${(x + 3.6).toFixed(1)},${(y - 2.4).toFixed(1)}`
    return [{
      key: `${String(trade.id)}`,
      points,
      // Chinese convention, the same one the trade log uses: red buys, green sells.
      fill: trade.side === 'buy' ? 'var(--dsp-up)' : 'var(--dsp-down)',
      title: `${trade.tradedAt} ${trade.side === 'buy' ? '买入' : '卖出'} ${String(trade.quantity)} @ ${money(trade.price, currency)}`,
    }]
  })

  // `noUncheckedIndexedAccess` makes the read optional even inside the guard.
  const active = hover === null ? undefined : bars[hover]
  const activeX = active === undefined ? 0 : xOf(hover ?? 0)
  const activePrevious = hover === null || hover === 0 ? undefined : bars[hover - 1]
  const activeRising = active === undefined || activePrevious === undefined
    ? true
    : active.close >= activePrevious.close

  return (
    <div>
      <svg
        className="dsp-chart dsp-chart-compact"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="价格与成交量走势"
        onMouseLeave={() => { setHover(null) }}
      >
        <line className="dsp-chart-grid" x1={PAD.left} x2={PAD.left + plotWidth} y1={PRICE_BOTTOM} y2={PRICE_BOTTOM} />
        {[max, (max + min) / 2, min].map(value => (
          <g key={value}>
            <line className="dsp-chart-grid" x1={PAD.left} x2={PAD.left + plotWidth} y1={yOf(value)} y2={yOf(value)} />
            <text className="dsp-chart-axis" x={PAD.left + plotWidth + 6} y={yOf(value) + 3.5}>{compact(value)}</text>
          </g>
        ))}

        <path className="dsp-chart-area" d={area} fill={stroke} />
        {cost !== null && Number.isFinite(cost) && (
          <line
            className="dsp-chart-cost"
            x1={PAD.left}
            x2={PAD.left + plotWidth}
            y1={yOf(cost)}
            y2={yOf(cost)}
          />
        )}
        <path className="dsp-chart-line" d={line} stroke={stroke} />

        {bars.map((bar, index) => (
          <rect
            key={bar.date}
            className="dsp-chart-vol"
            data-dir={index === 0 || bar.close >= (bars[index - 1]?.close ?? bar.close) ? 'up' : 'down'}
            x={xOf(index) - barWidth / 2}
            y={VOLUME_TOP + volumeHeight * (1 - bar.volume / maxVolume)}
            width={barWidth}
            height={Math.max(0.5, volumeHeight * (bar.volume / maxVolume))}
          />
        ))}

        {markers.map(marker => (
          <polygon key={marker.key} points={marker.points} fill={marker.fill}>
            <title>{marker.title}</title>
          </polygon>
        ))}

        {bars.map((bar, index) => (
          <rect
            key={`hit-${bar.date}`}
            x={xOf(index) - plotWidth / (bars.length * 2)}
            y={PAD.top}
            width={plotWidth / bars.length}
            height={HEIGHT - PAD.top - PAD.bottom}
            fill="transparent"
            onMouseEnter={() => { setHover(index) }}
          />
        ))}

        {active !== undefined && (
          <line
            className="dsp-chart-grid"
            x1={activeX}
            x2={activeX}
            y1={PAD.top}
            y2={HEIGHT - PAD.bottom}
            stroke="var(--dsw-alias-label-tertiary)"
          />
        )}
        <text className="dsp-chart-axis" x={PAD.left} y={HEIGHT - 6}>{bars[0]?.date}</text>
        <text className="dsp-chart-axis" x={PAD.left + plotWidth} y={HEIGHT - 6} textAnchor="end">
          {bars.at(-1)?.date}
        </text>
      </svg>

      <div className="dsp-legend">
        <span>
          <span className="dsp-legend-swatch" style={{ background: stroke }} />
          收盘价
        </span>
        {cost !== null && Number.isFinite(cost) && (
          <span>
            <span className="dsp-legend-swatch dsp-legend-dashed" />
            {`成本 ${money(cost, currency)}`}
          </span>
        )}
        <span>
          <span className="dsp-legend-bar" data-dir={activeRising ? 'up' : 'down'} />
          成交量
        </span>
        {active !== undefined && (
          <span>
            {`${active.date} · 收 ${money(active.close, currency)} · 高 ${money(active.high, currency)} · 低 ${money(active.low, currency)} · 量 ${compact(active.volume)}`}
          </span>
        )}
      </div>
    </div>
  )
}
