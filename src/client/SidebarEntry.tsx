/**
 * The sidebar entry: a footer-action row that sits above the Settings seat,
 * showing the plugin's mark, its label, and the portfolio's day move at a
 * glance. On the collapsed rail it becomes a 36px square, matching the
 * neighbouring foot controls.
 *
 * ## The footer strip's layout
 *
 * `sidebar.footer.action` is declared a `list`, and the sidebar renders it as a
 * flex ROW (`packages/client/ui-sidebar/src/client/SidebarRoot.module.css`,
 * `.footerActions { display: flex }`). The existing occupant claims
 * `width: 100%`, so a second full-width row would not stack — it would overflow
 * beside it, pushing one of the two off the column.
 *
 * The shipped JSX comment already states the intent ("Footer actions stack above
 * Settings in both sidebar widths"), so this component completes it: while
 * mounted, it puts its own parent into column flow, and restores the previous
 * value when the plugin unloads. The change is scoped to exactly one element the
 * plugin already lives inside, reverted on unmount, and never touches the
 * harness's own files.
 */
import { useLayoutEffect, useRef } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconPortfolioOutline16 } from './icons.tsx'
import { money, percent, tone } from './format.ts'
import type { PortfolioStore, PortfolioSnapshot } from './store.ts'
import type { UsePortfolio } from './Dashboard.tsx'

/**
 * Render the sidebar entry.
 * @param props - the owner's column state, the store, and the injected hook.
 * @returns the trigger row.
 */
export function SidebarEntry({ wide, store, usePortfolio }: {
  wide: boolean
  store: PortfolioStore
  usePortfolio: UsePortfolio
}) {
  const root = useRef<HTMLDivElement>(null)
  const open = usePortfolio(snapshot => snapshot.open)
  const state = usePortfolio(snapshot => snapshot.state)

  useLayoutEffect(() => {
    const parent = root.current?.parentElement
    if (parent === null || parent === undefined) return
    const previous = parent.style.flexDirection
    parent.style.flexDirection = 'column'
    return () => { parent.style.flexDirection = previous }
  }, [])

  const stats = state?.stats
  const settings = state?.settings
  const change = stats === undefined || settings === undefined
    ? null
    : stats.dayPnl

  const badge = change === null || settings === undefined
    ? null
    : `${money(change, settings.baseCurrency, { signed: true })} ${percent(stats?.dayPnlPct ?? null, { signed: true })}`

  const label = open ? '关闭股票持仓' : '股票持仓'

  return (
    <div ref={root} style={{ display: 'contents' }}>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className="dsp-nav dsp-root"
          data-wide={wide}
          data-active={open || undefined}
          aria-label={label}
          aria-expanded={open}
          onClick={() => { store.toggle() }}
        >
          <span className="dsp-nav-glyph" aria-hidden="true">
            <IconPortfolioOutline16 size={wide ? 16 : 18} />
          </span>
          {wide && (
            <>
              <span className="dsp-nav-label">股票持仓</span>
              {badge !== null && (
                <span className={`dsp-nav-badge ${tone(change)}`}>{badge}</span>
              )}
            </>
          )}
        </button>
      </Tooltip>
    </div>
  )
}

export type { PortfolioSnapshot }
