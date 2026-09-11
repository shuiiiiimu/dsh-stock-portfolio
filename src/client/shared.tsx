/**
 * Small presentational pieces shared by every dashboard section.
 *
 * They exist so the four tabs read as one surface: same card, same banner, same
 * empty state, same bar list.
 */
import { IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { money, percent, tone } from './format.ts'
import type { BreakdownRow, Currency } from '../types.ts'

/** A single headline number. */
export function StatCard({ label, value, sub, toneClass, hint }: {
  label: string
  value: string
  sub?: string | undefined
  toneClass?: string | undefined
  hint?: string | undefined
}) {
  return (
    <div className="dsp-card" title={hint}>
      <div className="dsp-card-label">{label}</div>
      <div className={`dsp-card-value ${toneClass ?? ''}`}>{value}</div>
      {sub !== undefined && <div className="dsp-card-sub">{sub}</div>}
    </div>
  )
}

/** A P&L stat card: the amount in large type, the ratio beneath it. */
export function PnlCard({ label, amount, ratio, currency, hint }: {
  label: string
  amount: number | null
  ratio: number | null
  currency: Currency
  hint?: string | undefined
}) {
  return (
    <StatCard
      label={label}
      value={money(amount, currency, { signed: true })}
      sub={ratio === null ? undefined : percent(ratio, { signed: true })}
      toneClass={tone(amount)}
      hint={hint}
    />
  )
}

/** A section heading with an optional note. */
export function SectionTitle({ children, note }: { children: React.ReactNode, note?: string | undefined }) {
  return (
    <h3 className="dsp-section-title">
      {children}
      {note !== undefined && <span className="dsp-section-note">{note}</span>}
    </h3>
  )
}

/** An inline message strip. */
export function Banner({ tone: toneName = 'info', children }: {
  tone?: 'info' | 'warn' | 'error'
  children: React.ReactNode
}) {
  return (
    <div className="dsp-banner" data-tone={toneName}>
      {toneName !== 'info' && <IconWarningOutline16 size={14} />}
      <div>{children}</div>
    </div>
  )
}

/** A centred placeholder for a section with nothing to show. */
export function Empty({ title, children }: { title: string, children?: React.ReactNode }) {
  return (
    <div className="dsp-empty">
      <strong>{title}</strong>
      {children}
    </div>
  )
}

/** One row of a horizontal breakdown bar list. */
export function BreakdownBars({ rows, currency, emptyLabel }: {
  rows: readonly BreakdownRow[]
  currency: Currency
  emptyLabel: string
}) {
  if (rows.length === 0) return <div className="dsp-empty">{emptyLabel}</div>
  return (
    <div className="dsp-bars">
      {rows.map(row => (
        <div className="dsp-bar-row" key={row.key}>
          <span className="dsp-bar-name" title={row.label}>{row.label}</span>
          <span className="dsp-bar-track">
            <span
              className="dsp-bar-fill"
              data-dir={row.totalPnl >= 0 ? 'up' : 'down'}
              style={{ width: `${String(Math.max(2, Math.round(row.share * 100)))}%` }}
            />
          </span>
          <span className={`dsp-bar-value ${tone(row.totalPnl)}`}>
            {money(row.totalPnl, currency, { signed: true })}
            <span className="dsp-bar-name">{` · ${String(row.trades)} 笔`}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** A definition list used by the settings and analysis panels. */
export function KeyValue({ rows }: { rows: readonly { label: string, value: React.ReactNode }[] }) {
  return (
    <dl className="dsp-kv">
      {rows.map(row => (
        <div key={row.label} style={{ display: 'contents' }}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
