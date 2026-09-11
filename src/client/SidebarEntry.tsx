/**
 * The sidebar entry: a footer-action row that sits above the Settings seat,
 * showing the plugin's mark, its label, and the portfolio's day move at a
 * glance. On the collapsed rail it becomes a 36px square, matching the
 * neighbouring foot controls.
 *
 * ## The footer strip's layout
 *
 * `sidebar.footer.action` is declared a `list`, and the sidebar renders its
 * entries in a flex ROW (`packages/client/ui-sidebar/src/client/SidebarRoot.module.css`,
 * `.footerActions { display: flex }`). Each occupant claims `width: 100%`, so two
 * of them do not stack — they overflow side by side and one is pushed out of the
 * column. (It is not hypothetical: the Cordis plugin row appearing beside this
 * one is exactly how "股票持仓" disappeared from the foot.)
 *
 * The shipped JSX comment already states the intent ("Footer actions stack above
 * Settings in both sidebar widths"), so this component completes it: while
 * mounted, it puts the STRIP into column flow and restores the previous value on
 * unmount. The strip is found by walking up to the flex row that holds the
 * entries rather than by trusting `parentElement` — the seat may wrap each entry
 * in its own element, and a `flex-direction` set on that wrapper stacks nothing.
 */
import { useLayoutEffect, useRef } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconPortfolioOutline16 } from './icons.tsx'
import { money, percent, tone } from './format.ts'
import type { PortfolioStore } from './store.ts'
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

  // Re-applied on every render, not only on mount: the strip can be replaced, or
  // have its inline style reset, while this entry stays mounted — and the failure
  // mode is silent (the row is simply not there).
  useLayoutEffect(() => {
    const strip = flexRowAncestor(root.current)
    if (strip === null) return
    const previous = strip.style.flexDirection
    strip.style.flexDirection = 'column'
    return () => { strip.style.flexDirection = previous }
  })

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

/**
 * The flex ROW that holds the footer entries.
 *
 * Walks up from this row's own element until it finds one laid out as a row: the
 * seat is free to wrap every entry in a wrapper, so the immediate parent is not
 * necessarily the strip that decides how entries flow.
 * @param element - this entry's root element, or `null` before mount.
 * @returns the element to switch to column flow, or `null` when there is none.
 */
function flexRowAncestor(element: HTMLElement | null): HTMLElement | null {
  // A handful of levels is the whole sidebar foot; the bound keeps a layout
  // surprise from turning into a walk up the entire frame.
  let node = element?.parentElement ?? null
  for (let level = 0; node !== null && level < 5; level += 1, node = node.parentElement) {
    const style = getComputedStyle(node)
    // The sidebar's own column is a flex box too — only a ROW is the strip.
    if (style.display === 'flex' && style.flexDirection === 'row') return node
  }
  return null
}
