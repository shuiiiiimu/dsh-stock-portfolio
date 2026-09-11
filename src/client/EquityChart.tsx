/**
 * The equity curve: the portfolio's reconstructed value at each past trading
 * day, with the cost basis as a dashed reference line.
 *
 * Hand-drawn SVG rather than a chart library, because the client bundle's only
 * permitted externals are React and the DSH primitives — a charting dependency
 * would have to be inlined, and this needs about sixty lines.
 */
import { useState } from 'react'
import { money } from './format.ts'
import type { Currency, EquityPoint } from '../types.ts'

/** Plot geometry, in viewBox units. */
const WIDTH = 720
const HEIGHT = 208
const PAD = { top: 14, right: 58, bottom: 22, left: 8 }

/** One horizontal grid line and its value. */
interface GridLine {
  y: number
  value: number
}

/**
 * Build evenly spaced grid lines across a value range.
 * @param min - the range's low value.
 * @param max - the range's high value.
 * @param count - how many lines to draw.
 * @param project - maps a value to a y coordinate.
 * @returns the grid lines, top to bottom.
 */
function gridLines(min: number, max: number, count: number, project: (value: number) => number): GridLine[] {
  const lines: GridLine[] = []
  for (let index = 0; index <= count; index += 1) {
    const value = min + ((max - min) * index) / count
    lines.push({ y: project(value), value })
  }
  return lines
}

/**
 * Render the equity curve.
 * @param props - the points, the reporting currency, and a hover readout setter.
 * @returns the chart element.
 */
export function EquityChart({ points, currency }: {
  points: readonly EquityPoint[]
  currency: Currency
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length < 2) return null

  const values = points.flatMap(point => [point.marketValue, point.cost])
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  // A flat series would collapse to a zero-height range and divide by zero.
  const span = rawMax - rawMin
  const pad = span === 0 ? Math.max(1, rawMax * 0.02) : span * 0.08
  const min = rawMin - pad
  const max = rawMax + pad

  const plotWidth = WIDTH - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const xOf = (index: number): number =>
    PAD.left + (points.length === 1 ? plotWidth / 2 : (plotWidth * index) / (points.length - 1))
  const yOf = (value: number): number => PAD.top + plotHeight * (1 - (value - min) / (max - min))

  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(point.marketValue).toFixed(1)}`).join(' ')
  const costLine = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${xOf(index).toFixed(1)},${yOf(point.cost).toFixed(1)}`).join(' ')
  const area = `${line} L${xOf(points.length - 1).toFixed(1)},${String(PAD.top + plotHeight)} L${xOf(0).toFixed(1)},${String(PAD.top + plotHeight)} Z`
  const rising = (points.at(-1)?.marketValue ?? 0) >= (points[0]?.marketValue ?? 0)
  const stroke = rising ? 'var(--dsp-up)' : 'var(--dsp-down)'
  // `noUncheckedIndexedAccess` makes the index read optional even though the
  // bounds were just checked, so the readout goes through an explicit guard.
  const active = hover === null ? undefined : points[hover]
  const activeX = active === undefined ? 0 : xOf(hover ?? 0)

  return (
    <div>
      <svg
        className="dsp-chart"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="持仓市值走势"
        onMouseLeave={() => { setHover(null) }}
      >
        {gridLines(min, max, 4, yOf).map(line_ => (
          <g key={line_.value}>
            <line className="dsp-chart-grid" x1={PAD.left} x2={PAD.left + plotWidth} y1={line_.y} y2={line_.y} />
            <text className="dsp-chart-axis" x={PAD.left + plotWidth + 6} y={line_.y + 3.5}>
              {compact(line_.value)}
            </text>
          </g>
        ))}
        <path className="dsp-chart-area" d={area} fill={stroke} />
        <path className="dsp-chart-cost" d={costLine} />
        <path className="dsp-chart-line" d={line} stroke={stroke} />
        {points.map((point, index) => (
          <rect
            key={point.date}
            x={xOf(index) - plotWidth / (points.length * 2)}
            y={PAD.top}
            width={plotWidth / points.length}
            height={plotHeight}
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
            y2={PAD.top + plotHeight}
            stroke="var(--dsw-alias-label-tertiary)"
          />
        )}
        <text className="dsp-chart-axis" x={PAD.left} y={HEIGHT - 6}>{points[0]?.date}</text>
        <text className="dsp-chart-axis" x={PAD.left + plotWidth} y={HEIGHT - 6} textAnchor="end">
          {points.at(-1)?.date}
        </text>
      </svg>
      <div className="dsp-legend">
        <span>
          <span className="dsp-legend-swatch" style={{ background: stroke }} />
          持仓市值
        </span>
        <span>
          <span className="dsp-legend-swatch" style={{ background: 'var(--dsw-alias-label-tertiary)' }} />
          持仓成本
        </span>
        {active !== undefined && (
          <span>
            {`${active.date} · 市值 ${money(active.marketValue, currency)} · 成本 ${money(active.cost, currency)}`}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Abbreviate a large money amount for an axis label.
 * @param value - the amount.
 * @returns e.g. `1.2万` or `3.4万`.
 */
function compact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return value.toFixed(0)
}
