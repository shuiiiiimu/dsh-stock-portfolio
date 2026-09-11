/**
 * The plugin's JSON API, mounted as one `prefix` route on the DSH Web server.
 *
 * ## Why a raw route and not Typert Remote
 *
 * DSH's Remote plane is generated from typed descriptors; an out-of-tree package
 * would have to hand-maintain two synchronized descriptor sets for a handful of
 * calls. A named `webServer` route plus `fetch()` from the browser half is the
 * same transport the shipped `host-open-in-app` pair uses, needs no codegen, and
 * keeps the client half dependency-free.
 *
 * The one thing a raw route does NOT inherit is the browser-session trust fence,
 * so {@link createRouter} takes the rejection callback the caller resolves from
 * the Connection service and answers `401`/`403` itself before touching any
 * business logic.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PortfolioError } from './types.ts'
import type { Currency, TradeInput } from './types.ts'
import type { PortfolioService } from './service.ts'

/** The route prefix every endpoint lives under. */
export const API_PREFIX = '/dsh-stock-portfolio/api'

/** Largest accepted request body. Every payload here is a single small object. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Answer an untrusted or unauthenticated request.
 *
 * Supplied by the host plugin: it reads the Connection service when the
 * composition mounts one, and returns `undefined` (serve the request) when it
 * does not, so the plugin still works in a headless composition.
 */
export type RejectionCheck = (req: IncomingMessage, res: ServerResponse) => boolean

/**
 * Send one JSON response.
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param body - the JSON-serializable body.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Portfolio data is personal and changes constantly.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Read and parse a JSON request body under a size cap.
 * @param req - the incoming request.
 * @returns the parsed body, or `undefined` for an empty body.
 * @throws {PortfolioError} when the body is too large or is not valid JSON.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new PortfolioError('请求体过大', 413)
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PortfolioError('请求体不是合法的 JSON')
  }
}

/**
 * Assert that a parsed body is a JSON object.
 * @param body - the parsed body.
 * @returns the body as a record.
 * @throws {PortfolioError} when the body is not an object.
 */
function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new PortfolioError('请求体必须是 JSON 对象')
  }
  return body as Record<string, unknown>
}

/**
 * Read a required string field from a request body.
 * @param body - the parsed body.
 * @param key - the field name.
 * @returns the value.
 * @throws {PortfolioError} when the field is absent or not a string.
 */
function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PortfolioError(`字段「${key}」不能为空`)
  }
  return value
}

/**
 * Read an optional number field from a request body.
 * @param body - the parsed body.
 * @param key - the field name.
 * @param fallback - the value used when the field is absent.
 * @returns the number.
 * @throws {PortfolioError} when the field is present but not a finite number.
 */
function numberField(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PortfolioError(`字段「${key}」必须是数字`)
  }
  return value
}

/**
 * Read an optional string field, mapping an absent value to `null`.
 * @param body - the parsed body.
 * @param key - the field name.
 * @returns the string, or `null`.
 */
function optionalString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Project a request body onto the trade input shape.
 * @param body - the parsed body.
 * @returns the trade fields the service validates.
 */
function tradeInput(body: Record<string, unknown>): TradeInput {
  const side = body['side']
  if (side !== 'buy' && side !== 'sell') throw new PortfolioError('交易方向只能是 buy 或 sell')
  return {
    symbol: stringField(body, 'symbol'),
    side,
    quantity: numberField(body, 'quantity', Number.NaN),
    price: numberField(body, 'price', Number.NaN),
    tradedAt: stringField(body, 'tradedAt'),
    motive: optionalString(body, 'motive'),
    note: optionalString(body, 'note'),
  }
}

/**
 * Build the request handler for {@link API_PREFIX}.
 * @param service - the portfolio service.
 * @param rejected - the trust-fence check; returns true when it already answered.
 * @returns the `node:http` handler.
 */
export function createRouter(
  service: PortfolioService,
  rejected: RejectionCheck,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (rejected(req, res)) return
    try {
      await route(service, req, res)
    } catch (error) {
      if (error instanceof PortfolioError) {
        sendJson(res, error.status, { error: error.message })
        return
      }
      // Anything else is a bug or a provider fault; log it with a stack and hand
      // the browser a message it can show without leaking internals.
      const message = error instanceof Error ? error.message : String(error)
      console.error('[stock-portfolio] request failed:', error)
      sendJson(res, 500, { error: `内部错误：${message}` })
    }
  }
}

/**
 * Dispatch one request to its endpoint.
 * @param service - the portfolio service.
 * @param req - the incoming request.
 * @param res - the response to write.
 */
async function route(service: PortfolioService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET'
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.slice(API_PREFIX.length) || '/'
  const segments = path.split('/').filter(segment => segment !== '')

  if (method === 'GET' && segments[0] === 'state' && segments.length === 1) {
    sendJson(res, 200, service.state())
    return
  }

  if (method === 'GET' && segments[0] === 'holdings' && segments.length === 1) {
    sendJson(res, 200, { holdings: service.db.listHoldings() })
    return
  }

  if (method === 'GET' && segments[0] === 'equity' && segments.length === 1) {
    const days = Number(url.searchParams.get('days') ?? '180')
    sendJson(res, 200, {
      points: await service.equityCurve(Number.isFinite(days) && days > 0 ? Math.min(days, 1825) : 180),
    })
    return
  }

  // The expanded holdings row: the stored bars for one symbol plus the
  // indicators measured from them, in a single local read.
  if (method === 'GET' && segments[0] === 'bars' && segments.length === 1) {
    const symbol = url.searchParams.get('symbol') ?? ''
    if (symbol.trim() === '') throw new PortfolioError('缺少 symbol 参数')
    const limit = Number(url.searchParams.get('limit') ?? '160')
    sendJson(res, 200, service.symbolBars(symbol, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1250) : 160))
    return
  }

  if (method === 'GET' && segments[0] === 'lookup' && segments.length === 1) {
    sendJson(res, 200, { matches: await service.lookup(url.searchParams.get('q') ?? '') })
    return
  }

  // The conversation feed for ONE session: which of its turns named a portfolio
  // symbol. Polled by the browser half, which reveals the mention pane when the
  // revision moves. The session is a parameter because the pane follows the
  // conversation on screen, and a history that was never scanned has to be
  // scanned on demand — which is what reading the projection does.
  if (method === 'GET' && segments[0] === 'mentions' && segments.length === 1) {
    const session = url.searchParams.get('session') ?? ''
    if (session.trim() === '') throw new PortfolioError('缺少 session 参数')
    sendJson(res, 200, service.sessionMentions(session))
    return
  }

  if (method === 'POST' && segments[0] === 'refresh' && segments.length === 1) {
    const body = await readJson(req)
    const force = body !== undefined && asObject(body)['force'] === true
    try {
      await service.refresh(force)
    } catch (error) {
      // A provider outage is reported through `feed.lastError`, which the panel
      // renders as a banner; the snapshot is still worth returning.
      if (!(error instanceof Error)) throw error
    }
    sendJson(res, 200, service.state())
    return
  }

  if (method === 'POST' && segments[0] === 'instruments' && segments[1] === 'sync' && segments.length === 2) {
    await service.syncInstruments(true)
    sendJson(res, 200, service.state())
    return
  }

  if (method === 'POST' && segments[0] === 'rates' && segments[1] === 'refresh' && segments.length === 2) {
    const body = await readJson(req)
    const force = body !== undefined && asObject(body)['force'] === true
    // A refused refresh is a normal answer, not an HTTP failure: the panel keeps
    // the rates it has and shows the reason, while `state` stays truthful.
    const result = await service.refreshRates({ force })
    sendJson(res, 200, { result, state: service.state() })
    return
  }

  if (method === 'POST' && segments[0] === 'trades' && segments.length === 1) {
    const trade = await service.addTrade(tradeInput(asObject(await readJson(req))))
    sendJson(res, 201, { trade, state: service.state() })
    return
  }

  if (segments[0] === 'trades' && segments.length === 2) {
    const id = Number(segments[1])
    if (!Number.isInteger(id) || id <= 0) throw new PortfolioError('交易记录 id 不合法')
    if (method === 'PUT') {
      const trade = service.updateTrade(id, tradeInput(asObject(await readJson(req))))
      sendJson(res, 200, { trade, state: service.state() })
      return
    }
    if (method === 'DELETE') {
      service.deleteTrade(id)
      sendJson(res, 200, { state: service.state() })
      return
    }
  }

  if (method === 'PUT' && segments[0] === 'settings' && segments.length === 1) {
    const body = asObject(await readJson(req))
    const baseCurrency = body['baseCurrency']
    if (baseCurrency !== undefined && baseCurrency !== 'CNY' && baseCurrency !== 'HKD' && baseCurrency !== 'USD') {
      throw new PortfolioError('基准货币只能是 CNY、HKD 或 USD')
    }
    const settings = service.updateSettings({
      ...body['apiKey'] === undefined
        ? {}
        : { apiKey: body['apiKey'] === null ? null : String(body['apiKey']) },
      ...baseCurrency === undefined ? {} : { baseCurrency: baseCurrency as Currency },
      ...body['usdHkd'] === undefined ? {} : { usdHkd: numberField(body, 'usdHkd', 0) },
      ...body['usdCny'] === undefined ? {} : { usdCny: numberField(body, 'usdCny', 0) },
      ...body['refreshIntervalMinutes'] === undefined
        ? {}
        : { refreshIntervalMinutes: numberField(body, 'refreshIntervalMinutes', 0) },
      ...body['autoRefresh'] === undefined ? {} : { autoRefresh: body['autoRefresh'] === true },
      ...body['mentionPopup'] === undefined ? {} : { mentionPopup: body['mentionPopup'] === true },
    })
    // A settings change alters every derived number, so answer with fresh state.
    sendJson(res, 200, { settings, state: service.state() })
    return
  }

  throw new PortfolioError(`未知接口：${method} ${path}`, 404)
}
