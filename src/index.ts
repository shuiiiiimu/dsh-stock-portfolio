/**
 * dsh-stock-portfolio — host half.
 *
 * Owns the SQLite store, the market-data client, the JSON API the browser half
 * calls, and the model-facing Tools the chat calls. The browser half ships from
 * this same package (`dsh.client` + `exports["./client"]`) and is discovered by
 * the dsh-client-modules scan, so this single Loader row brings up all three
 * surfaces — panel, API and chat — over one store.
 *
 * Mounting:
 * ```yaml
 * - insert:
 *     - id: stock-portfolio
 *       name: 'dsh-stock-portfolio'
 * ```
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { API_PREFIX, createRouter } from './http.ts'
import { MENTION_PROJECTION_KEY, mentionFeedOf, mentionProjectionUnit } from './mentions.ts'
import type { MentionState, SessionEventLike, SessionHeaderLike } from './mentions.ts'
import { PortfolioService } from './service.ts'
import { registerPortfolioTools } from './tool.ts'
import type { RejectionCheck } from './http.ts'
import type { WebCapability } from './fx.ts'
import type { Context } from '@deepseek-ai/cordis'

/** Cordis function-plugin name. */
export const name = 'stock-portfolio'

/**
 * The two harness faces the mention projection needs, declared structurally.
 *
 * Both are read with `ctx.get` rather than injected: a deployment without a
 * projection registry still gets the dashboard, its chat Tools, and its prices —
 * only the conversation pane goes without a feed.
 */
interface SessionProjectionsFace {
  register(definition: {
    key: string
    stateSchema: { parse(value: unknown): unknown }
    init(header: SessionHeaderLike): unknown
    apply(state: MentionState, event: SessionEventLike): unknown
    stateVersion: number
  }): () => void
  stateOf(session: unknown, key: string): unknown
}

/** The live session store, as this plugin reads it. */
interface SessionsFace {
  get(id: string): unknown
}

/**
 * `webServer` is a hard requirement: without it there is no way for the dashboard
 * to reach the data. `connection` is optional — it supplies the browser-session
 * trust fence, and a headless composition simply goes without.
 */
export const inject = ['webServer']

/** The row's configuration. Every field is optional. */
export interface Config {
  /** Directory holding `portfolio.db`. Defaults to `$DSH_HOME/storages/stock-portfolio`. */
  dataDir?: string
  /** Provider endpoint override; the tier's own default is used when omitted. */
  apiBase?: string
  /** Key from configuration; the dashboard setting and the environment also work. */
  apiKey?: string
}

/**
 * How often the scheduler wakes up, in milliseconds.
 *
 * The real period is the configured refresh interval, re-read on every tick; this
 * only bounds how late a refresh can be, and keeps a freshly lowered interval
 * from waiting out the old one.
 */
const SCHEDULER_TICK_MS = 60_000

/**
 * Resolve `$DSH_HOME`, matching the harness's own default.
 * @returns the harness home directory.
 */
function dshHome(): string {
  const configured = process.env['DSH_HOME']?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Validate and default the row's configuration.
 * @param raw - the Loader-supplied config object.
 * @returns the resolved configuration.
 * @throws {TypeError} when a supplied field has the wrong type.
 */
function resolveConfig(raw: unknown): Required<Pick<Config, 'dataDir'>> & Omit<Config, 'dataDir'> {
  const config = (raw ?? {}) as Record<string, unknown>
  for (const key of ['dataDir', 'apiBase', 'apiKey'] as const) {
    const value = config[key]
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError(`stock-portfolio: config.${key} must be a string`)
    }
  }
  const dataDir = typeof config['dataDir'] === 'string' && config['dataDir'].trim() !== ''
    ? config['dataDir'].trim()
    : join(dshHome(), 'storages', 'stock-portfolio')
  return {
    dataDir,
    ...typeof config['apiBase'] === 'string' ? { apiBase: config['apiBase'] } : {},
    ...typeof config['apiKey'] === 'string' ? { apiKey: config['apiKey'] } : {},
  }
}

/**
 * Build the trust-fence check for this plugin's routes.
 *
 * A raw `webServer` route inherits no authentication, so when the deployment
 * mounts the Connection carrier we ask it for the same verdict the `/api` prefix
 * would get. Without that carrier the route is only reachable on the bound
 * interface, which is the deployment's own choice.
 *
 * The carrier is resolved per request rather than once, because "not mounted
 * yet" and "never mounted" are indistinguishable at apply time: sampling it once
 * would turn a row that happens to be applied first into an unfenced route for
 * the life of the process.
 * @param ctx - the plugin context.
 * @returns the check the router calls before any business logic.
 */
function trustFence(ctx: Context): RejectionCheck {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const connection = ctx.get('connection') as
      | { requestRejection?: (request: unknown) => number | undefined }
      | undefined
    if (connection?.requestRejection === undefined) return false
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
    return true
  }
}

/**
 * Mount the portfolio store, its HTTP API, and the background refresh scheduler.
 * @param ctx - the plugin context.
 * @param rawConfig - the row's configuration.
 */
export function apply(ctx: Context, rawConfig?: unknown): void {
  const config = resolveConfig(rawConfig)
  const service = new PortfolioService({
    dataDir: config.dataDir,
    // `config.apiKey` is the row's field name; the service names it for what it
    // is — the last fallback behind the dashboard, the environment, and `.env`.
    ...config.apiBase === undefined ? {} : { apiBase: config.apiBase },
    ...config.apiKey === undefined ? {} : { configApiKey: config.apiKey },
    // Resolved per call: a web provider may be mounted after this row, and a
    // headless composition never mounts one.
    web: () => ctx.get('web') as WebCapability | undefined,
  })
  ctx.effect(() => () => { service.close() }, 'stock-portfolio: close database')
  // Let other plugins (and dynamic Cordis packages) read the same store.
  ctx.provide('stockPortfolio', service)

  // The chat side of the same store: a model-facing Tool that records a trade
  // and asks the user for whatever the sentence left out. Registered on the
  // root context, so every session sees it, and disposed with this plugin.
  registerPortfolioTools(ctx, service)

  // The conversation feed behind the 「提及」 pane, as a session projection.
  //
  // A projection rather than a `session/event` listener, because the pane has to
  // answer for a conversation that was restored from disk, and reading a
  // restored log directly is deprecated for new code: the framework folds this
  // unit over the log itself — history included — and hands the result back
  // synchronously. It also means the state is checkpointed with every other
  // projection, so a resumed session does not re-scan from scratch.
  //
  // The registry is AWAITED, not sampled: a plugin row may be applied before the
  // package that provides `sessionProjections`, and a one-time `ctx.get` that
  // happens to be early registers nothing at all — silently, leaving every feed
  // empty forever. `ctx.inject` runs the callback when the service appears,
  // which is the same path `schedule` uses for this very service.
  ctx.inject(['sessionProjections'], (scope) => {
    const projections = scope.get('sessionProjections') as SessionProjectionsFace | undefined
    if (projections === undefined) return
    // One unit for every session: the framework gives each its own cell, folds
    // it — history included, for a session restored from disk — and checkpoints
    // it beside the other projections.
    scope.effect(
      () => projections.register(mentionProjectionUnit(() => service.mentionMatcher())),
      'stock-portfolio: mention projection',
    )
  })

  // Both faces are resolved per request for the same reason: the route can be
  // called long before this row's neighbours are up, and a captured `undefined`
  // would answer an empty feed for the lifetime of the process.
  service.useMentionSource((sessionId: string) => {
    const projections = ctx.get('sessionProjections') as SessionProjectionsFace | undefined
    const sessions = ctx.get('sessions') as SessionsFace | undefined
    const session = sessions?.get(sessionId)
    if (projections === undefined || session === undefined) return { rev: 0, batches: [] }
    const state = projections.stateOf(session, MENTION_PROJECTION_KEY)
    return mentionFeedOf(state === undefined ? undefined : (state as MentionState))
  })

  const route = {
    kind: 'prefix' as const,
    path: API_PREFIX,
    handler: createRouter(service, trustFence(ctx)),
  }
  ctx.effect(() => ctx.webServer.register(route), `stock-portfolio: ${API_PREFIX}`)

  // One warm-up refresh so a dashboard opened seconds after boot already has
  // prices. Deliberately not awaited: a market-data outage must not delay the
  // host's own startup.
  void service.refresh(false).catch((error: unknown) => {
    console.warn('[stock-portfolio] initial price refresh failed:', error)
  })

  // Build the instrument index before anyone types in the trade form. The
  // refresh above only touches symbols that already have a position, so on a
  // fresh install it would not fire this at all — and an empty index means the
  // first search returns nothing. Idempotent and weekly-guarded.
  void service.syncInstruments(false).catch((error: unknown) => {
    console.warn('[stock-portfolio] initial instrument index sync failed:', error)
  })

  ctx.effect(() => {
    // How often the scheduler LOOKS at the stored series. Whether that look
    // becomes a request is the service's decision: a series already holding the
    // newest bar the provider can have published is left alone, so this only has
    // to be frequent enough to notice the day rolling over.
    let lastLook = Date.now()
    const timer = setInterval(() => {
      if (!service.db.readSettings().autoRefresh) return
      if (Date.now() - lastLook < service.refreshIntervalMs()) return
      lastLook = Date.now()
      void service.refresh(false).catch((error: unknown) => {
        console.warn('[stock-portfolio] scheduled price refresh failed:', error)
      })
      // Weekly, and only when the scheduler is already awake.
      void service.syncInstruments(false)
    }, SCHEDULER_TICK_MS)
    // Node would otherwise hold the process open on this timer alone.
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, 'stock-portfolio: refresh scheduler')
}

export { PortfolioService } from './service.ts'
export type { PortfolioServiceOptions } from './service.ts'
export {
  ADD_TRADE_TOOL, ANALYSIS_TOOL, LIST_TRADES_TOOL, OVERVIEW_TOOL, SEARCH_TOOL, SYMBOL_DETAIL_TOOL,
  createPortfolioTools, registerPortfolioTools,
} from './tool.ts'
export type {
  PortfolioToolDeps, QuestionOption, ToolDefinition, ToolRegistry, ToolRunContext,
  UserQuestion, UserQuestionAnswer, UserQuestionsCapability,
} from './tool.ts'
export { MOTIVE_HISTORY_LIMIT, MOTIVE_PRESETS } from './motives.ts'
export {
  acquireRates, FX_ENDPOINTS, FX_SEARCH_QUERY, parseRatesFromSearch,
} from './fx.ts'
export type {
  FxAcquisition, FxFailure, FxQuote, FxRateSource, WebCapability, WebFetchOutcome, WebSearchOutcome,
} from './fx.ts'
export { API_PREFIX, createRouter } from './http.ts'
export type { RejectionCheck } from './http.ts'
export { PortfolioDatabase, databasePath, displayPath, DEFAULT_SETTINGS, STALE_AFTER_DAYS } from './db.ts'
export { TickFlowClient, TickFlowError, KEYED_BASE_URL, FREE_BASE_URL } from './tickflow.ts'
export * from './types.ts'
export * from './symbols.ts'
export {
  buildEquityCurve, convert, derivePortfolio, foldLedgers, rateTable, sortTrades,
} from './portfolio.ts'
export type { Rates } from './portfolio.ts'
export { computeSymbolStats, RETURN_WINDOWS } from './indicators.ts'
export {
  createMentionMatcher, excerptFor, foldMentionState, initMentionState, MENTION_PROJECTION_KEY, MENTION_STATE_VERSION,
  mentionFeedOf, mentionProjectionUnit, parseMentionState, projectMessage, textOfContent,
} from './mentions.ts'
export type {
  MentionMatch, MentionMessage, MentionState, MentionTarget, SessionEventLike, SessionHeaderLike, SessionLike,
} from './mentions.ts'
