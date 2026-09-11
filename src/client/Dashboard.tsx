/**
 * The dashboard panel: one large surface over the whole frame, with a section
 * rail on the left — the same shape as the harness's own Settings dialog, so it
 * reads as part of DSH rather than a page bolted on.
 *
 * It renders into `shell.overlay`, the frame-wide floating layer, and only
 * mounts its DOM while open: the overlay layer is click-through, but an occupied
 * element would still swallow the app's own pointer events if it stayed mounted.
 */
import { useEffect, useRef } from 'react'
import type React from 'react'
import {
  IconCloseOutline16, IconRefreshOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { IconAnalysisOutline16, IconHoldingsOutline16, IconLedgerOutline16, IconOverviewOutline16 } from './icons.tsx'
import { Overview } from './tabs/Overview.tsx'
import { Holdings } from './tabs/Holdings.tsx'
import { Trades } from './tabs/Trades.tsx'
import { Analysis } from './tabs/Analysis.tsx'
import { Settings } from './tabs/Settings.tsx'
import { money, percent, relative, tone } from './format.ts'
import type { PortfolioStore, PortfolioSnapshot, TabId } from './store.ts'

/** The hook shape the renderer derives from the registration's `hooks` face. */
export type UsePortfolio = <T>(selector: (snapshot: PortfolioSnapshot) => T) => T

/** One row in the section rail. */
interface TabDef {
  readonly id: TabId
  readonly label: string
  readonly Icon: React.ComponentType<{ size?: number, className?: string }>
}

/** Sections, in navigation order. */
const TABS: readonly TabDef[] = [
  { id: 'overview', label: '概览', Icon: IconOverviewOutline16 },
  { id: 'holdings', label: '持仓', Icon: IconHoldingsOutline16 },
  { id: 'trades', label: '交易记录', Icon: IconLedgerOutline16 },
  { id: 'analysis', label: '分析', Icon: IconAnalysisOutline16 },
  { id: 'settings', label: '设置', Icon: IconSettingsOutline16 },
]

/**
 * Whether some element between `target` and the dialog root can consume a wheel
 * tick along the axis that tick carries.
 *
 * The harness's own scrollports are NOT ancestors of this overlay — they are
 * siblings in the frame — so the browser should never chain a wheel that lands
 * here into them. It does anyway whenever the pointer sits over a part of the
 * dialog that cannot scroll (the mask, the section rail, a short page), which
 * reads as "scrolling the dialog moves the app behind it". This walks the hit
 * chain looking for a scroller that still has room in the tick's direction.
 * @param target - the wheel event's target, when it is an element.
 * @param root - the overlay root; the walk stops there.
 * @param deltaX - the tick's horizontal delta.
 * @param deltaY - the tick's vertical delta.
 * @returns true when the tick has somewhere to go inside the dialog.
 */
function consumesWheel(target: Element | null, root: HTMLElement, deltaX: number, deltaY: number): boolean {
  for (let node: Element | null = target; node !== null && node !== root.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (deltaY !== 0 && canScroll(style.overflowY, node.scrollHeight - node.clientHeight, node.scrollTop, deltaY)) {
      return true
    }
    if (deltaX !== 0 && canScroll(style.overflowX, node.scrollWidth - node.clientWidth, node.scrollLeft, deltaX)) {
      return true
    }
  }
  return false
}

/**
 * Whether one box is a scroller with room left in the tick's direction.
 * @param overflow - the computed overflow for that axis.
 * @param room - the scrollable distance on that axis.
 * @param offset - the current scroll offset.
 * @param delta - the tick's delta on that axis.
 * @returns true when the box would move.
 */
function canScroll(overflow: string, room: number, offset: number, delta: number): boolean {
  return (overflow === 'auto' || overflow === 'scroll')
    && room > 1
    && (delta < 0 ? offset > 0 : offset < room)
}

/**
 * Render the dashboard.
 * @param props - the store, the injected hook, and the store's actions.
 * @returns the panel, or `null` while closed.
 */
export function Dashboard({ store, usePortfolio }: {
  store: PortfolioStore
  usePortfolio: UsePortfolio
}) {
  const open = usePortfolio(snapshot => snapshot.open)
  const tab = usePortfolio(snapshot => snapshot.tab)
  const status = usePortfolio(snapshot => snapshot.status)
  const state = usePortfolio(snapshot => snapshot.state)
  const busy = usePortfolio(snapshot => snapshot.busy)
  const error = usePortfolio(snapshot => snapshot.error)
  const toast = usePortfolio(snapshot => snapshot.toast)
  const equity = usePortfolio(snapshot => snapshot.equity)
  const equityStatus = usePortfolio(snapshot => snapshot.equityStatus)
  const closeButton = useRef<HTMLButtonElement>(null)
  const overlay = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') store.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open, store])

  // The dialog owns every wheel and swipe that lands on it. React's own wheel
  // listener is passive, so this one is attached natively: without
  // `preventDefault` a tick over a region that cannot scroll would be applied to
  // the document instead, which is what moved the app behind the mask.
  useEffect(() => {
    const root = overlay.current
    if (!open || root === null) return
    const onWheel = (event: WheelEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (!consumesWheel(target, root, event.deltaX, event.deltaY)) event.preventDefault()
      event.stopPropagation()
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => { root.removeEventListener('wheel', onWheel) }
  }, [open])

  // Focus lands on Close so the dialog is keyboard-reachable immediately, and
  // Escape is never the only way out.
  useEffect(() => {
    if (open) closeButton.current?.focus()
  }, [open])

  if (!open) return null

  const settings = state?.settings
  const stats = state?.stats
  const dayTone = tone(stats?.dayPnl)
  // The header describes the data, so a missing piece is left out rather than
  // rendered as an em dash glued to a label.
  const feedLine = ((): string => {
    if (state === null) return '正在加载'
    const held = `${String(state.positions.length)} 个持仓 · ${String(state.trades.length)} 笔交易`
    const feed = state.feed
    if (feed.latestDate === null) return `${held} · 尚无行情`
    return feed.lastRefreshAt === null
      ? `${held} · 行情截至 ${feed.latestDate}`
      : `${held} · 行情截至 ${feed.latestDate}（${relative(feed.lastRefreshAt)}更新）`
  })()

  return (
    <div className="dsp-overlay dsp-root" role="presentation" ref={overlay}>
      <div className="dsp-mask" aria-hidden="true" onClick={() => { store.close() }} />
      <div className="dsp-panel" role="dialog" aria-modal="true" aria-label="股票持仓管理">
        <nav className="dsp-side">
          <div className="dsp-side-title">股票持仓</div>
          {TABS.map(({ id, label, Icon }) => (
            <button
              type="button"
              key={id}
              className="dsp-tab"
              aria-current={tab === id}
              onClick={() => { store.selectTab(id) }}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
          <div className="dsp-side-foot">
            {settings === undefined || stats === undefined
              ? '正在读取…'
              : (
                  <>
                    <div className={`dsp-num-strong ${dayTone}`}>
                      {`${money(stats.totalPnl, settings.baseCurrency, { signed: true })} ${percent(stats.totalPnlPct, { signed: true })}`}
                    </div>
                    <div>累计盈亏</div>
                  </>
                )}
          </div>
        </nav>

        <div className="dsp-body">
          <header className="dsp-head">
            <div>
              <div className="dsp-head-title">{TABS.find(item => item.id === tab)?.label ?? ''}</div>
              <div className="dsp-head-sub">
                {feedLine}
              </div>
            </div>
            <div className="dsp-head-spacer" />
            <button
              type="button"
              className="dsp-btn"
              disabled={busy !== null}
              onClick={() => { void store.refresh(true) }}
            >
              <IconRefreshOutline16 size={13} className={busy === 'refresh' ? 'dsp-spin' : undefined} />
              {busy === 'refresh' ? '刷新中' : '刷新行情'}
            </button>
            <button
              type="button"
              ref={closeButton}
              className="dsp-icon-btn"
              aria-label="关闭"
              onClick={() => { store.close() }}
            >
              <IconCloseOutline16 size={15} />
            </button>
          </header>

          <div className="dsp-content">
            {toast !== null && (
              <div className="dsp-banner" data-tone={toast.tone === 'error' ? 'error' : 'info'}>
                {toast.message}
              </div>
            )}
            {status === 'loading' && state === null && <div className="dsp-empty">正在读取持仓数据…</div>}
            {status === 'error' && state === null && (
              <div className="dsp-empty">
                <strong>无法连接插件后端</strong>
                {error ?? '未知错误'}
                <br />
                请确认 dsh-stock-portfolio 已随 profile 加载。
              </div>
            )}
            {state !== null && (
              <>
                {tab === 'overview' && (
                  <Overview state={state} equity={equity} equityStatus={equityStatus} />
                )}
                {tab === 'holdings' && (
                  <Holdings
                    state={state}
                    busy={busy}
                    onRefresh={(force) => { void store.refresh(force) }}
                  />
                )}
                {tab === 'trades' && (
                  <Trades
                    state={state}
                    busy={busy}
                    onAdd={trade => store.addTrade(trade)}
                    onUpdate={(id, trade) => store.updateTrade(id, trade)}
                    onDelete={trade => store.deleteTrade(trade)}
                  />
                )}
                {tab === 'analysis' && <Analysis state={state} />}
                {tab === 'settings' && (
                  <Settings
                    settings={state.settings}
                    feed={state.feed}
                    busy={busy}
                    onSave={patch => store.saveSettings(patch)}
                    onRefresh={force => { void store.refresh(force) }}
                    onRefreshRates={force => { void store.refreshRates(force) }}
                    onSyncInstruments={() => store.syncInstruments()}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
