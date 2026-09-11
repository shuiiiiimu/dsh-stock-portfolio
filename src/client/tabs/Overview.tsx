/**
 * Overview: the headline numbers, the equity curve, and the two breakdowns a
 * portfolio owner looks at first — how the money is split across markets, and
 * which positions are carrying the result.
 */
import { EquityChart } from '../EquityChart.tsx'
import { Banner, BreakdownBars, Empty, PnlCard, SectionTitle, StatCard } from '../shared.tsx'
import { money, percent, quantity, tone } from '../format.ts'
import type { EquityPoint, PortfolioState } from '../../types.ts'

/** How many positions the contribution table shows before it is a full table. */
const MOVER_LIMIT = 6

/**
 * Render the overview section.
 * @param props - the loaded portfolio state plus the lazily loaded equity curve.
 * @returns the section element.
 */
export function Overview({ state, equity, equityStatus }: {
  state: PortfolioState
  equity: readonly EquityPoint[]
  equityStatus: 'idle' | 'loading' | 'ready' | 'error'
}) {
  const { stats, settings, positions, feed } = state
  const currency = settings.baseCurrency

  if (positions.length === 0) {
    return (
      <Empty title="还没有持仓">
        在「交易」里添加第一笔买入，持仓、盈亏与统计会自动算出来。
      </Empty>
    )
  }

  const movers = [...positions]
    .filter(row => row.unrealizedPnl !== null)
    .sort((left, right) => Math.abs(right.unrealizedPnl ?? 0) - Math.abs(left.unrealizedPnl ?? 0))
    .slice(0, MOVER_LIMIT)

  return (
    <div>
      {feed.lastError !== null && <Banner tone="error">{`最近一次行情刷新失败：${feed.lastError}`}</Banner>}
      {feed.unresolved.length > 0 && (
        <Banner tone="warn">{`以下代码没有取到行情：${feed.unresolved.join('、')}`}</Banner>
      )}

      <div className="dsp-cards">
        <StatCard
          label="持仓市值"
          value={money(stats.totalMarketValue, currency)}
          sub={`${String(stats.openPositions)} 个持仓 · 成本 ${money(stats.totalCost, currency)}`}
        />
        <PnlCard
          label="总盈亏"
          amount={stats.totalPnl}
          ratio={stats.totalPnlPct}
          currency={currency}
          hint="浮动盈亏 + 已实现盈亏，收益率按累计投入成本计算"
        />
        <PnlCard
          label="浮动盈亏"
          amount={stats.totalUnrealizedPnl}
          ratio={stats.totalUnrealizedPct}
          currency={currency}
        />
        <PnlCard label="当日盈亏" amount={stats.dayPnl} ratio={stats.dayPnlPct} currency={currency} />
        <PnlCard
          label="已实现盈亏"
          amount={stats.totalRealizedPnl}
          ratio={null}
          currency={currency}
          hint="卖出部分锁定的盈亏"
        />
        <StatCard
          label="胜率"
          value={stats.winRate === null ? '—' : percent(stats.winRate)}
          sub={stats.closedPositions === 0
            ? '暂无清仓记录'
            : `${String(stats.closedPositions)} 次清仓 · 盈亏比 ${stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}`}
        />
      </div>

      <div className="dsp-section">
        <SectionTitle note={`按每日收盘价回溯持仓，共 ${String(state.trades.length)} 笔交易`}>
          市值走势
        </SectionTitle>
        {equityStatus === 'loading' && <div className="dsp-empty">正在构建历史走势…</div>}
        {equityStatus === 'error' && (
          <div className="dsp-empty">
            无法读取历史日线。
            <br />
            免费源仅提供日线数据，稍后重试即可。
          </div>
        )}
        {equityStatus === 'ready' && (
          equity.length < 2
            ? <div className="dsp-empty">历史数据不足两个交易日，暂时画不出走势。</div>
            : <EquityChart points={equity} currency={currency} />
        )}
      </div>

      <div className="dsp-section">
        <SectionTitle note={`基准货币折算后 · ${stats.byMarket.map(row => row.label).join(' / ')}`}>市场分布</SectionTitle>
        <BreakdownBars rows={stats.byMarket} currency={currency} emptyLabel="暂无数据" />
      </div>

      {stats.native.length > 1 && (
        <div className="dsp-section">
          <SectionTitle note="未折算，按各自币种列示">分币种小计</SectionTitle>
          <div className="dsp-table-wrap">
            <table className="dsp-table">
              <thead>
                <tr>
                  <th data-align="left">币种</th>
                  <th>市值</th>
                  <th>成本</th>
                  <th>浮动盈亏</th>
                  <th>已实现盈亏</th>
                </tr>
              </thead>
              <tbody>
                {stats.native.map(row => (
                  <tr key={row.currency}>
                    <td data-align="left">{row.currency}</td>
                    <td>{money(row.marketValue, row.currency)}</td>
                    <td>{money(row.cost, row.currency)}</td>
                    <td className={tone(row.unrealizedPnl)}>{money(row.unrealizedPnl, row.currency, { signed: true })}</td>
                    <td className={tone(row.realizedPnl)}>{money(row.realizedPnl, row.currency, { signed: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="dsp-section">
        <SectionTitle note={feed.latestDate === null
          ? '按浮动盈亏绝对值排序'
          : `按浮动盈亏绝对值排序 · 行情截至 ${feed.latestDate}`}
        >
          持仓贡献
        </SectionTitle>
        <div className="dsp-table-wrap">
          <table className="dsp-table">
            <thead>
              <tr>
                <th data-align="left">标的</th>
                <th>持仓</th>
                <th>成本价</th>
                <th>收盘价</th>
                <th>市值</th>
                <th>浮动盈亏</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              {movers.map(row => (
                <tr key={row.symbol}>
                  <td data-align="left">
                    <div className="dsp-symbol">
                      <span className="dsp-symbol-code">{row.symbol}</span>
                      {row.name !== null && <span className="dsp-symbol-name">{row.name}</span>}
                    </div>
                  </td>
                  <td>{quantity(row.quantity)}</td>
                  <td>{money(row.avgCost, row.currency)}</td>
                  {/* Same two-line cells as the holdings table: price over date,
                      amount over ratio. */}
                  <td>
                    {row.price === null
                      ? <span className="dsp-flat">—</span>
                      : (
                          <div className="dsp-cell-stack">
                            <span>{money(row.price, row.currency)}</span>
                            {row.priceDate !== null && <span className="dsp-cell-sub">{row.priceDate}</span>}
                          </div>
                        )}
                  </td>
                  <td>{money(row.marketValue, row.currency)}</td>
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
                  <td>{percent(row.weight)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
