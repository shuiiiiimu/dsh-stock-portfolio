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
import type { Currency, EquityPoint, PortfolioState, Trade, TradeInput } from '../types.ts'

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
}

/** How long a toast stays up before it clears itself. */
const TOAST_MS = 4000

/** The dashboard's observable state machine. */
export class PortfolioStore {
  private snapshot: PortfolioSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private poll: ReturnType<typeof setInterval> | undefined

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
    if (this.snapshot.state === null) void this.load()
    else void this.load({ quiet: true })
    // Every open asks the host for the latest rates. The host owns the freshness
    // guard, so a burst of opens costs one request, and a failed refresh leaves
    // the previous numbers in place with the reason recorded in the settings tab.
    void this.refreshRates(false)
    this.startPolling()
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
   * @param force - bypass the server's cache.
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

/** Create the store the plugin registers on both slots' hook faces. */
export function createPortfolioStore(): PortfolioStore {
  return new PortfolioStore()
}

export type { ApiError }
