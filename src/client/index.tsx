/**
 * dsh-stock-portfolio — browser half.
 *
 * Contributes three cells, one command, and owns one store:
 *
 *   `sidebar.footer.action` — the trigger row, rendered by the sidebar ABOVE
 *                             its Settings seat. A fresh list id and an `order`
 *                             after the existing occupant's, so the Cordis
 *                             plugin button keeps its position and neither row
 *                             displaces the other.
 *   `shell.overlay`         — the dashboard itself, in the frame-wide floating
 *                             layer. Rendered only while open.
 *   `sidebar.right.pane.tab` — the 「持仓提及」 pane in the conversation's right
 *                             Sidebar: what the current conversation mentioned,
 *                             one card per holding. Registered as a Right-Sidebar
 *                             tab type, which is a two-stage registration this
 *                             file performs inside the slot injection — see
 *                             {@link MentionsPanel}.
 *   `/portfolio-review`     — the slash-menu row for a review, contributed
 *                             client-side because only a client row carries a
 *                             localized label and an icon. See
 *                             {@link applyReviewCommand}.
 *
 * All of them read the same {@link PortfolioStore} through the registration's
 * `hooks` face, which the renderer turns into a `usePortfolio(selector)` prop.
 * The store is created here, in the plugin's own closure, and released by
 * `ctx.effect` when the plugin unloads. The conversation watcher that feeds the
 * mention pane runs for as long as the plugin is mounted, whether or not any of
 * these cells is on screen.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

import { Dashboard } from './Dashboard.tsx'
import { SessionWatcher } from './SessionWatcher.tsx'
import { SidebarEntry } from './SidebarEntry.tsx'
import { MENTIONS_ID, MENTIONS_KIND, MentionsPanel, mentionsDefinition } from './MentionsPanel.tsx'
import type { SidebarRightFace, SidebarRightTabsFace } from './MentionsPanel.tsx'
import { applyReviewCommand } from './review-command.ts'
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

/** The frame's panel actions, as this half needs them; absent in a bare frame. */
interface LayoutFace {
  openRightbar?: (track: boolean, fullscreen: boolean) => void
}

/**
 * Mount the sidebar entry, the dashboard, and their shared store.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  /**
   * Reveal the mention pane.
   *
   * Both Right-Sidebar faces are looked up per call rather than captured at
   * apply time — the package that provides them may apply after this one, and a
   * deployment whose frame has no right column simply has neither. `openTab` is
   * the navigation call that both opens the tab and expands the column, and it
   * is idempotent for a kind already open, and it throws when no session surface
   * is mounted yet — which a fresh page load can hit, because the watcher's
   * first poll and the column's seat race each other. That is reported as "not
   * delivered" rather than swallowed, so the store tries again.
   * @returns whether the pane is now on screen (or already was).
   */
  const reveal = (): boolean => {
    const rightbar = ctx.get('sidebarRight') as SidebarRightFace | undefined
    if (rightbar === undefined) {
      // The service is absent, which on a fresh load means "not up yet" far more
      // often than "this frame has no right column". The frame's own expand action
      // is tried, and the reveal stays owed so the next tick can open the tab for
      // real once the service appears.
      const layout = ctx.get('layout') as LayoutFace | undefined
      layout?.openRightbar?.(true, false)
      return false
    }
    // A pane that is painting needs nothing: it updates itself from the feed.
    // What counts as "already showing" is measured by the pane, not taken from
    // the column's layout state — see `PortfolioStore.paneVisible`.
    // A pane that is painting needs nothing: it updates itself from the feed.
    if (store.paneVisible) return true
    try {
      rightbar.openTab(MENTIONS_KIND)
      return true
    } catch (error) {
      // Reported rather than swallowed: a reveal that quietly never happens is
      // the whole bug this path exists to prevent, and the store retries on its
      // next tick.
      //
      // Deliberately NOT nudging `layout.openRightbar` here. The seat reports the
      // column's state to the frame itself (`syncPresentation`), so asking the
      // frame directly reserves a wide column that the seat — still believing it
      // is collapsed — fills with nothing. That is a blank right half of the
      // window, which is exactly what it looked like the one time it was tried.
      console.warn('[stock-portfolio] mention reveal failed, retrying:', error)
      return false
    }
  }

  const store = createPortfolioStore({ onMention: reveal })
  ctx.effect(() => () => { store.dispose() }, 'stock-portfolio: dispose store')

  // The sidebar row is the one surface that is always visible, so its number is
  // loaded at startup rather than waiting for the panel to be opened.
  store.startSnapshotWatch()

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

  // Following the conversation is not tied to anything being open — the whole
  // point is that opening a session is enough — but a slot is the only place a
  // plugin is handed the session on screen. This seat is the conversation
  // header's own utility row: a registration that renders nothing, exists for
  // every session, and tells the store which conversation to follow.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'stock-portfolio',
    order: SIDEBAR_ORDER,
    inject: () => ({ store }),
  }, SessionWatcher))

  // Stage one of the tab type: what a 「持仓提及」 tab IS. Registered against the
  // Right Sidebar's own registry the moment that service exists.
  //
  // AWAITED, not sampled. The registry belongs to another package, and a plugin
  // row may be applied before the one that provides it — or before publishing it
  // has settled. Sampling once and skipping the registration is invisible right
  // up to the moment a reveal calls `openTab`, which then throws "no tab type is
  // registered" for the rest of the session, forever, with nothing on screen.
  // `ctx.inject` is the harness's own optional-registration path for exactly
  // this (`schedule` uses it for `sessionProjections` on the host side).
  ctx.inject(['sidebarRightTabs'], (scope) => {
    const rightTabs = scope.get('sidebarRightTabs') as SidebarRightTabsFace | undefined
    if (rightTabs === undefined) return
    scope.effect(() => rightTabs.register(mentionsDefinition()), 'stock-portfolio: mention tab type')
  })

  // Stage two: the body, under the same key the definition's id names.
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: MENTIONS_ID,
    inject: face,
  }, MentionsPanel))

  // The slash-menu row. A client contribution rather than a Host command,
  // because only a contribution can carry the localized label and the icon —
  // see the module's own header for why the two cannot share one name.
  applyReviewCommand(ctx)
}

// The entry's exports are for the tests: the shell consumes `apply` and
// `inject` and nothing else. What is here is what a case reaches for — the cells
// that cannot be mounted through a slot without a click or a conversation turn,
// the tab definition they register, and the command contribution.
export { createPortfolioStore, mentionedSymbols } from './store.ts'
export { applyReviewCommand, REVIEW_COMMAND, REVIEW_PROMPT } from './review-command.ts'
export { Dashboard } from './Dashboard.tsx'
export { Holdings } from './tabs/Holdings.tsx'
export { Overview } from './tabs/Overview.tsx'
export { SymbolDetail } from './SymbolDetail.tsx'
export { MENTIONS_KIND, MentionsPanel, mentionsDefinition } from './MentionsPanel.tsx'

