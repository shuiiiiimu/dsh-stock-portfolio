/**
 * The conversation-header seat that follows the session on screen.
 *
 * It renders NOTHING — it is a hook, not a control — and exists for one reason:
 * a slot is the only place a client plugin is handed the current session, and
 * the mention pane has to be told which conversation to follow even when its own
 * tab is not open. That is exactly the case this exists for: opening an old
 * conversation whose 「持仓提及」 tab has never been opened in that session.
 *
 * The opener is the conversation header's utility row, which every session
 * renders; the registration is additive and invisible, so the row is unchanged.
 */
import { useEffect } from 'react'
import type { PortfolioStore } from './store.ts'

/**
 * Follow the session this cell belongs to.
 * @param props - the shared store and the session the seat was registered for.
 * @returns nothing, always.
 */
export function SessionWatcher({ store, sessionId }: {
  store: PortfolioStore
  sessionId: string
}): null {
  useEffect(() => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    store.watchSession(sessionId)
  }, [store, sessionId])
  return null
}
