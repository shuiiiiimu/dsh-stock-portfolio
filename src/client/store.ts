/**
 * The dashboard's view store: one observable snapshot shared by the sidebar
 * entry (which renders the trigger and the day's P&L badge) and the overlay
 * panel (which renders the dashboard).
 *
 * The renderer turns any entry on the registration's `hooks` face into a
 * `use<Name>(selector)` prop, so this object only has to satisfy the bare
 * `getSnapshot`/`subscribe` contract — no React import, no external store
 * library, and the snapshot identity only changes when something actually
 * changed.
 */
import { ApiError, api } from './api.ts'
import type { Currency, EquityPoint, MentionBatch, MentionFeed, PortfolioState, Trade, TradeInput } from '../types.ts'

/** The dashboard's sections, in navigation order. */
export type TabId = 'overview' | 'holdings' | 'trades' | 'analysis' | 'settings'

/** A transient message shown above the content. */
export interface Toast {
  readonly tone: 'info' | 'success' | 'error'
  readonly message: string
}

/** Everything the UI renders from. */
export interface PortfolioSnapshot {
  /** Whether the panel is open. */
  readonly open: boolean
  readonly tab: TabId
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly state: PortfolioState | null
  readonly error: string | null
  /** Label of the mutation in flight, or `null` when idle. */
  readonly busy: string | null
  readonly toast: Toast | null
  /** The equity curve, loaded lazily for the overview tab. */
  readonly equity: readonly EquityPoint[]
  readonly equityStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** The watched session's mention feed, oldest batch first. */
  readonly mentions: readonly MentionBatch[]
  /** That session's newest revision seen, or `null` before its first poll answers. */
  readonly mentionRev: number | null
  /** The session the feed above belongs to, or `null` before anything is on screen. */
  readonly mentionSession: string | null
}

/** The initial snapshot: closed, idle, nothing loaded. */
const INITIAL: PortfolioSnapshot = {
  open: false,
  tab: 'overview',
  status: 'idle',
  state: null,
  error: null,
  busy: null,
  toast: null,
  equity: [],
  equityStatus: 'idle',
  mentions: [],
  mentionRev: null,
  mentionSession: null,
}

/** How long a toast stays up before it clears itself. */
const TOAST_MS = 4000

/**
 * How often the browser asks whether the conversation mentioned something.
 *
 * A poll rather than a stream: the host answers from a projection it already
 * folded, the payload is a handful of characters per turn, and a short interval
 * means the pane appears with the answer instead of after it. Polling stops
 * while the page is hidden and while no session is being watched.
 */
const MENTION_POLL_MS = 2_000

/**
 * How soon a reveal that did not land is retried.
 *
 * The one failure this exists for is a page load racing the Right Sidebar's
 * seat: our first poll can be a few tens of milliseconds too early, and waiting
 * a whole poll interval for the pane would read as "it did not open". Bounded,
 * so a seat that never arrives costs a handful of requests rather than one every
 * 300ms forever.
 */
const MENTION_RETRY_MS = 300

/** How many fast retries before the normal poll cadence takes over. */
const MENTION_RETRY_LIMIT = 10

/**
 * How often the sidebar's own number re-reads the snapshot.
 *
 * The footer row shows the day's move all the time, whether or not the panel is
 * open, and it is the only part of this plugin that is visible without being
 * asked for. Five minutes is a local request against the host's own database
 * (the provider is only called on the host's schedule), and it is fast enough
 * that a bar published mid-session shows up while the user is still looking at
 * the sidebar.
 */
const SNAPSHOT_POLL_MS = 300_000

/** What the store can be tuned with; the shipped defaults are the real ones. */
export interface PortfolioStoreOptions {
  /** Override the mention poll interval, in milliseconds. Tests use this. */
  readonly mentionPollMs?: number
  /**
   * Called when a fresh conversation mention arrives, with the symbols it named.
   *
   * The store does not know how the Right Sidebar is opened — that is the client
   * half's business, and in a deployment without one there is nothing to open —
   * so revealing the pane is a callback rather than something the store does.
   * Returning `false` says it did not land, and the store retries on its next
   * tick: a fresh page load polls before the Right Sidebar's seat is bound, so
   * the very first attempt can arrive too early to open anything.
   */
  readonly onMention?: ((symbols: readonly string[]) => boolean | void) | undefined
}

/** The dashboard's observable state machine. */
export class PortfolioStore {
  private snapshot: PortfolioSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private poll: ReturnType<typeof setInterval> | undefined
  private mentionPoll: ReturnType<typeof setInterval> | undefined
  private snapshotPoll: ReturnType<typeof setInterval> | undefined
  /** The poll in flight, and the session it belongs to. */
  private mentionInFlight: { session: string, task: Promise<void> } | null = null
  /** Symbols whose reveal has not landed yet; retried until it does. */
  private mentionPending: readonly string[] | null = null
  private mentionRetries = 0
  private mentionRetryTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Whether the mention pane is actually ON SCREEN, reported by the pane itself.
   *
   * Deliberately not "is it mounted" and not the column's layout state: the pane
   * can stay mounted inside a collapsed column, and the layout can report itself
   * expanded with this very tab active while the frame never drew it. Both
   * readings suppress a reveal that the user is waiting for, so the pane measures
   * itself instead (see `MentionsPanel`), and anything unmeasurable counts as
   * hidden — opening a pane that is already open costs a focus, opening nothing
   * costs the feature.
   */
  paneVisible = false
  private readonly mentionPollMs: number
  private readonly onMention: ((symbols: readonly string[]) => boolean | void) | undefined

  constructor(options: PortfolioStoreOptions = {}) {
    this.mentionPollMs = options.mentionPollMs ?? MENTION_POLL_MS
    this.onMention = options.onMention
  }

  /**
   * Read the current snapshot.
   * @returns the snapshot, stable between changes.
   */
  getSnapshot = (): PortfolioSnapshot => this.snapshot

  /**
   * Subscribe to snapshot changes.
   * @param listener - called after every change.
   * @returns the unsubscriber.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release timers. Called from the plugin's disposer. */
  dispose(): void {
    clearTimeout(this.toastTimer)
    clearInterval(this.poll)
    clearInterval(this.mentionPoll)
    clearInterval(this.snapshotPoll)
    clearTimeout(this.mentionRetryTimer)
    this.mentionPoll = undefined
    this.snapshotPoll = undefined
    this.mentionRetryTimer = undefined
  }

  /**
   * Replace the snapshot and notify.
   * @param patch - the fields to change.
   */
  private set(patch: Partial<PortfolioSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /**
   * Show a transient message.
   * @param tone - the message's severity.
   * @param message - the text.
   */
  notify(tone: Toast['tone'], message: string): void {
    clearTimeout(this.toastTimer)
    this.set({ toast: { tone, message } })
    this.toastTimer = setTimeout(() => { this.set({ toast: null }) }, TOAST_MS)
  }

  /** Dismiss the current message. */
  dismissToast(): void {
    clearTimeout(this.toastTimer)
    this.set({ toast: null })
  }

  /** Open the dashboard, loading state on first use and starting the poll. */
  open(): void {
    this.set({ open: true })
    const loaded = this.snapshot.state === null ? this.load() : this.load({ quiet: true })
    // Every open asks the host for the latest rates. The host owns the freshness
    // guard, so a burst of opens costs one request, and a failed refresh leaves
    // the previous numbers in place with the reason recorded in the settings tab.
    void this.refreshRates(false)
    // Behind the first paint, and behind the snapshot: switching 自动刷新 off has
    // to silence this too, and on a first open the setting only arrives with the
    // state this is waiting for. The host fetches only what is actually missing,
    // so an open where nothing changed costs one local check and no request.
    void loaded.then(() => {
      if (this.snapshot.state?.settings.autoRefresh === true) return this.topUpPrices()
      return undefined
    })
    this.startPolling()
  }

  /**
   * Keep the snapshot the sidebar row renders from.
   *
   * Independent of the panel: the footer row shows the day's move on every page,
   * and before this existed the number only appeared once the user opened the
   * dashboard (or a mention opened the pane) — which is exactly what a reader
   * sees as "the badge is missing until I click it".
   */
  startSnapshotWatch(): void {
    if (this.snapshotPoll !== undefined) return
    void this.load({ quiet: true })
    this.snapshotPoll = setInterval(() => {
      // The panel's own poll already covers the open case, and this one is the
      // slower of the two.
      if (this.snapshot.open) return
      void this.load({ quiet: true })
    }, SNAPSHOT_POLL_MS)
  }

  // ─── conversation mentions ────────────────────────────────────────────────

  /**
   * Follow one session's conversation.
   *
   * Called by whatever is mounted for the session on screen — the mention pane
   * itself, and the invisible registrar the header carries so that OPENING a
   * session is enough, even one whose tab was never opened. Switching sessions
   * drops the previous feed rather than showing another conversation's symbols
   * under this one's name.
   * @param sessionId - the session now on screen.
   */
  watchSession(sessionId: string): void {
    if (this.snapshot.mentionSession !== sessionId) {
      // A reveal owed to the session being left is not owed to this one.
      this.mentionPending = null
      this.mentionRetries = 0
      this.set({ mentionSession: sessionId, mentions: [], mentionRev: null })
    }
    if (this.mentionPoll === undefined) {
      this.mentionPoll = setInterval(() => { void this.pollMentions() }, this.mentionPollMs)
    }
    void this.pollMentions()
  }

  /**
   * Ask the host what the conversation mentioned since the last look.
   *
   * One poll per session at a time: the interval and an explicit call (a session
   * switch, or a test) can otherwise overlap, and two answers computed from the
   * same cursor would both count as fresh — which is how a pane gets revealed
   * twice for one turn.
   * @returns the poll that answered, so callers can await it.
   */
  private pollMentions(): Promise<void> {
    const sessionId = this.snapshot.mentionSession
    if (sessionId === null) return Promise.resolve()
    if (this.mentionInFlight?.session === sessionId) return this.mentionInFlight.task
    const task = this.runMentionPoll(sessionId).finally(() => {
      if (this.mentionInFlight?.task === task) this.mentionInFlight = null
    })
    this.mentionInFlight = { session: sessionId, task }
    return task
  }

  /**
   * Fetch one session's feed and act on it.
   *
   * Best-effort: a failed poll is silent, because the next one is two seconds
   * away and there is nothing for the user to do about it.
   * @param sessionId - the session this poll was started for.
   */
  private async runMentionPoll(sessionId: string): Promise<void> {
    if (typeof document !== 'undefined' && document.hidden) return
    let feed: MentionFeed
    try {
      feed = await api.mentions(sessionId)
    } catch {
      return
    }
    // A slower answer for a session the user has already left must not overwrite
    // the one on screen.
    if (this.snapshot.mentionSession !== sessionId) return
    const previous = this.snapshot.mentionRev
    // `previous === null` is this session's FIRST answer. It counts as fresh on
    // purpose: a conversation opened from history already has its mentions — the
    // projection folded them out of the stored log — and opening it IS the user
    // asking to see them. The cost is that a page reload reveals the pane once
    // for the conversation it lands on, which the 自动展开 switch turns off.
    const fresh = previous === null ? feed.batches : feed.batches.filter(batch => batch.rev > previous)
    this.set({ mentions: feed.batches, mentionRev: feed.rev })
    const symbols = mentionedSymbols(fresh)
    // A newer turn supersedes an undelivered one: both would open the same pane.
    if (symbols.length > 0) this.mentionPending = symbols
    this.deliverMention()
  }

  /**
   * Try to reveal the pane for the mentions still owed to the user.
   *
   * Called on every tick, not only when a turn arrives: the first attempt of a
   * page load can happen before the Right Sidebar has a session surface to open
   * a tab in, and a reveal nobody retries is a pane that never appears.
   */
  private deliverMention(): void {
    const symbols = this.mentionPending
    if (symbols === null || this.onMention === undefined) {
      this.mentionPending = null
      return
    }
    // 自动弹出 off means the feed still fills the view, it just does not move the
    // Right Sidebar: the user reads the mentions pane when they choose to.
    if (this.snapshot.state?.settings.mentionPopup === false) {
      this.mentionPending = null
      return
    }
    if (this.onMention(symbols) === false) {
      this.scheduleMentionRetry()
      return
    }
    this.mentionPending = null
    this.mentionRetries = 0
  }

  /**
   * Come back for a reveal that did not land, well before the next poll.
   *
   * Gives up after {@link MENTION_RETRY_LIMIT} attempts: the interval keeps
   * trying at its own cadence, and a retry storm helps nobody.
   */
  private scheduleMentionRetry(): void {
    if (this.mentionRetries >= MENTION_RETRY_LIMIT) return
    this.mentionRetries += 1
    clearTimeout(this.mentionRetryTimer)
    this.mentionRetryTimer = setTimeout(() => { void this.pollMentions() }, MENTION_RETRY_MS)
  }

  /** Close the dashboard and stop polling. */
  close(): void {
    this.set({ open: false })
    clearInterval(this.poll)
    this.poll = undefined
  }

  /** Toggle the dashboard. */
  toggle(): void {
    if (this.snapshot.open) this.close()
    else this.open()
  }

  /**
   * Switch sections, loading whatever that section needs on first view.
   * @param tab - the section to show.
   */
  selectTab(tab: TabId): void {
    this.set({ tab })
    if (tab === 'overview' && this.snapshot.equityStatus === 'idle') void this.loadEquity()
  }

  /** Reload the portfolio snapshot. */
  async load(options: { quiet?: boolean } = {}): Promise<void> {
    if (options.quiet !== true) this.set({ status: this.snapshot.state === null ? 'loading' : 'ready' })
    try {
      const state = await api.state()
      this.set({ state, status: 'ready', error: null })
    } catch (error) {
      this.set({ status: 'error', error: messageOf(error) })
    }
  }

  /** Load or reload the equity curve. */
  async loadEquity(days = 180): Promise<void> {
    this.set({ equityStatus: 'loading' })
    try {
      const { points } = await api.equity(days)
      this.set({ equity: points, equityStatus: 'ready' })
    } catch {
      // A missing history series is a cosmetic loss; the overview renders the
      // rest of the page without it.
      this.set({ equityStatus: 'error' })
    }
  }

  /** Start the in-panel refresh poll. */
  private startPolling(): void {
    if (this.poll !== undefined) return
    // The host owns the real schedule; this only keeps an open panel honest
    // about prices that moved while the user was reading it.
    this.poll = setInterval(() => {
      if (this.snapshot.open) void this.load({ quiet: true })
    }, 60_000)
  }

  /**
   * Run a mutation with a busy label, then adopt the returned snapshot.
   * @param label - the label shown while the work runs.
   * @param work - the API call.
   * @returns the call's own result.
   * @throws rethrows the failure after recording it, so callers can keep form state.
   */
  private async mutate<T>(label: string, work: () => Promise<T & { state?: PortfolioState }>): Promise<T> {
    this.set({ busy: label })
    try {
      const result = await work()
      if (result.state !== undefined) this.set({ state: result.state, status: 'ready', error: null })
      else await this.load({ quiet: true })
      return result
    } finally {
      this.set({ busy: null })
    }
  }

  /**
   * Add a trade and report the outcome.
   * @param trade - the trade fields.
   * @returns whether the trade was accepted.
   */
  async addTrade(trade: TradeInput): Promise<boolean> {
    try {
      await this.mutate('save-trade', () => api.addTrade(trade))
      this.notify('success', '交易记录已保存')
      void this.loadEquity()
      return true
    } catch (error) {
      this.notify('error', messageOf(error))
      return false
    }
  }

  /**
   * Update a trade and report the outcome.
   * @param id - the trade id.
   * @param trade - the new fields.
   * @returns whether the change was accepted.
   */
  async updateTrade(id: number, trade: TradeInput): Promise<boolean> {
    try {
      await this.mutate('save-trade', () => api.updateTrade(id, trade))
      this.notify('success', '交易记录已更新')
      void this.loadEquity()
      return true
    } catch (error) {
      this.notify('error', messageOf(error))
      return false
    }
  }

  /**
   * Delete a trade.
   * @param trade - the trade to delete.
   * @returns whether the deletion succeeded.
   */
  async deleteTrade(trade: Trade): Promise<boolean> {
    try {
      await this.mutate('delete-trade', () => api.deleteTrade(trade.id))
      this.notify('success', `已删除 ${trade.symbol} 的交易记录`)
      void this.loadEquity()
      return true
    } catch (error) {
      this.notify('error', messageOf(error))
      return false
    }
  }

  /**
   * Refresh prices from the market-data provider.
   * @param force - re-read the full history instead of only what is missing.
   */
  async refresh(force = false): Promise<void> {
    try {
      await this.mutate('refresh', async () => ({ state: await api.refresh(force) }))
      const feed = this.snapshot.state?.feed
      if (feed === undefined) return
      if (feed.unresolved.length > 0) {
        this.notify('info', `已刷新，但 ${String(feed.unresolved.length)} 个代码没有行情：${feed.unresolved.join('、')}`)
      } else {
        this.notify('success', `行情已更新至 ${feed.latestDate ?? '最新交易日'}`)
      }
    } catch (error) {
      this.notify('error', messageOf(error))
    }
  }

  /**
   * Let the host top up whatever is actually behind, without interrupting anyone.
   *
   * Daily bars arrive the day after the close, so on most opens there is nothing
   * to collect and the host answers out of its own database; only a series whose
   * newest bar is behind the last published trading day costs a request, and then
   * only for the days it is missing. That is what makes this safe to run on every
   * open.
   *
   * Failures stay silent: the reason is already in the feed status the panel
   * renders, and a background check is not something to interrupt a user with.
   */
  async topUpPrices(): Promise<void> {
    try {
      // A label of its own, so the header button only spins for a refresh the
      // user actually asked for.
      await this.mutate('refresh-auto', async () => ({ state: await api.refresh(false) }))
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  /**
   * Save settings.
   * @param patch - the fields to change.
   * @returns the new settings, or `null` on failure.
   */
  async saveSettings(patch: {
    apiKey?: string | null
    baseCurrency?: Currency
    usdHkd?: number
    usdCny?: number
    refreshIntervalMinutes?: number
    autoRefresh?: boolean
  }): Promise<PortfolioState['settings'] | null> {
    try {
      const result = await this.mutate('save-settings', () => api.saveSettings(patch))
      this.notify('success', '设置已保存')
      return result.settings
    } catch (error) {
      this.notify('error', messageOf(error))
      return null
    }
  }

  /**
   * Rebuild the local instrument name index.
   * @returns whether the rebuild succeeded.
   */
  async syncInstruments(): Promise<boolean> {
    try {
      await this.mutate('sync-instruments', async () => ({ state: await api.syncInstruments() }))
      const count = this.snapshot.state?.settings.instrumentCount ?? 0
      this.notify('success', `代码索引已更新，共 ${String(count)} 个标的`)
      return true
    } catch (error) {
      this.notify('error', messageOf(error))
      return false
    }
  }

  /**
   * Refresh the exchange rates through the host's web capability.
   *
   * Called on every open, where silence is the right default: the panel is
   * already usable and the rates on screen are simply the last good ones. The
   * manual button reports its outcome, because a click deserves an answer.
   * @param force - fetch even when the host's freshness guard would skip.
   * @returns whether the stored rates are current.
   */
  async refreshRates(force = false): Promise<boolean> {
    if (force) this.set({ busy: 'refresh-rates' })
    try {
      const { result, state } = await api.refreshRates(force)
      this.set({ state, status: 'ready', error: null })
      if (force) {
        if (!result.ok) this.notify('error', result.error ?? '汇率刷新失败')
        else if (result.refreshed) this.notify('success', '汇率已更新')
        else this.notify('info', '汇率刚刚已经取过，未重复请求')
      }
      return result.ok
    } catch (error) {
      if (force) this.notify('error', messageOf(error))
      return false
    } finally {
      if (force) this.set({ busy: null })
    }
  }
}

/**
 * Extract a displayable message from an unknown failure.
 * @param error - the thrown value.
 * @returns the message.
 */
function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * The mentioned symbols, newest mention first and each symbol once.
 *
 * Ordering is the useful part: the panel lists what was just talked about at the
 * top, so a follow-up answer about the same stock does not push a second copy of
 * it onto the page.
 * @param batches - the batches to read, oldest first.
 * @returns canonical symbols.
 */
export function mentionedSymbols(batches: readonly MentionBatch[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const batch of [...batches].reverse()) {
    for (const symbol of batch.symbols) {
      if (seen.has(symbol)) continue
      seen.add(symbol)
      ordered.push(symbol)
    }
  }
  return ordered
}

/** Create the store the plugin registers on both slots' hook faces. */
export function createPortfolioStore(options: PortfolioStoreOptions = {}): PortfolioStore {
  return new PortfolioStore(options)
}
