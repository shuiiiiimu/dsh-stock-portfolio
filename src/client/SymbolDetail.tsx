/**
 * One expanded holdings row: the symbol's chart on the left, its measurements on
 * the right.
 *
 * The two halves answer different questions from the same series — "what has this
 * done since I have been watching it" and "how does that compare with what I
 * paid" — so the chart carries the cost line and the trade markers, and the facts
 * panel carries the windows, the volatility, and the position's own age.
 *
 * Every number here is computed on the host (`indicators.ts`) and rendered as-is;
 * the client owns formatting only, so a figure in this panel and the same figure
 * in a test cannot drift.
 */
import { SymbolChart } from './SymbolChart.tsx'
import { compact, holdingPeriod, money, number, percent, tone } from './format.ts'
import type { BarsState } from './useBars.ts'
import type { Currency, Trade } from '../types.ts'

/**
 * What the detail panel needs to know about the symbol it describes.
 *
 * Deliberately not `Position`: the panel is also opened for a stock the
 * conversation mentioned that is already closed out, and an open position
 * satisfies this shape as it stands.
 */
export interface DetailSubject {
  readonly symbol: string
  readonly currency: Currency
  /** Moving-average cost per share, or `null` when nothing is held. */
  readonly avgCost: number | null
  readonly realizedPnl: number | null
  readonly holdingDays: number | null
  readonly firstTradeAt: string | null
  readonly lastTradeAt: string | null
  readonly tradeCount: number
}

/** One label/value pair in the facts panel. */
function Fact({ label, value, toneClass, title }: {
  label: string
  value: string
  toneClass?: string | undefined
  title?: string | undefined
}) {
  return (
    <div className="dsp-fact" title={title}>
      <span className="dsp-fact-label">{label}</span>
      <span className={`dsp-fact-value ${toneClass ?? ''}`}>{value}</span>
    </div>
  )
}

/** A heading inside the facts panel. */
function FactGroup({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div className="dsp-fact-group">
      <div className="dsp-fact-head">{title}</div>
      {children}
    </div>
  )
}

/**
 * Render the expanded row's body.
 * @param props - the subject, its loaded bars and indicators, and its trades.
 * @returns the detail block.
 */
export function SymbolDetail({ subject, detail, trades }: {
  subject: DetailSubject
  detail: BarsState
  trades: readonly Trade[]
}) {
  if (detail.status === 'error') {
    return <div className="dsp-detail dsp-detail-message">{`无法读取 ${subject.symbol} 的日线：${detail.message}`}</div>
  }

  const { bars, stats } = detail.body
  const row = subject
  const cost = row.avgCost !== null && row.avgCost > 0 ? row.avgCost : null

  // A trade is marked at its own bar. Daily bars are published after the close,
  // so the trade a user just recorded has no bar yet and would otherwise just be
  // missing from the chart with no explanation.
  const drawn = new Set(bars.map(bar => bar.date))
  const unmarked = trades.filter(trade => !drawn.has(trade.tradedAt))

  return (
    <div className="dsp-detail">
      <div className="dsp-detail-chart">
        {bars.length < 2
          ? (
              <div className="dsp-detail-message">
                {`${row.symbol} 还没有可画的日线。本地只保存日线，持仓写入后会自动取最近 90 天；`}
                也可以点右上角「刷新行情」重试。
              </div>
            )
          : <SymbolChart bars={bars} currency={subject.currency} cost={cost} trades={trades} />}
        {unmarked.length > 0 && (
          <div className="dsp-detail-note">
            {`图上未标记的 ${String(unmarked.length)} 笔交易：`}
            {unmarked
              .slice(-3)
              .map(trade => `${trade.tradedAt} ${trade.side === 'buy' ? '买入' : '卖出'} ${String(trade.quantity)} @ ${money(trade.price, subject.currency)}`)
              .join('、')}
            {unmarked.length > 3 ? ' 等' : ''}
            {`（成交日不在 ${stats.firstDate ?? '—'} 至 ${stats.lastDate ?? '—'} 的日线里：日线收盘后才发布，或早于这段区间）`}
          </div>
        )}
      </div>

      <div className="dsp-facts">
        <div className="dsp-fact-col">
          <FactGroup title="区间涨跌幅">
            {stats.returns.map(item => (
              <Fact
                key={item.days}
                label={`${String(item.days)} 日`}
                value={item.pct === null
                  ? '—'
                  : `${percent(item.pct, { signed: true })}${item.change === null ? '' : ` · ${money(item.change, row.currency, { signed: true })}`}`}
                toneClass={tone(item.pct)}
              />
            ))}
          </FactGroup>

          <FactGroup title="这笔持仓">
            <Fact label="持有天数" value={holdingPeriod(row.holdingDays)} title={`首笔买入 ${row.firstTradeAt ?? '—'}`} />
            <Fact label="首笔买入" value={row.firstTradeAt ?? '—'} />
            <Fact label="最近交易" value={row.lastTradeAt ?? '—'} />
            <Fact label="交易笔数" value={`${String(row.tradeCount)} 笔`} />
            <Fact
              label="已实现盈亏"
              value={row.realizedPnl === null ? '—' : money(row.realizedPnl, row.currency, { signed: true })}
              toneClass={row.realizedPnl === null ? 'dsp-flat' : tone(row.realizedPnl)}
              title="这个标的历次卖出累计锁定的盈亏"
            />
          </FactGroup>
        </div>

        <div className="dsp-fact-col">
          <FactGroup title="波动与量能">
            <Fact
              label="20 日波动率"
              value={percent(stats.volatility20)}
              title="最近 20 个交易日收益率的标准差，按 252 个交易日年化"
            />
            <Fact
              label="量比"
              value={stats.volumeRatio === null ? '—' : `${number(stats.volumeRatio, 2)} 倍`}
              title="最新成交量 ÷ 前 20 个交易日的平均成交量"
            />
            <Fact
              label="60 日区间"
              value={stats.rangePosition60 === null ? '—' : `${number(stats.rangePosition60 * 100, 0)}%`}
              title={stats.low60 === null || stats.high60 === null
                ? '日线不足 60 个交易日'
                : `60 日最低 ${money(stats.low60, row.currency)} · 最高 ${money(stats.high60, row.currency)}，0% 为最低、100% 为最高`}
            />
            <Fact
              label="60 日最大回撤"
              value={percent(stats.maxDrawdown60)}
              toneClass={stats.maxDrawdown60 === null || stats.maxDrawdown60 === 0 ? 'dsp-flat' : 'dsp-down'}
              title="60 个交易日内，从阶段高点到之后最低点的最大跌幅"
            />
            <Fact
              label="20 日均线"
              value={stats.ma20Gap === null ? '—' : percent(stats.ma20Gap, { signed: true })}
              toneClass={tone(stats.ma20Gap)}
              title={stats.ma20 === null ? '日线不足 20 个交易日' : `20 日均价 ${money(stats.ma20, row.currency)}`}
            />
            <Fact
              label="连续"
              value={stats.streak === 0
                ? '—'
                : `${String(Math.abs(stats.streak))} 连${stats.streak > 0 ? '涨' : '跌'}`}
              toneClass={tone(stats.streak)}
            />
            {stats.high60 !== null && stats.low60 !== null && (
              <Fact
                label="60 日高低"
                value={`${compact(stats.low60)} – ${compact(stats.high60)}`}
                title={`${money(stats.low60, row.currency)} – ${money(stats.high60, row.currency)}`}
              />
            )}
          </FactGroup>
        </div>
      </div>

      <div className="dsp-detail-hint">
        图上折线是收盘价，柱是成交量，虚线是本仓成本价，三角形是你在本区间内的买卖点；
        指标全部来自本地保存的日线，不额外请求接口。
      </div>
    </div>
  )
}
