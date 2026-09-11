/**
 * dsh-stock-portfolio — host half.
 *
 * Owns the SQLite store, the market-data client, and the JSON API the browser half
 * calls. The browser half ships from this same package (`dsh.client` +
 * `exports["./client"]`) and is discovered by the dsh-client-modules scan, so
 * this single Loader row brings up both faces.
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
import { PortfolioService } from './service.ts'
import type { RejectionCheck } from './http.ts'
import type { WebCapability } from './fx.ts'
import type { Context } from '@deepseek-ai/cordis'

/** Cordis function-plugin name. */
export const name = 'stock-portfolio'

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
 * @param ctx - the plugin context.
 * @returns the check the router calls before any business logic.
 */
function trustFence(ctx: Context): RejectionCheck {
  const connection = ctx.get('connection') as
    | { requestRejection?: (request: unknown) => number | undefined }
    | undefined
  if (connection?.requestRejection === undefined) return () => false
  const check = connection.requestRejection.bind(connection)
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const rejection = check(req)
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
    // The last time this scheduler actually asked for a refresh, so the
    // configured interval is honored across ticks without re-registering.
    let lastAttempt = Date.now()
    const timer = setInterval(() => {
      if (!service.db.readSettings().autoRefresh) return
      if (Date.now() - lastAttempt < service.refreshIntervalMs()) return
      lastAttempt = Date.now()
      void service.refresh(true).catch((error: unknown) => {
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
