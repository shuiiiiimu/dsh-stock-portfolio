/**
 * Analysis: what the trade log is actually for.
 *
 * The motive table is the point of the whole plugin — it answers "which reason
 * for trading made money" by holding realized P&L against the selling trade's
 * motive and unrealized P&L against the buying motives still funding the
 * position. Beside it sit the closed-position history and the ratio set a
 * trader expects (win rate, payoff ratio, profit factor).
 */
import { BreakdownBars, Empty, SectionTitle, StatCard, KeyValue } from '../shared.tsx'
import { money, percent, quantity, tone } from '../format.ts'
import type { PortfolioState } from '../../types.ts'

/**
 * Render the analysis section.
 * @param props - the loaded portfolio state.
 * @returns the section element.
 */
export function Analysis({ state }: { state: PortfolioState }) {
  const { stats, settings, closed, positions } = state
  const currency = settings.baseCurrency

  if (state.trades.length === 0) {
    return <Empty title="暂无可分析的数据">添加交易记录后，这里会按动机与市场维度汇总盈亏。</Empty>
  }

  const payoff = stats.avgWin === null || stats.avgLoss === null || stats.avgLoss === 0
    ? null
    : Math.abs(stats.avgWin / stats.avgLoss)

  return (
    <div>
      <div className="dsp-cards">
        <StatCard
          label="已实现盈亏"
          value={money(stats.totalRealizedPnl, currency, { signed: true })}
          sub={`${String(stats.closedPositions)} 次清仓累计`}
          toneClass={tone(stats.totalRealizedPnl)}
        />
        <StatCard
          label="清仓次数"
          value={String(stats.closedPositions)}
          sub={stats.openPositions === 0 ? '当前无持仓' : `另有 ${String(stats.openPositions)} 个持仓`}
        />
        <StatCard
          label="胜率"
          value={stats.winRate === null ? '—' : percent(stats.winRate)}
          sub="按清仓回合统计"
        />
        <StatCard
          label="平均盈利"
          value={money(stats.avgWin, currency)}
          sub={stats.avgLoss === null ? undefined : `平均亏损 ${money(stats.avgLoss, currency)}`}
          toneClass="dsp-up"
        />
        <StatCard
          label="盈亏比"
          value={stats.profitFactor === null ? '—' : stats.profitFactor.toFixed(2)}
          sub={payoff === null ? '总盈利 / 总亏损' : `平均盈亏比 ${payoff.toFixed(2)}`}
        />
      </div>

      <div className="dsp-section">
        <SectionTitle note="买入动机承担浮动盈亏，卖出动机承担已实现盈亏">按交易动机</SectionTitle>
        {stats.byMotive.length === 0
          ? <Empty title="还没有标注动机">在添加交易时填写「交易动机」，这里就会按动机汇总盈亏。</Empty>
          : (
              <>
                <BreakdownBars rows={stats.byMotive} currency={currency} emptyLabel="暂无数据" />
                <div className="dsp-table-wrap" style={{ marginTop: 12 }}>
                  <table className="dsp-table">
                    <thead>
                      <tr>
                        <th data-align="left">动机</th>
                        <th>交易笔数</th>
                        <th>已实现盈亏</th>
                        <th>浮动盈亏</th>
                        <th>合计</th>
                        <th>市值</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byMotive.map(row => (
                        <tr key={row.key}>
                          <td data-align="left">
                            <span className="dsp-motive" title={row.label}>{row.label}</span>
                          </td>
                          <td>{row.trades}</td>
                          <td className={tone(row.realizedPnl)}>
                            {money(row.realizedPnl, currency, { signed: true })}
                          </td>
                          <td className={tone(row.unrealizedPnl)}>
                            {money(row.unrealizedPnl, currency, { signed: true })}
                          </td>
                          <td className={`dsp-num-strong ${tone(row.totalPnl)}`}>
                            {money(row.totalPnl, currency, { signed: true })}
                          </td>
                          <td>{money(row.marketValue, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="dsp-field-hint" style={{ marginTop: 10 }}>
                  浮动盈亏按各买入动机仍占用的成本比例分摊；同一笔持仓若由多个动机买入，会按成本占比拆分。
                </p>
              </>
            )}
      </div>

      <div className="dsp-section">
        <SectionTitle note="基准货币折算后">按市场</SectionTitle>
        <BreakdownBars rows={stats.byMarket} currency={currency} emptyLabel="暂无数据" />
      </div>

      <div className="dsp-section">
        <SectionTitle note="含已实现盈亏与浮动盈亏">标的表现排行</SectionTitle>
        <div className="dsp-table-wrap">
          <table className="dsp-table">
            <thead>
              <tr>
                <th data-align="left">标的</th>
                <th>交易笔数</th>
                <th>已实现盈亏</th>
                <th>浮动盈亏</th>
              </tr>
            </thead>
            <tbody>
              {[...positions]
                .sort((left, right) => (right.unrealizedPnl ?? 0) + right.realizedPnl
                  - ((left.unrealizedPnl ?? 0) + left.realizedPnl))
                .map(row => (
                  <tr key={row.symbol}>
                    <td data-align="left">
                      <div className="dsp-symbol">
                        <span className="dsp-symbol-code">{row.symbol}</span>
                        {row.name !== null && <span className="dsp-symbol-name">{row.name}</span>}
                      </div>
                    </td>
                    <td>{row.tradeCount}</td>
                    <td className={tone(row.realizedPnl)}>{money(row.realizedPnl, row.currency, { signed: true })}</td>
                    <td className={tone(row.unrealizedPnl)}>
                      {money(row.unrealizedPnl, row.currency, { signed: true })}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {closed.length > 0 && (
        <div className="dsp-section">
          <SectionTitle note="已完全卖出的持仓回合">清仓历史</SectionTitle>
          <div className="dsp-table-wrap">
            <table className="dsp-table">
              <thead>
                <tr>
                  <th data-align="left">标的</th>
                  <th data-align="left">建仓</th>
                  <th data-align="left">清仓</th>
                  <th>持有天数</th>
                  <th>卖出成本</th>
                  <th>实现盈亏</th>
                </tr>
              </thead>
              <tbody>
                {[...closed].reverse().map(row => (
                  <tr key={`${row.symbol}-${row.closedAt}`}>
                    <td data-align="left">
                      <div className="dsp-symbol">
                        <span className="dsp-symbol-code">{row.symbol}</span>
                        {row.name !== null && <span className="dsp-symbol-name">{row.name}</span>}
                      </div>
                    </td>
                    <td data-align="left">{row.openedAt}</td>
                    <td data-align="left">{row.closedAt}</td>
                    <td>{heldDays(row.openedAt, row.closedAt)}</td>
                    <td>{money(row.costSold, row.currency)}</td>
                    <td className={`dsp-num-strong ${tone(row.realizedPnl)}`}>
                      {money(row.realizedPnl, row.currency, { signed: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="dsp-section">
        <SectionTitle>汇总口径</SectionTitle>
        <div className="dsp-table-wrap" style={{ padding: 16 }}>
          <KeyValue rows={[
            { label: '成本口径', value: '摊薄成本（加权平均，不含手续费）' },
            { label: '已实现盈亏', value: '卖出金额 − 卖出部分成本' },
            { label: '浮动盈亏', value: '持仓数量 × 最新价 − 持仓成本' },
            {
              label: '收益率',
              value: percent(stats.totalPnlPct, { signed: true }) + ' （总盈亏 ÷ 累计投入成本）',
            },
            {
              label: '汇率',
              value: `1 USD = ${String(settings.rates.HKD)} HKD = ${String(settings.rates.CNY)} CNY（可在设置中调整）`,
            },
            { label: '价格口径', value: '最新交易日收盘价（日线，不做盘中更新）' },
            { label: '总持股数', value: quantity(positions.reduce((sum, row) => sum + row.quantity, 0)) },
          ]} />
        </div>
      </div>
    </div>
  )
}

/**
 * Whole days between two `YYYY-MM-DD` dates.
 * @param from - the earlier date.
 * @param to - the later date.
 * @returns the day count, or an em dash when unparseable.
 */
function heldDays(from: string, to: string): string {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end)) return '—'
  return String(Math.max(0, Math.round((end - start) / 86_400_000)))
}
