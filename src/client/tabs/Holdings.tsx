/**
 * Holdings: one row per open position, with the columns a broker statement
 * carries plus the two this plugin adds — the share of the portfolio, and the
 * P&L already booked on that symbol by partial sells.
 *
 * The table is client-sorted: the whole position set is already in memory, so a
 * sort is a re-render rather than a round trip.
 */
import { useState } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Empty, SectionTitle } from '../shared.tsx'
import { money, percent, quantity, relative, tone } from '../format.ts'
import { exchangeLabel } from '../../symbols.ts'
import type { PortfolioState, Position } from '../../types.ts'

/** The columns a user can sort by. Every one of them is visible in the table. */
type SortKey = 'unrealizedPnl' | 'dayPnl' | 'weight' | 'quantity' | 'symbol'

/** Sort direction. */
type Direction = 'asc' | 'desc'

/** Columns whose first click should sort descending (biggest first). */
const NUMERIC: ReadonlySet<SortKey> = new Set(['unrealizedPnl', 'dayPnl', 'weight', 'quantity'])

/**
 * Read a sortable value off a position, treating "no quote yet" as the lowest
 * possible value so unpriced rows sink in either direction.
 * @param row - the position.
 * @param key - the sort column.
 * @returns the comparable value.
 */
function valueOf(row: Position, key: SortKey): number | string {
  switch (key) {
    case 'symbol': return row.symbol
    case 'unrealizedPnl': return row.unrealizedPnl ?? Number.NEGATIVE_INFINITY
    case 'dayPnl': return row.dayPnl ?? Number.NEGATIVE_INFINITY
    case 'weight': return row.weight
    case 'quantity': return row.quantity
  }
}

/**
 * Render the holdings section.
 * @param props - the loaded portfolio state and the refresh action.
 * @returns the section element.
 */
export function Holdings({ state, onRefresh, busy }: {
  state: PortfolioState
  onRefresh: (force: boolean) => void
  busy: string | null
}) {
  const [sort, setSort] = useState<SortKey>('weight')
  const [direction, setDirection] = useState<Direction>('desc')
  const currency = state.settings.baseCurrency

  if (state.positions.length === 0) {
    return <Empty title="暂无持仓">添加买入记录后，这里会按标的列出数量、成本、收盘价与盈亏。</Empty>
  }

  const rows = [...state.positions].sort((left, right) => {
    const a = valueOf(left, sort)
    const b = valueOf(right, sort)
    const order = typeof a === 'string' || typeof b === 'string'
      ? String(a).localeCompare(String(b))
      : a - b
    return direction === 'asc' ? order : -order
  })

  /**
   * Sort by a column, flipping direction when it is already active.
   * @param key - the column clicked.
   */
  const toggle = (key: SortKey): void => {
    if (key === sort) {
      setDirection(current => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSort(key)
    setDirection(NUMERIC.has(key) ? 'desc' : 'asc')
  }

  /**
   * Build the sortable header cell attributes for one column.
   * @param key - the column.
   * @returns the attributes to spread onto the `<th>`.
   */
  const head = (key: SortKey) => ({
    'data-sortable': 'true',
    'aria-sort': (sort === key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none') as
      'ascending' | 'descending' | 'none',
    onClick: () => { toggle(key) },
  })

  const staleCount = state.positions.filter(row => row.priceDate !== null
    && state.quotes.find(quote => quote.symbol === row.symbol)?.stale === true).length

  return (
    <div>
      <SectionTitle
        note={state.feed.lastRefreshAt === null
          ? `共 ${String(state.positions.length)} 个持仓`
          : `共 ${String(state.positions.length)} 个持仓 · 行情更新于 ${relative(state.feed.lastRefreshAt)}`}
      >
        持仓明细
        <button
          type="button"
          className="dsp-btn"
          data-compact="true"
          onClick={() => { onRefresh(true) }}
          disabled={busy !== null}
        >
          <IconRefreshOutline16 size={13} />
          刷新行情
        </button>
      </SectionTitle>

      {staleCount > 0 && (
        <div className="dsp-banner" data-tone="warn">
          {`有 ${String(staleCount)} 个持仓的行情已过期，点击「刷新行情」更新。`}
        </div>
      )}

      <div className="dsp-table-wrap">
        <table className="dsp-table">
          <thead>
            <tr>
              <th data-align="left" {...head('symbol')}>标的</th>
              <th data-align="left">市场</th>
              <th {...head('quantity')}>持仓</th>
              <th>成本价</th>
              <th>收盘价</th>
              <th>当日</th>
              <th {...head('unrealizedPnl')}>浮动盈亏</th>
              <th>已实现</th>
              <th {...head('weight')}>占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.symbol}>
                <td data-align="left">
                  <div className="dsp-symbol">
                    <span className="dsp-symbol-code">{row.symbol}</span>
                    {row.name !== null && <span className="dsp-symbol-name">{row.name}</span>}
                  </div>
                </td>
                <td data-align="left">
                  <span className="dsp-market">{exchangeLabel(row.exchange)}</span>
                </td>
                <td>{quantity(row.quantity)}</td>
                <td>{money(row.avgCost, row.currency)}</td>
                <td>
                  {row.price === null
                    ? <span className="dsp-flat">无行情</span>
                    : (
                        <div className="dsp-cell-stack">
                          <span>{money(row.price, row.currency)}</span>
                          {row.priceDate !== null && <span className="dsp-cell-sub">{row.priceDate}</span>}
                        </div>
                      )}
                </td>
                <td className={tone(row.dayPnl)}>
                  {row.dayPnl === null
                    ? <span className="dsp-flat">—</span>
                    : (
                        <div className="dsp-cell-stack">
                          <span>{money(row.dayPnl, row.currency, { signed: true })}</span>
                          <span className="dsp-cell-sub">{percent(row.dayPnlPct, { signed: true })}</span>
                        </div>
                      )}
                </td>
                <td className={`dsp-num-strong ${tone(row.unrealizedPnl)}`}>
                  {row.unrealizedPnl === null
                    ? <span className="dsp-flat">—</span>
                    : (
                        <div className="dsp-cell-stack">
                          <span>{money(row.unrealizedPnl, row.currency, { signed: true })}</span>
                          <span className="dsp-cell-sub">{percent(row.unrealizedPct, { signed: true })}</span>
                        </div>
                      )}
                </td>
                <td className={tone(row.realizedPnl)}>{money(row.realizedPnl, row.currency, { signed: true })}</td>
                <td>{percent(row.weight)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td data-align="left" className="dsp-num-strong">合计</td>
              <td data-align="left" />
              <td />
              <td />
              <td />
              <td className={tone(state.stats.dayPnl)}>
                <div className="dsp-cell-stack">
                  <span>{money(state.stats.dayPnl, currency, { signed: true })}</span>
                  <span className="dsp-cell-sub">{percent(state.stats.dayPnlPct, { signed: true })}</span>
                </div>
              </td>
              <td className={`dsp-num-strong ${tone(state.stats.totalUnrealizedPnl)}`}>
                <div className="dsp-cell-stack">
                  <span>{money(state.stats.totalUnrealizedPnl, currency, { signed: true })}</span>
                  <span className="dsp-cell-sub">{percent(state.stats.totalUnrealizedPct, { signed: true })}</span>
                </div>
              </td>
              <td className={tone(state.stats.totalRealizedPnl)}>
                {money(state.stats.totalRealizedPnl, currency, { signed: true })}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="dsp-field-hint" style={{ marginTop: 10 }}>
        合计按基准货币 {currency} 折算（1 USD = {state.settings.rates.HKD} HKD = {state.settings.rates.CNY} CNY）。
        收盘价为最新一个交易日的收盘价；成本价为摊薄成本（加权平均，不含手续费）；已实现盈亏是该标的历次卖出累计锁定的盈亏。
      </p>
    </div>
  )
}
