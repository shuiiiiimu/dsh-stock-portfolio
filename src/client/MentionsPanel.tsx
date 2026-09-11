/**
 * The 「持仓提及」 pane in the conversation's right Sidebar.
 *
 * It is the counterweight to the answer: when a turn names a holding — its code,
 * its canonical symbol, or its instrument name — this pane is revealed and shows
 * that stock's chart, its measured windows, and the position it refers to, so the
 * reader never has to go and look the numbers up afterwards.
 *
 * ## How it attaches
 *
 * A Right-Sidebar tab type registers in two stages owned by
 * `@deepseek-ai/dsh-client-ui-sidebar-right`:
 *
 *   1. the type itself into `ctx.sidebarRightTabs` ({@link mentionsDefinition}),
 *   2. its body into the keyed `sidebar.right.pane.tab` seat under the same id.
 *
 * Both stages run from inside the slot injection rather than from `apply`
 * directly. That is deliberate: the registry this pane registers INTO belongs to
 * another package, and the injection callback is the one moment guaranteed to be
 * after that package has applied, no matter which order the boot graph picked.
 *
 * The content is the same detail block the holdings rows expand into — the chart,
 * the windows, the volatility — with the position's own statistics lifted above
 * it, because "what is this doing" and "what am I holding" are two questions and
 * the pane has to answer both without a click.
 */
import { useEffect, useRef } from 'react'
import { IconMentionOutline16 } from './icons.tsx'
import { SymbolDetail } from './SymbolDetail.tsx'
import type { DetailSubject } from './SymbolDetail.tsx'
import { useSymbolBars } from './useBars.ts'
import { holdingPeriod, money, percent, quantity, tone } from './format.ts'
import { mentionedSymbols } from './store.ts'
import { exchangeLabel } from '../symbols.ts'
import type { PortfolioStore } from './store.ts'
import type { UsePortfolio } from './Dashboard.tsx'
import type { PortfolioState, Position, Trade } from '../types.ts'

/** The Right-Sidebar tab kind this pane owns: what `openTab` names. */
export const MENTIONS_KIND = 'stock-portfolio-mentions'

/**
 * This tab type's identity in the tab system, and the key its body registers
 * under. A package name is the natural value (see the Right Sidebar's own docs).
 */
export const MENTIONS_ID = 'dsh-stock-portfolio'

/** The one shape this pane needs from the tab-type registry. */
export interface SidebarRightTabsFace {
  register(definition: MentionTabDefinition): () => void
}

/** One entry box the Guide page offers for this type. */
export interface MentionGuideEntry {
  readonly order: number
  readonly title: () => string
  readonly description?: () => string
  readonly icon?: React.ComponentType<{ size?: number, className?: string }>
}

/** The tab type as the registry takes it: static, and nothing per-tab. */
export interface MentionTabDefinition {
  readonly id: string
  readonly kind: string
  /** The chip text, captured into the layout record when the tab opens. */
  readonly title: (address: string) => string
  /**
   * The Guide page's entry box.
   *
   * A page type has no address to be discovered through — nothing links to it —
   * so without this the pane would only ever appear when a mention opened it,
   * and a user who turned 自动展开 off could never reach it.
   */
  readonly guide?: readonly MentionGuideEntry[]
}

/** The one shape this pane needs from the navigation face. */
export interface SidebarRightFace {
  openTab(kind: string): void
}

/**
 * The tab type: a page opened by kind, so it declares no resource patterns.
 * @returns the definition to register.
 */
export function mentionsDefinition(): MentionTabDefinition {
  return {
    id: MENTIONS_ID,
    kind: MENTIONS_KIND,
    title: () => '持仓提及',
    guide: [{
      order: 40,
      title: () => '持仓提及',
      description: () => '对话里提到持仓标的时，在这里列出它们的走势与持仓统计',
      icon: IconMentionOutline16,
    }],
  }
}

/** The smallest box the pane can be and still be readable. */
const READABLE_WIDTH = 200
const READABLE_HEIGHT = 160

/**
 * Whether an element actually paints: a box a person can read, not hidden by an
 * ancestor, and the thing that would receive a click at its own centre.
 *
 * The size floor is load-bearing. A collapsed right column still MOUNTS the pane
 * and clips it: the element keeps its own padding, so it measures a few dozen
 * pixels wide inside the viewport and every weaker test — "has a box", "is not
 * display:none", "hit-tests as itself" — calls that visible. The pane then never
 * reveals itself, and the user sees an empty column with nothing in the console.
 * @param node - the pane's root element.
 * @returns true when the element occupies readable space on screen.
 */
function paintsSomething(node: HTMLElement): boolean {
  try {
    return measuresVisible(node)
  } catch {
    // A measurement that cannot be taken is not a reason to suppress a reveal:
    // the cost of being wrong is one idempotent focus.
    return false
  }
}

/**
 * The measurement itself.
 * @param node - the pane's root element.
 * @returns true when the element occupies space on screen.
 */
function measuresVisible(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect()
  if (rect.width < READABLE_WIDTH || rect.height < READABLE_HEIGHT) return false
  const check = (node as { checkVisibility?: () => boolean }).checkVisibility
  if (typeof check === 'function' && !check.call(node)) return false
  // A mounted pane inside a column the frame never drew has a box of its own and
  // is still invisible: it is clipped away or parked outside the viewport. The
  // element that would receive a click at the box's centre answers both.
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
  const hit = document.elementFromPoint(x, y)
  return hit === null || node.contains(hit) || hit === node
}

/**
 * Resolve what the detail panel needs to know about one mentioned symbol.
 *
 * A mention can outlive the position it was about: the conversation may be
 * talking about a stock that has since been sold. The card still renders — from
 * the closed episode, or from the trade log alone — rather than vanishing.
 * @param state - the loaded portfolio.
 * @param symbol - the canonical symbol.
 * @returns the subject, or `null` when the symbol has no position and no trade.
 */
function subjectFor(state: PortfolioState, symbol: string): DetailSubject | null {
  const open: Position | undefined = state.positions.find(row => row.symbol === symbol)
  if (open !== undefined) return open

  const trades: readonly Trade[] = state.trades.filter(trade => trade.symbol === symbol)
  const closed = state.closed.find(episode => episode.symbol === symbol)
  if (closed !== undefined) {
    const held = Math.max(0, Math.round((Date.parse(`${closed.closedAt}T00:00:00Z`) -
      Date.parse(`${closed.openedAt}T00:00:00Z`)) / 86_400_000))
    return {
      symbol,
      currency: closed.currency,
      avgCost: null,
      realizedPnl: closed.realizedPnl,
      holdingDays: Number.isFinite(held) ? held : null,
      firstTradeAt: closed.openedAt,
      lastTradeAt: closed.closedAt,
      tradeCount: closed.tradeCount,
    }
  }

  const first = trades[0]
  if (first === undefined) return null
  const dates = trades.map(trade => trade.tradedAt).sort()
  return {
    symbol,
    currency: first.currency,
    avgCost: null,
    realizedPnl: null,
    holdingDays: null,
    firstTradeAt: dates[0] ?? null,
    lastTradeAt: dates.at(-1) ?? null,
    tradeCount: trades.length,
  }
}

/** One compact statistic in a card's holding strip. */
function Stat({ label, value, sub, toneClass }: {
  label: string
  value: string
  sub?: string | undefined
  toneClass?: string | undefined
}) {
  return (
    <div className="dsp-mention-stat">
      <span className="dsp-mention-stat-label">{label}</span>
      <span className={`dsp-mention-stat-value ${toneClass ?? ''}`}>{value}</span>
      {sub !== undefined && <span className="dsp-mention-stat-sub">{sub}</span>}
    </div>
  )
}

/**
 * The holding statistics for one mentioned symbol.
 * @param props - the open position and the portfolio it sits in.
 * @returns the strip element.
 */
function HoldingStats({ position, world }: {
  position: Position
  world: PortfolioState
}) {
  const currency = position.currency

  return (
    <div className="dsp-mention-holdings">
      <div className="dsp-mention-stats">
        <Stat label="持仓" value={quantity(position.quantity)} />
        <Stat label="成本价" value={money(position.avgCost, currency)} />
        <Stat label="收盘价" value={money(position.price, currency)} sub={position.priceDate ?? '无行情'} />
        <Stat
          label="当日盈亏"
          value={position.dayPnl === null ? '—' : money(position.dayPnl, currency, { signed: true })}
          sub={percent(position.dayPnlPct, { signed: true })}
          toneClass={tone(position.dayPnl)}
        />
        <Stat label="市值" value={money(position.marketValue, currency)} />
        <Stat
          label="浮动盈亏"
          value={position.unrealizedPnl === null ? '—' : money(position.unrealizedPnl, currency, { signed: true })}
          sub={percent(position.unrealizedPct, { signed: true })}
          toneClass={tone(position.unrealizedPnl)}
        />
        <Stat label="仓位占比" value={percent(position.weight)} />
        <Stat
          label="已实现盈亏"
          value={money(position.realizedPnl, currency, { signed: true })}
          toneClass={tone(position.realizedPnl)}
        />
        <Stat
          label="持有天数"
          value={holdingPeriod(position.holdingDays)}
          sub={`${String(position.tradeCount)} 笔 · 首笔 ${position.firstTradeAt}`}
        />
        <Stat
          label="组合内浮动"
          value={`${String(world.stats.unrealizedWinners)} 盈 / ${String(world.stats.unrealizedLosers)} 亏`}
          sub={`合计 ${money(world.stats.totalUnrealizedPnl, world.settings.baseCurrency, { signed: true })}`}
          toneClass={tone(world.stats.totalUnrealizedPnl)}
        />
      </div>
    </div>
  )
}

/**
 * Render the Right-Sidebar pane.
 * @param props - the store, the renderer's selector hook, and the session the
 * tab was opened for.
 * @returns the pane element.
 */
export function MentionsPanel({ store, usePortfolio, sessionId }: {
  store: PortfolioStore
  usePortfolio: UsePortfolio
  sessionId?: string | undefined
}) {
  const state = usePortfolio(snapshot => snapshot.state)
  const batches = usePortfolio(snapshot => snapshot.mentions)
  const watched = usePortfolio(snapshot => snapshot.mentionSession)

  // The pane can be revealed before the dashboard was ever opened, and the
  // session's snapshot is what carries prices and positions. One load, then the
  // store's own polling keeps it current.
  useEffect(() => {
    if (state === null) void store.load()
  }, [state, store])

  // Report being VISIBLE, which is what tells a later reveal whether it has
  // anything left to do. Mounted is not the same thing — a pane inside a
  // collapsed column stays mounted and paints nothing — so this measures the
  // element, and re-measures when its box changes.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const node = root.current
    if (node === null) return
    const update = (): void => { store.paneVisible = paintsSomething(node) }
    update()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    observer?.observe(node)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      store.paneVisible = false
    }
  }, [store])

  // The header's own seat normally follows the session; this is the same call
  // from the cell that knows it is showing THIS conversation, so the pane is
  // right even in a composition without that seat.
  useEffect(() => {
    if (typeof sessionId === 'string' && sessionId !== '') store.watchSession(sessionId)
  }, [store, sessionId])

  // Every hook runs before every return. The series loader sits here, NOT after
  // the guards below: a pane whose tab was restored mounts before its session is
  // watched, and calling one more hook on the following render is not a missing
  // chart — React throws and takes the whole pane down with it.
  const symbols = mentionedSymbols(batches)
  const details = useSymbolBars(symbols, state?.feed.latestDate ?? '')

  // A pane that has not been told which session it belongs to yet must not show
  // the previous conversation's symbols as if they were this one's.
  if (batches.length === 0 && watched === null) {
    return <div className="dsp-mention-panel" ref={root}><div className="dsp-empty">正在读取会话…</div></div>
  }

  if (state === null) {
    return <div className="dsp-mention-panel" ref={root}><div className="dsp-empty">正在读取持仓数据…</div></div>
  }

  if (symbols.length === 0) {
    return (
      <div className="dsp-mention-panel" ref={root}>
        <div className="dsp-empty">
          <strong>还没有提到持仓标的</strong>
          对话里出现已记录标的的代码（600519 / 00700 / AAPL）、完整代码（600519.SH）或名称（贵州茅台）时，
          这个面板会自动展开，并把对应标的的走势与持仓统计列在这里。
          <br />
          在「股票持仓 → 设置」里可以关掉自动展开；关掉后提及仍然会收集到这里。
        </div>
      </div>
    )
  }

  return (
    <div className="dsp-mention-panel" ref={root}>
      <div className="dsp-mention-bar">
        <span className="dsp-section-note">{`${String(batches.length)} 条消息 · ${String(symbols.length)} 个标的`}</span>
      </div>

      {symbols.map((symbol) => {
        const subject = subjectFor(state, symbol)
        const position = state.positions.find(row => row.symbol === symbol)
        const detail = details[symbol]
        // The headline is the position's own result, not its price: the chart
        // already shows where the price has been, and what the reader wants off
        // the top of the card is whether they are up or down on it.
        const held = `持有 ${holdingPeriod(position?.holdingDays ?? null)}`
        const pnlLine = position === undefined || position.unrealizedPct === null
          ? held
          : `${percent(position.unrealizedPct, { signed: true })} · ${held}`

        return (
          <section className="dsp-mention-card" key={symbol}>
            <header className="dsp-mention-head">
              <div className="dsp-symbol">
                <span className="dsp-symbol-code">{symbol}</span>
                <span className="dsp-symbol-name">
                  {position?.name ?? state.closed.find(row => row.symbol === symbol)?.name
                    ?? state.trades.find(trade => trade.symbol === symbol)?.name ?? '—'}
                </span>
              </div>
              <span className="dsp-market">{exchangeLabel(symbol.slice(symbol.lastIndexOf('.') + 1))}</span>
              <span className="dsp-head-spacer" />
              {position !== undefined && (
                <div className={`dsp-cell-stack dsp-num-strong ${tone(position.unrealizedPnl)}`}>
                  <span>{money(position.unrealizedPnl, position.currency, { signed: true })}</span>
                  <span className="dsp-cell-sub">{pnlLine}</span>
                </div>
              )}
            </header>

            {/* The point of the pane, and the same block the holdings row expands
                into: the chart first, then the numbers that describe it. The
                position's own statistics follow it — a narrow column cannot show
                both at once, and the price history is what the conversation was
                about. */}
            {subject === null || detail === undefined
              ? <div className="dsp-detail dsp-detail-message">{`正在读取 ${symbol} 的日线…`}</div>
              : (
                  <SymbolDetail
                    subject={subject}
                    detail={detail}
                    trades={state.trades.filter(trade => trade.symbol === symbol)}
                  />
                )}

            {position !== undefined
              ? <HoldingStats position={position} world={state} />
              : (
                  <div className="dsp-mention-why">
                    {state.closed.some(row => row.symbol === symbol)
                      ? '这个标的已经清仓，上面是它的走势与历次交易'
                      : '这个标的只有交易记录，没有未平仓的持仓'}
                  </div>
                )}
          </section>
        )
      })}
    </div>
  )
}
