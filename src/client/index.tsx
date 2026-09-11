/**
 * dsh-stock-portfolio — browser half.
 *
 * Contributes two cells and owns one store:
 *
 *   `sidebar.footer.action` — the trigger row, rendered by the sidebar ABOVE
 *                             its Settings seat. A fresh list id and an `order`
 *                             after the existing occupant's, so the Cordis
 *                             plugin button keeps its position and neither row
 *                             displaces the other.
 *   `shell.overlay`         — the dashboard itself, in the frame-wide floating
 *                             layer. Rendered only while open.
 *
 * Both cells read the same {@link PortfolioStore} through the registration's
 * `hooks` face, which the renderer turns into a `usePortfolio(selector)` prop.
 * The store is created here, in the plugin's own closure, and released by
 * `ctx.effect` when the plugin unloads.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

import { Dashboard } from './Dashboard.tsx'
import { SidebarEntry } from './SidebarEntry.tsx'
import { createPortfolioStore } from './store.ts'
import { STYLE_TAG_ID, STYLES } from './styles.ts'

/**
 * The slot registry is the only harness service this half needs. There is no
 * locale registration and no Remote client: the dashboard's copy is Chinese by
 * design, and its data arrives over plain same-origin `fetch` from the route the
 * host half registers.
 */
export const inject = ['slots']

/** Where the sidebar row sits among the footer actions. */
const SIDEBAR_ORDER = 10

/** The overlay's order; nothing else occupies the layer, so any value works. */
const OVERLAY_ORDER = 100

/**
 * Mount the sidebar entry, the dashboard, and their shared store.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const store = createPortfolioStore()
  ctx.effect(() => () => { store.dispose() }, 'stock-portfolio: dispose store')

  // A plugin bundle cannot ship a side stylesheet: the factory closure is the
  // only place allowed to touch the document, so the sheet is injected here and
  // its tag removed on unload.
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset['plugin'] = STYLE_TAG_ID
    tag.textContent = STYLES
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'stock-portfolio: styles')

  /** The registration face both cells share. */
  const face = () => ({ store, hooks: { portfolio: store } })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'stock-portfolio',
    order: SIDEBAR_ORDER,
    inject: face,
  }, SidebarEntry))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'stock-portfolio',
    order: OVERLAY_ORDER,
    inject: face,
  }, Dashboard))
}

export { PortfolioStore, createPortfolioStore } from './store.ts'
export { SidebarEntry } from './SidebarEntry.tsx'
export { Dashboard } from './Dashboard.tsx'
export { STYLES } from './styles.ts'
