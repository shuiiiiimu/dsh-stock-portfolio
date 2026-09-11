/**
 * The model-facing Tool surface: the chat is another way into the same trade log.
 *
 * The dashboard and the chat are deliberately two views of one service.
 * `PortfolioService` owns validation, the price refresh and the holdings
 * projection, so a trade typed into the panel and a trade dictated to the model
 * land through exactly the same path and are checked by exactly the same rules.
 *
 * ## The gap this closes
 *
 * A sentence in chat is not a form. “昨天买了 200 股腾讯” carries a symbol, a
 * direction and a quantity, and no price at all. Rather than inventing a price or
 * refusing, the tool asks for what is missing through `ctx.userQuestions` — the
 * same service behind the built-in `ask_user_question` tool — so the gap arrives
 * in the conversation as an ordinary question card and the answer comes back
 * inside the same tool call.
 *
 * | Field | Offered as |
 * | --- | --- |
 * | `symbol` | local index hits (`600000.SH 浦发银行`), free text when nothing matched |
 * | `side` | 买入 / 卖出 |
 * | `quantity` | free text |
 * | `price` | the latest stored close first, free text otherwise |
 * | `traded_at` | 今天 / 昨天, free text otherwise |
 * | `motive` | the direction's quick picks plus motives already in use |
 *
 * One `ask()` carries every open question, so the user answers one card rather
 * than five, and nothing is asked twice: a field the model already read out of
 * the user's sentence never becomes a question.
 *
 * ## When the question cannot be asked
 *
 * `ctx.userQuestions.ask` refuses a caller that is not the live runtime root
 * (`DELEGATED_CALLER`) — a subagent has no human to answer it — and a
 * composition may mount no answerer at all. Both cases end in the same honest
 * result: nothing is written, and the tool returns the fields it still needs
 * together with the questions it would have asked, so the calling model can put
 * them to the user with its own `ask_user_question` tool and call back.
 *
 * ## What is not here
 *
 * No HTTP, no SQL and no portfolio arithmetic. The service is called for every
 * read and every write, including the numbers in the reply, because a second
 * implementation of the cost-basis fold is a second answer to the same question.
 */
import { MOTIVE_HISTORY_LIMIT, MOTIVE_PRESETS } from './motives.ts'
import { exchangeLabel, normalizeSymbol } from './symbols.ts'
import { PortfolioError } from './types.ts'
import type { PortfolioService } from './service.ts'
import type { Currency, Position, Quote, SymbolMatch, Trade, TradeSide } from './types.ts'
import type { Context } from '@deepseek-ai/cordis'

// ─── the harness surface this module consumes ────────────────────────────────

/** One selectable answer; mirrors `AskUserQuestionOption` from `@deepseek-ai/dsh-user-questions`. */
export interface QuestionOption {
  readonly label: string
  readonly description?: string | undefined
}

/** One question; mirrors `AskUserQuestionItem` from `@deepseek-ai/dsh-user-questions`. */
export interface UserQuestion {
  readonly id: string
  readonly question: string
  /** Supporting text rendered with the question but kept out of the option labels. */
  readonly detail?: string | undefined
  readonly header?: string | undefined
  readonly options?: readonly QuestionOption[] | undefined
  readonly multiSelect?: boolean | undefined
}

/** One answered question; mirrors `AskUserQuestionAnswerItem`. */
export interface UserQuestionAnswer {
  readonly id: string
  readonly selected: readonly string[]
  /** The free-text answer, used when the user typed instead of picking an option. */
  readonly custom?: string | undefined
}

/** The slice of `ctx.userQuestions` this module uses. */
export interface UserQuestionsCapability {
  ask(request: {
    readonly questions: readonly UserQuestion[]
    readonly agent?: { readonly id: string } | undefined
    readonly signal?: AbortSignal | undefined
  }): Promise<{ readonly answers: readonly UserQuestionAnswer[] }>
}

/** The slice of `ctx.tools` this module uses. */
export interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/** The execution context one definition receives; mirrors `ToolRunContext` from `@deepseek-ai/dsh-tools`. */
export interface ToolRunContext {
  /** The calling agent; absent for a call outside any session. */
  readonly agent?: { readonly id: string } | undefined
  readonly signal?: AbortSignal | undefined
}

/** The only content block these tools emit. */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** The call card these tools ask for; mirrors `GenericCallView`. */
export interface ToolCallView {
  readonly card: 'generic'
  readonly title: string
}

/** A registry-ready tool; mirrors `ToolDefinition` from `@deepseek-ai/dsh-tools`. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  /** The enforced JSON-Schema subset, with the object root implied by the registry. */
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): readonly TextBlock[]
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  presentCall?(args: unknown): ToolCallView | undefined
}

/** Everything a tool needs beyond the service itself. */
export interface PortfolioToolDeps {
  /**
   * The scoped answerer waterfall.
   *
   * Optional because a headless composition mounts none: the tool then reports
   * the open fields instead of asking for them.
   */
  readonly userQuestions?: UserQuestionsCapability | undefined
  /** Injectable clock, for tests and for the 今天 / 昨天 options. */
  readonly now?: (() => Date) | undefined
}

// ─── identities ──────────────────────────────────────────────────────────────

/** Records one trade. */
export const ADD_TRADE_TOOL = 'stock_add_trade'

/** Reports positions and profit. */
export const OVERVIEW_TOOL = 'stock_portfolio_overview'

/** How many candidate symbols one question offers before the user must type. */
const SYMBOL_CHOICES = 5

/** How many position rows one overview reply carries before it says it truncated. */
const POSITION_LIMIT = 40

/** A trade that can still be sold short of what it holds is not the tool's call. */
const DESCRIPTION_ADD_TRADE = '把一笔股票 / ETF / 可转债交易记进 DSH 股票持仓插件的本地交易记录（与侧边栏「股票持仓」面板同一份数据）。'
  + '用户用自然语言说出交易时调用它，只传已经听到的字段：标的、方向、数量、价格、日期、动机中缺的部分会自动弹出问题卡片问用户，'
  + '所以不要为了补齐字段而编造数值，也不要先反问用户再调用。'
  + '「今天」「昨天」可以直接作为日期，6 位 A 股代码、3~5 位港股代码、美股字母代码都能直接传。'
  + '用户明确不想被追问时（例如连续录入多笔）传 ask_motive: false 可以跳过动机提问，其余必填字段仍然会问。'
  + '写入成功后返回该标的更新后的持仓，可以直接用来向用户汇报。'

const DESCRIPTION_OVERVIEW = '读取 DSH 股票持仓插件里的持仓与盈亏（与侧边栏「股票持仓」面板同一份数据）：按最新日线收盘价估值的持仓明细、'
  + '总市值、浮动 / 已实现盈亏、当日盈亏、分币种小计。用户问「我现在持仓怎么样」「某只赚了多少」时调用它，不要靠记忆回答。'

// ─── parsing and formatting ──────────────────────────────────────────────────

/** A JSON object, or an empty one for anything else. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** A trimmed, non-empty string, or `null`. */
function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** A finite number, or `null`. */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The leading string of a list of unknown values, for `render`. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Read a number out of free text.
 * @param text - whatever the user typed, possibly with separators or a unit.
 * @returns the first number in it, or `null` when there is none.
 */
function numberIn(text: string | null): number | null {
  if (text === null) return null
  const match = /-?\d+(?:\.\d+)?/u.exec(text.replace(/[,，_\s]/gu, ''))
  if (match === null) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

/** A number as the user should read it: no float noise, no trailing zeros. */
function plain(value: number): string {
  return String(Number(value.toFixed(4)))
}

/** A money amount, always two decimals. */
function money(value: number): string {
  return value.toFixed(2)
}

/** A money amount with an explicit sign, for a profit or loss. */
function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

/** A percentage from a ratio, with a sign. */
function percent(ratio: number): string {
  return `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(2)}%`
}

/** The exchange-local day of an instant, as `YYYY-MM-DD`. */
function localDay(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** The day before an instant, as `YYYY-MM-DD`. */
function dayBefore(at: Date): string {
  return localDay(new Date(at.getTime() - 86_400_000))
}

/**
 * Read a trade direction out of what the caller supplied.
 * @param value - `buy` / `sell`, or the Chinese words.
 * @returns the direction, or `null` when it is absent or unrecognized.
 */
function parseSide(value: unknown): TradeSide | null {
  const text = textOf(value)?.toLowerCase() ?? null
  if (text === null) return null
  if (text === 'buy' || text === 'b' || text.includes('买')) return 'buy'
  if (text === 'sell' || text === 's' || text.includes('卖')) return 'sell'
  return null
}

/**
 * Read a trade date out of what the caller supplied.
 *
 * Relative words are resolved against the caller's own clock, which is the day
 * the person reading the panel is in.
 * @param value - `YYYY-MM-DD`, `今天` / `昨天`, or a loose date.
 * @param now - the current instant.
 * @returns the canonical `YYYY-MM-DD`, or `null` when it cannot be read.
 */
function parseDate(value: unknown, now: Date): string | null {
  const text = textOf(value)
  if (text === null) return null
  if (text.startsWith('今天') || text === '今日') return localDay(now)
  if (text.startsWith('昨天') || text === '昨日') return dayBefore(now)
  const separated = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/u.exec(text)
  if (separated !== null) {
    const [, year, month, day] = separated
    const padded = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    return Number.isNaN(Date.parse(padded)) ? null : padded
  }
  return null
}

// ─── the symbol ──────────────────────────────────────────────────────────────

/** A symbol the tool is ready to write. */
interface Resolved {
  readonly symbol: string
  readonly name: string | null
  readonly exchange: string
  readonly currency: Currency
}

/** What resolving a piece of user text produced. */
type Resolution =
  | { readonly kind: 'resolved', readonly match: Resolved, readonly note: string | null }
  | { readonly kind: 'ambiguous', readonly matches: readonly SymbolMatch[] }
  | { readonly kind: 'unknown' }

/** Project one index hit onto the resolved shape. */
function toResolved(match: SymbolMatch): Resolved {
  return { symbol: match.symbol, name: match.name, exchange: match.exchange, currency: match.currency }
}

/**
 * Turn what the user called an instrument into a canonical symbol.
 *
 * The local index answers first — it is what makes “腾讯控股” work — and a query
 * it cannot answer falls back to the shape rule every broker app uses, so
 * `600000` alone is enough. A shape match is reported as such rather than
 * silently: only the user knows whether they meant the Shenzhen equity or the
 * index that shares the code.
 * @param service - the portfolio service.
 * @param query - the raw text.
 * @returns the resolution.
 */
async function resolveSymbol(service: PortfolioService, query: string): Promise<Resolution> {
  const matches = await service.lookup(query)
  const only = matches.length === 1 ? matches[0] : undefined
  if (only !== undefined) return { kind: 'resolved', match: toResolved(only), note: null }
  if (matches.length > 1) return { kind: 'ambiguous', matches }

  try {
    const parsed = normalizeSymbol(query)
    return {
      kind: 'resolved',
      match: {
        symbol: parsed.symbol,
        name: service.db.namesOf([parsed.symbol]).get(parsed.symbol) ?? null,
        exchange: parsed.exchange,
        currency: parsed.currency,
      },
      note: `本地代码索引里没有「${query}」，按代码形状推断为 ${parsed.symbol}`,
    }
  } catch {
    return { kind: 'unknown' }
  }
}

// ─── the draft under construction ────────────────────────────────────────────

/** Every field of a trade, before any of it is trusted. */
interface Draft {
  symbol: string | null
  name: string | null
  exchange: string | null
  currency: Currency | null
  side: TradeSide | null
  quantity: number | null
  price: number | null
  tradedAt: string | null
  motive: string | null
  note: string | null
}

/** The fields a record cannot be written without, in the order they are asked. */
const REQUIRED_FIELDS = ['symbol', 'side', 'quantity', 'price', 'traded_at'] as const

/** Chinese labels for the field names in a message. */
const FIELD_LABEL: Readonly<Record<string, string>> = {
  symbol: '标的',
  side: '方向',
  quantity: '数量',
  price: '价格',
  traded_at: '成交日期',
  motive: '动机',
}

/** The fields this draft still needs, in the order they are asked. */
function missingFields(draft: Draft): string[] {
  const values: Readonly<Record<string, unknown>> = {
    symbol: draft.symbol,
    side: draft.side,
    quantity: draft.quantity,
    price: draft.price,
    traded_at: draft.tradedAt,
  }
  return REQUIRED_FIELDS.filter(field => values[field] === null)
}

/** The latest stored daily close for one symbol, or `null` when it has none. */
function quoteFor(service: PortfolioService, symbol: string | null, now: Date): Quote | null {
  if (symbol === null) return null
  const names = service.db.namesOf([symbol])
  return service.db.latestQuotes(now, names).find(quote => quote.symbol === symbol) ?? null
}

// ─── questions ───────────────────────────────────────────────────────────────

/** The question asking for a symbol, with index hits as options when available. */
function symbolQuestion(candidates: readonly SymbolMatch[]): UserQuestion {
  const options = candidates.slice(0, SYMBOL_CHOICES).map(candidate => ({
    label: candidate.name === null ? candidate.symbol : `${candidate.symbol}  ${candidate.name}`,
    description: exchangeLabel(candidate.exchange),
  }))
  return {
    id: 'symbol',
    header: '标的',
    question: '这笔交易是哪个标的？',
    detail: '可以直接输入代码（600000.SH / 00700.HK / AAPL.US）或名称，例如「腾讯控股」「贵州茅台」',
    ...options.length === 0 ? {} : { options },
  }
}

/** The question asking for the direction. */
function sideQuestion(): UserQuestion {
  return {
    id: 'side',
    header: '方向',
    question: '这笔交易是买入还是卖出？',
    options: [
      { label: '买入', description: 'buy' },
      { label: '卖出', description: 'sell' },
    ],
  }
}

/** The question asking for the quantity. */
function quantityQuestion(draft: Draft): UserQuestion {
  const of = draft.symbol === null ? '' : ` ${draft.name ?? draft.symbol}`
  return {
    id: 'quantity',
    header: '数量',
    question: `成交数量是多少${of}？`,
    detail: '股票填股数，ETF / 基金填份额，例如 100',
  }
}

/**
 * The question asking for the price.
 *
 * When a daily close is already stored for the symbol it becomes the first
 * option — the common case for a trade recorded the same evening — with a
 * description saying plainly that it is not the user's fill.
 */
function priceQuestion(draft: Draft, quote: Quote | null): UserQuestion {
  const currency = draft.currency ?? 'CNY'
  return {
    id: 'price',
    header: '价格',
    question: `成交价是多少（${currency}／每股）？`,
    detail: '填每股成交价，不含手续费',
    ...quote === null ? {} : {
      options: [{
        label: `使用最新收盘价 ${plain(quote.price)}（${quote.date}）`,
        description: '来自本地保存的日线收盘价，不是你的实际成交价',
      }],
    },
  }
}

/** The question asking for the trade date. */
function dateQuestion(now: Date): UserQuestion {
  return {
    id: 'traded_at',
    header: '日期',
    question: '成交日期是哪天？',
    detail: '也可以直接输入 2026-09-10 这样的日期',
    options: [
      { label: `今天（${localDay(now)}）`, description: '今天成交' },
      { label: `昨天（${dayBefore(now)}）`, description: '昨天成交' },
    ],
  }
}

/**
 * The question asking for the motive.
 *
 * The options are the dashboard's own quick picks for the direction, then the
 * motives this user has already written, so the chat keeps filling the same
 * vocabulary the panel reports on. “不记录动机” is a real answer, not a cancel.
 */
function motiveQuestion(side: TradeSide | null, used: readonly string[]): UserQuestion {
  const presets = side === null ? [...MOTIVE_PRESETS.buy, ...MOTIVE_PRESETS.sell] : [...MOTIVE_PRESETS[side]]
  const history = used.filter(motive => !presets.includes(motive)).slice(0, MOTIVE_HISTORY_LIMIT)
  return {
    id: 'motive',
    header: '动机',
    question: '这笔交易的动机是什么？',
    detail: '会用于按动机统计盈亏；可以选一个，也可以自己写',
    options: [...presets, ...history, '不记录动机'].map(label => ({ label })),
  }
}

// ─── answers ─────────────────────────────────────────────────────────────────

/** What one answer text is, whichever way the UI delivered it. */
function answerText(answers: readonly UserQuestionAnswer[], id: string): string | null {
  const answer = answers.find(item => item.id === id)
  if (answer === undefined) return null
  const custom = textOf(answer.custom)
  if (custom !== null) return custom
  // `selected` is required by the contract, but the answerer is a waterfall any
  // composition can join: a hand-built answer must not throw inside a tool.
  for (const selected of Array.isArray(answer.selected) ? answer.selected : []) {
    const text = textOf(selected)
    if (text !== null) return text
  }
  return null
}

/** The outcome of trying to put the open questions to the user. */
type AskOutcome =
  | { readonly kind: 'answered', readonly answers: readonly UserQuestionAnswer[] }
  | { readonly kind: 'unavailable', readonly message: string }
  | { readonly kind: 'aborted' }

/**
 * Ask the user everything that is still open, in one card.
 *
 * A caller that is not the live runtime root has no human answerer, and a
 * composition may mount none at all; both are ordinary outcomes here, not
 * failures, because the tool still has a useful answer to give the model.
 * @param deps - the tool's capabilities.
 * @param questions - the open questions.
 * @param exec - the execution context, for the calling agent and its signal.
 * @returns the answers, or why there are none.
 */
async function askUser(
  deps: PortfolioToolDeps,
  questions: readonly UserQuestion[],
  exec: ToolRunContext,
): Promise<AskOutcome> {
  const capability = deps.userQuestions
  if (capability === undefined) {
    return { kind: 'unavailable', message: '当前 DSH 组合没有挂载用户提问服务（ctx.userQuestions）' }
  }
  try {
    const answer = await capability.ask({
      questions,
      ...exec.agent === undefined ? {} : { agent: exec.agent },
      ...exec.signal === undefined ? {} : { signal: exec.signal },
    })
    return { kind: 'answered', answers: answer.answers }
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null
    if (code === 'ASK_ABORTED') return { kind: 'aborted' }
    if (code === 'DELEGATED_CALLER' || code === 'CALLER_NOT_LIVE' || code === 'NO_PROVIDER') {
      return {
        kind: 'unavailable',
        message: `当前会话无法直接向用户提问（${code}）：子代理会话没有人类回答者`,
      }
    }
    return {
      kind: 'unavailable',
      message: `提问失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Adopt the symbol the user named in an answer.
 *
 * An option label leads with the canonical symbol; anything else is text the
 * user typed and goes back through the same resolver. A still-ambiguous answer
 * resolves to its first candidate and says so, because a second question card
 * over a symbol the user just chose is worse than a note they can correct.
 * @param draft - the draft to fill.
 * @param answer - the answer text.
 * @param service - the portfolio service.
 * @param notes - collected remarks for the reply.
 */
async function adoptSymbolAnswer(
  draft: Draft,
  answer: string,
  service: PortfolioService,
  notes: string[],
): Promise<void> {
  const leading = /^[A-Za-z0-9][A-Za-z0-9.-]*/u.exec(answer)?.[0]
  const query = leading !== undefined && leading.includes('.') ? leading : answer
  const resolution = await resolveSymbol(service, query)
  if (resolution.kind === 'resolved') {
    draft.symbol = resolution.match.symbol
    draft.name = resolution.match.name
    draft.exchange = resolution.match.exchange
    draft.currency = resolution.match.currency
    if (resolution.note !== null) notes.push(resolution.note)
    return
  }
  if (resolution.kind === 'ambiguous') {
    const first = resolution.matches[0]
    if (first !== undefined) {
      const match = toResolved(first)
      draft.symbol = match.symbol
      draft.name = match.name
      draft.exchange = match.exchange
      draft.currency = match.currency
      notes.push(`「${answer}」有 ${String(resolution.matches.length)} 个候选，取了第一个 ${match.symbol}`)
      return
    }
  }
  notes.push(`无法把「${answer}」识别成标的，请让用户给出代码，例如 600000.SH`)
}

/**
 * Fold the answers back into the draft.
 *
 * Every parse is defensive: a skipped question, an answer that does not parse
 * and a field the user typed something odd into all leave the field open, and
 * the caller reports what is still missing rather than writing a guess.
 * @param draft - the draft to fill.
 * @param answers - what the user answered.
 * @param service - the portfolio service.
 * @param now - the current instant, for a relative date.
 * @param notes - collected remarks for the reply.
 */
async function adoptAnswers(
  draft: Draft,
  answers: readonly UserQuestionAnswer[],
  service: PortfolioService,
  now: Date,
  notes: string[],
): Promise<void> {
  const symbol = answerText(answers, 'symbol')
  if (draft.symbol === null && symbol !== null) await adoptSymbolAnswer(draft, symbol, service, notes)

  if (draft.side === null) {
    const side = parseSide(answerText(answers, 'side'))
    if (side !== null) draft.side = side
  }
  if (draft.quantity === null) {
    const quantity = numberIn(answerText(answers, 'quantity'))
    if (quantity !== null && quantity > 0) draft.quantity = quantity
  }
  if (draft.price === null) {
    const answer = answerText(answers, 'price')
    // The “latest close” option is a label, not a number: its own date would
    // otherwise be the number this parse found.
    if (answer !== null && answer.startsWith('使用最新收盘价')) {
      const quote = quoteFor(service, draft.symbol, now)
      if (quote !== null) draft.price = quote.price
    } else {
      const price = numberIn(answer)
      if (price !== null && price >= 0) draft.price = price
    }
  }
  if (draft.tradedAt === null) {
    const tradedAt = parseDate(answerText(answers, 'traded_at'), now)
    if (tradedAt !== null) draft.tradedAt = tradedAt
  }
  if (draft.motive === null) {
    const motive = answerText(answers, 'motive')
    if (motive !== null && motive !== '不记录动机') draft.motive = motive
  }
}

// ─── projections ─────────────────────────────────────────────────────────────

/** One position as the model reads it: scalars only, absent keys are unknowns. */
function projectPosition(position: Position): Record<string, unknown> {
  return {
    symbol: position.symbol,
    exchange: position.exchange,
    currency: position.currency,
    quantity: position.quantity,
    avg_cost: position.avgCost,
    cost_basis: position.costBasis,
    realized_pnl: position.realizedPnl,
    trade_count: position.tradeCount,
    last_trade_at: position.lastTradeAt,
    weight: position.weight,
    ...position.name === null ? {} : { name: position.name },
    ...position.price === null || position.priceDate === null
      ? {}
      : { price: position.price, price_date: position.priceDate },
    ...position.marketValue === null ? {} : { market_value: position.marketValue },
    ...position.unrealizedPnl === null ? {} : { unrealized_pnl: position.unrealizedPnl },
    ...position.unrealizedPct === null ? {} : { unrealized_pct: position.unrealizedPct },
    ...position.dayPnl === null ? {} : { day_pnl: position.dayPnl },
  }
}

/** One stored trade as the model reads it. */
function projectTrade(trade: Trade): Record<string, unknown> {
  return {
    id: trade.id,
    symbol: trade.symbol,
    exchange: trade.exchange,
    currency: trade.currency,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    traded_at: trade.tradedAt,
    ...trade.name === null ? {} : { name: trade.name },
    ...trade.motive === null ? {} : { motive: trade.motive },
    ...trade.note === null ? {} : { note: trade.note },
  }
}

/** The questions as lossless JSON, so a calling model can re-ask them itself. */
function wireQuestions(questions: readonly UserQuestion[]): Record<string, unknown>[] {
  return questions.map(question => ({
    id: question.id,
    question: question.question,
    ...question.header === undefined ? {} : { header: question.header },
    ...question.detail === undefined ? {} : { detail: question.detail },
    ...question.multiSelect === undefined ? {} : { multi_select: question.multiSelect },
    ...question.options === undefined ? {} : {
      options: question.options.map(option => ({
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    },
  }))
}

/** The reply when the record cannot be written yet, or at all. */
function unsettled(
  message: string,
  draft: Draft,
  questions: readonly UserQuestion[],
  notes: readonly string[] = [],
): Record<string, unknown> {
  const missing = missingFields(draft)
  return {
    ok: false,
    message,
    missing,
    missing_labels: missing.map(field => FIELD_LABEL[field] ?? field),
    ...questions.length === 0 ? {} : { questions: wireQuestions(questions) },
    ...notes.length === 0 ? {} : { notes: [...notes] },
  }
}

// ─── the tools ───────────────────────────────────────────────────────────────

/**
 * Record one trade, asking for whatever the user did not say.
 * @param rawArgs - the model's arguments.
 * @param exec - the execution context.
 * @param service - the portfolio service.
 * @param deps - the tool's capabilities.
 * @returns the tool's canonical result value.
 */
async function executeAddTrade(
  rawArgs: unknown,
  exec: ToolRunContext,
  service: PortfolioService,
  deps: PortfolioToolDeps,
): Promise<Record<string, unknown>> {
  const args = asRecord(rawArgs)
  const now = deps.now?.() ?? new Date()
  const notes: string[] = []

  const draft: Draft = {
    symbol: null,
    name: null,
    exchange: null,
    currency: null,
    side: parseSide(args['side']),
    quantity: numberOf(args['quantity']),
    price: numberOf(args['price']),
    tradedAt: parseDate(args['traded_at'], now),
    motive: textOf(args['motive']),
    note: textOf(args['note']),
  }
  // A value the service would reject is treated as absent, so the user is asked
  // for it instead of the write failing after a full round trip.
  if (draft.quantity !== null && draft.quantity <= 0) draft.quantity = null
  if (draft.price !== null && draft.price < 0) draft.price = null

  // The symbol first: the price question offers the stored close for this
  // symbol, and a candidate list is only available once a lookup has run.
  let candidates: readonly SymbolMatch[] = []
  const dictated = textOf(args['symbol'])
  if (dictated !== null) {
    const resolution = await resolveSymbol(service, dictated)
    if (resolution.kind === 'resolved') {
      draft.symbol = resolution.match.symbol
      draft.name = resolution.match.name
      draft.exchange = resolution.match.exchange
      draft.currency = resolution.match.currency
      if (resolution.note !== null) notes.push(resolution.note)
    } else if (resolution.kind === 'ambiguous') {
      candidates = resolution.matches
    } else {
      notes.push(`本地代码索引里没有「${dictated}」，也无法按代码形状推断`)
    }
  }

  const questions: UserQuestion[] = []
  if (draft.symbol === null) questions.push(symbolQuestion(candidates))
  if (draft.side === null) questions.push(sideQuestion())
  if (draft.quantity === null) questions.push(quantityQuestion(draft))
  if (draft.price === null) questions.push(priceQuestion(draft, quoteFor(service, draft.symbol, now)))
  if (draft.tradedAt === null) questions.push(dateQuestion(now))
  if (draft.motive === null && args['ask_motive'] !== false) {
    questions.push(motiveQuestion(draft.side, service.db.listMotives()))
  }

  const asked = questions.map(question => question.id)
  if (questions.length > 0) {
    const outcome = await askUser(deps, questions, exec)
    if (outcome.kind === 'aborted') {
      return unsettled('用户取消了这次填写，交易没有写入。', draft, questions, notes)
    }
    if (outcome.kind === 'unavailable') {
      return unsettled(
        `${outcome.message}。请用你自己的 ask_user_question 工具向用户确认下列字段后重试。`,
        draft,
        questions,
        notes,
      )
    }
    await adoptAnswers(draft, outcome.answers, service, now, notes)
  }

  const missing = missingFields(draft)
  if (missing.length > 0) {
    const labels = missing.map(field => FIELD_LABEL[field] ?? field).join('、')
    return unsettled(`还缺 ${labels}，交易没有写入。请向用户确认后重试。`, draft, [], notes)
  }

  // Every field is present, but the types cannot know it; the checks below are
  // the ones the service would make anyway, restated so nothing is coerced.
  if (draft.symbol === null || draft.side === null || draft.quantity === null
    || draft.price === null || draft.tradedAt === null) {
    return unsettled('字段不完整，交易没有写入。', draft, [], notes)
  }

  let trade: Trade
  try {
    trade = await service.addTrade({
      symbol: draft.symbol,
      side: draft.side,
      quantity: draft.quantity,
      price: draft.price,
      tradedAt: draft.tradedAt,
      motive: draft.motive,
      note: draft.note,
    })
  } catch (error) {
    // A rejected trade is a user-input problem, not a tool fault: it comes back
    // as a readable result the model can relay and fix.
    const message = error instanceof PortfolioError
      ? error.message
      : `写入失败：${error instanceof Error ? error.message : String(error)}`
    return unsettled(message, draft, [], notes)
  }

  // A symbol that has never been priced has no quote until a refresh runs. The
  // interval guard makes this a no-op most of the time, and it must never delay
  // or fail a trade that is already committed.
  void service.refresh(false).catch(() => {})

  const state = service.state()
  const position = state.positions.find(row => row.symbol === trade.symbol)
  // One conclusion line: the position detail is a structured field, and
  // `renderResult` turns it into the model's view of the updated holding.
  const message = `已记录交易 #${String(trade.id)}：${trade.tradedAt} ${trade.side === 'buy' ? '买入' : '卖出'} `
    + `${trade.symbol}${trade.name === null ? '' : ` ${trade.name}`} ${plain(trade.quantity)} 股 @ `
    + `${plain(trade.price)} ${trade.currency}${trade.motive === null ? '' : `（动机：${trade.motive}）`}`
    + (position !== undefined && position.quantity === 0
      ? `；该标的已清仓，已实现盈亏 ${signed(position.realizedPnl)} ${position.currency}`
      : '')

  return {
    ok: true,
    message,
    trade: projectTrade(trade),
    ...position === undefined ? {} : { position: projectPosition(position) },
    ...asked.length === 0 ? {} : { asked },
    ...notes.length === 0 ? {} : { notes },
  }
}

/**
 * Report the portfolio: totals, per-currency subtotals and position rows.
 * @param rawArgs - the model's arguments.
 * @param service - the portfolio service.
 * @returns the tool's canonical result value.
 */
function executeOverview(rawArgs: unknown, service: PortfolioService): Record<string, unknown> {
  const args = asRecord(rawArgs)
  const filter = textOf(args['symbol'])
  const includeClosed = args['include_closed'] === true
  const state = service.state()
  const needle = filter?.toUpperCase() ?? null
  const keeps = (symbol: string, name: string | null): boolean => needle === null
    || symbol.toUpperCase().includes(needle)
    || (name ?? '').toUpperCase().includes(needle)

  const positions = state.positions.filter(row => keeps(row.symbol, row.name))
  const rows = positions.slice(0, POSITION_LIMIT).map(projectPosition)
  const closed = includeClosed
    ? state.closed.filter(row => keeps(row.symbol, row.name)).slice(0, POSITION_LIMIT)
    : []
  const stats = state.stats
  const message = `${String(stats.openPositions)} 个标的、${String(stats.tradeCount)} 笔交易；`
    + `市值 ${money(stats.totalMarketValue)} ${stats.baseCurrency}（成本 ${money(stats.totalCost)}），`
    + `浮动盈亏 ${signed(stats.totalUnrealizedPnl)}，已实现 ${signed(stats.totalRealizedPnl)}，`
    + `当日 ${signed(stats.dayPnl)}`
    + `${stats.winRate === null ? '' : `，胜率 ${(stats.winRate * 100).toFixed(1)}%`}`
    + `${state.feed.latestDate === null ? '' : `；行情日期 ${state.feed.latestDate}`}`
    + (filter === null ? '' : `；只列出匹配「${filter}」的 ${String(positions.length)} 行`)

  return {
    ok: true,
    message,
    base_currency: stats.baseCurrency,
    totals: {
      market_value: stats.totalMarketValue,
      cost: stats.totalCost,
      unrealized_pnl: stats.totalUnrealizedPnl,
      realized_pnl: stats.totalRealizedPnl,
      total_pnl: stats.totalPnl,
      day_pnl: stats.dayPnl,
      open_positions: stats.openPositions,
      closed_positions: stats.closedPositions,
      trade_count: stats.tradeCount,
      ...stats.totalUnrealizedPct === null ? {} : { unrealized_pct: stats.totalUnrealizedPct },
      ...stats.dayPnlPct === null ? {} : { day_pnl_pct: stats.dayPnlPct },
      ...stats.winRate === null ? {} : { win_rate: stats.winRate },
    },
    native: stats.native.map(total => ({
      currency: total.currency,
      market_value: total.marketValue,
      cost: total.cost,
      unrealized_pnl: total.unrealizedPnl,
      realized_pnl: total.realizedPnl,
    })),
    positions: rows,
    positions_truncated: positions.length > rows.length,
    ...closed.length === 0 ? {} : {
      closed: closed.map(row => ({
        symbol: row.symbol,
        exchange: row.exchange,
        currency: row.currency,
        realized_pnl: row.realizedPnl,
        cost_sold: row.costSold,
        proceeds: row.proceeds,
        trade_count: row.tradeCount,
        opened_at: row.openedAt,
        closed_at: row.closedAt,
        ...row.name === null ? {} : { name: row.name },
      })),
    },
    ...filter === null ? {} : { filter },
    rates_note: `折算基准货币 ${stats.baseCurrency}；分币种小计见 native，均为各自币种的原始数值`,
  }
}

// ─── schemas ─────────────────────────────────────────────────────────────────

/**
 * One position row, declared once and referenced by both tools.
 *
 * The keys are the projection's own names rather than the service's: `Position`
 * is an internal record, and a tool result is a wire shape that happens to be
 * spelled in snake case like the rest of this harness. Only the fields a reader
 * can act on are declared, and every optional one is absent — never `null` —
 * when the underlying value is unknown.
 */
const POSITION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string' },
    name: { type: 'string' },
    exchange: { type: 'string' },
    currency: { type: 'string' },
    quantity: { type: 'number' },
    avg_cost: { type: 'number' },
    cost_basis: { type: 'number' },
    realized_pnl: { type: 'number' },
    trade_count: { type: 'number' },
    last_trade_at: { type: 'string' },
    weight: { type: 'number' },
    price: { type: 'number' },
    price_date: { type: 'string' },
    market_value: { type: 'number' },
    unrealized_pnl: { type: 'number' },
    unrealized_pct: { type: 'number' },
    day_pnl: { type: 'number' },
  },
  required: [
    'symbol', 'exchange', 'currency', 'quantity', 'avg_cost', 'cost_basis',
    'realized_pnl', 'trade_count', 'last_trade_at', 'weight',
  ],
}

/** The result of either tool: one shape, two outcomes. */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true 表示交易已经写入；false 表示没有写入，看 missing / questions。' },
    message: { type: 'string', description: '给用户看的一句话结论。' },
    trade: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number' },
        symbol: { type: 'string' },
        name: { type: 'string' },
        exchange: { type: 'string' },
        currency: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        quantity: { type: 'number' },
        price: { type: 'number' },
        traded_at: { type: 'string' },
        motive: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['id', 'symbol', 'exchange', 'currency', 'side', 'quantity', 'price', 'traded_at'],
    },
    position: POSITION_SCHEMA,
    asked: { type: 'array', items: { type: 'string' }, description: '这次向用户提了哪些字段的问题。' },
    notes: { type: 'array', items: { type: 'string' }, description: '推断与降级说明，例如代码按形状推断。' },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: '仍然缺失、导致没有写入的字段名。',
    },
    missing_labels: { type: 'array', items: { type: 'string' }, description: '上面那些字段的中文名。' },
    questions: {
      type: 'array',
      description: '本来要弹给用户的问题，便于调用方自己再问一次。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          header: { type: 'string' },
          detail: { type: 'string' },
          multi_select: { type: 'boolean' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { label: { type: 'string' }, description: { type: 'string' } },
              required: ['label'],
            },
          },
        },
        required: ['id', 'question'],
      },
    },
    base_currency: { type: 'string' },
    totals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        market_value: { type: 'number' },
        cost: { type: 'number' },
        unrealized_pnl: { type: 'number' },
        unrealized_pct: { type: 'number' },
        realized_pnl: { type: 'number' },
        total_pnl: { type: 'number' },
        day_pnl: { type: 'number' },
        day_pnl_pct: { type: 'number' },
        open_positions: { type: 'number' },
        closed_positions: { type: 'number' },
        trade_count: { type: 'number' },
        win_rate: { type: 'number' },
      },
      required: [
        'market_value', 'cost', 'unrealized_pnl', 'realized_pnl', 'total_pnl', 'day_pnl',
        'open_positions', 'closed_positions', 'trade_count',
      ],
    },
    native: {
      type: 'array',
      description: '分币种小计，未折算。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          currency: { type: 'string' },
          market_value: { type: 'number' },
          cost: { type: 'number' },
          unrealized_pnl: { type: 'number' },
          realized_pnl: { type: 'number' },
        },
        required: ['currency', 'market_value', 'cost', 'unrealized_pnl', 'realized_pnl'],
      },
    },
    positions: { type: 'array', items: POSITION_SCHEMA },
    positions_truncated: { type: 'boolean' },
    closed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string' },
          name: { type: 'string' },
          exchange: { type: 'string' },
          currency: { type: 'string' },
          realized_pnl: { type: 'number' },
          cost_sold: { type: 'number' },
          proceeds: { type: 'number' },
          trade_count: { type: 'number' },
          opened_at: { type: 'string' },
          closed_at: { type: 'string' },
        },
        required: [
          'symbol', 'exchange', 'currency', 'realized_pnl', 'cost_sold', 'proceeds',
          'trade_count', 'opened_at', 'closed_at',
        ],
      },
    },
    filter: { type: 'string' },
    rates_note: { type: 'string' },
  },
  required: ['ok', 'message'],
}

/** The tool that records a trade. */
function addTradeTool(service: PortfolioService, deps: PortfolioToolDeps): ToolDefinition {
  return {
    name: ADD_TRADE_TOOL,
    description: DESCRIPTION_ADD_TRADE,
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '标的代码或名称：600000 / 00700.HK / AAPL / 腾讯控股。用户没说就别猜，留空即会问用户。',
        },
        side: { type: 'string', enum: ['buy', 'sell'], description: 'buy=买入，sell=卖出。用户没说就留空。' },
        quantity: { type: 'number', description: '成交数量（股 / 份额）。用户没说就留空。' },
        price: { type: 'number', description: '每股成交价，不含手续费。用户没说就留空。' },
        traded_at: { type: 'string', description: '成交日期 YYYY-MM-DD；「今天」「昨天」也可以直接传。' },
        motive: { type: 'string', description: '交易动机，一句话，例如「回调加仓」。用户说了就传。' },
        note: { type: 'string', description: '备注。' },
        ask_motive: {
          type: 'boolean',
          description: '默认 true：用户没给动机时会问一次。连续录入多笔、不想被打断时传 false。',
        },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      return executeAddTrade(args, exec, service, deps)
    },
    presentCall(args: unknown): ToolCallView | undefined {
      try {
        const record = asRecord(args)
        const symbol = textOf(record['symbol'])
        const side = parseSide(record['side'])
        const subject = symbol ?? '交易'
        const verb = side === null ? '' : side === 'buy' ? '买入 ' : '卖出 '
        return { card: 'generic', title: `记录${verb}${subject}` }
      } catch {
        return undefined
      }
    },
  }
}

/** The tool that reports the portfolio. */
function overviewTool(service: PortfolioService): ToolDefinition {
  return {
    name: OVERVIEW_TOOL,
    description: DESCRIPTION_OVERVIEW,
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只看这一个标的（代码或名称片段）；不传就是全部持仓。' },
        include_closed: { type: 'boolean', description: '是否带出已清仓标的的历史，默认 false。' },
      },
    },
    output: { schema: OUTPUT_SCHEMA, render: renderResult },
    execute(args: unknown): Promise<unknown> {
      return Promise.resolve(executeOverview(args, service))
    },
  }
}

/**
 * What the model reads as the tool result.
 *
 * This projection is the model's ENTIRE view: the registry validates the
 * canonical value, renders it, and hands the model these blocks — the JSON value
 * never reaches it. So the rows that answer the question have to be here, not
 * merely in the returned object.
 */
function renderResult(_args: unknown, value: unknown): readonly TextBlock[] {
  const result = asRecord(value)
  const lines: string[] = []
  const message = textOf(result['message'])
  if (message !== null) lines.push(message)

  const position = asRecord(result['position'])
  if (Object.keys(position).length > 0) lines.push(positionLine(position))
  for (const row of Array.isArray(result['positions']) ? result['positions'] : []) {
    lines.push(positionLine(asRecord(row)))
  }
  for (const total of Array.isArray(result['native']) ? result['native'] : []) {
    const row = asRecord(total)
    lines.push(`${textOf(row['currency']) ?? ''}：市值 ${money(numberValue(row['market_value']))}`
      + ` · 成本 ${money(numberValue(row['cost']))}`
      + ` · 浮动 ${signed(numberValue(row['unrealized_pnl']))}`
      + ` · 已实现 ${signed(numberValue(row['realized_pnl']))}`)
  }
  for (const cleared of Array.isArray(result['closed']) ? result['closed'] : []) {
    const row = asRecord(cleared)
    lines.push(`（已清仓）${textOf(row['symbol']) ?? ''} ${textOf(row['name']) ?? ''}：`
      + `${textOf(row['opened_at']) ?? ''} → ${textOf(row['closed_at']) ?? ''}`
      + ` · 已实现 ${signed(numberValue(row['realized_pnl']))} ${textOf(row['currency']) ?? ''}`)
  }
  if (result['positions_truncated'] === true) lines.push('（持仓行多于这里列出的数量，已截断）')

  for (const note of stringList(result['notes'])) lines.push(`· ${note}`)
  const questions = Array.isArray(result['questions']) ? result['questions'] : []
  if (questions.length > 0) {
    lines.push('需要向用户确认：')
    for (const entry of questions) {
      const question = asRecord(entry)
      const labels = (Array.isArray(question['options']) ? question['options'] : [])
        .map(option => textOf(asRecord(option)['label']))
        .filter((label): label is string => label !== null)
      lines.push(`- [${textOf(question['id']) ?? ''}] ${textOf(question['question']) ?? ''}`
        + `${labels.length === 0 ? '' : ` 选项：${labels.join(' / ')}`}`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** A number from one projected record, or `0` when it is absent. */
function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** One position row as a line of the model's view. */
function positionLine(row: Record<string, unknown>): string {
  const symbol = textOf(row['symbol']) ?? ''
  const name = textOf(row['name'])
  const currency = textOf(row['currency']) ?? ''
  const price = typeof row['price'] === 'number' ? row['price'] : null
  const marketValue = typeof row['market_value'] === 'number' ? row['market_value'] : null
  const unrealized = typeof row['unrealized_pnl'] === 'number' ? row['unrealized_pnl'] : null
  const ratio = typeof row['unrealized_pct'] === 'number' ? row['unrealized_pct'] : null
  const weight = typeof row['weight'] === 'number' ? row['weight'] : null
  return `${symbol}${name === null ? '' : ` ${name}`}：${plain(numberValue(row['quantity']))} 股`
    + `${weight === null ? '' : ` · 仓位 ${(weight * 100).toFixed(1)}%`}`
    + ` · 成本 ${plain(numberValue(row['avg_cost']))}`
    + `${price === null ? ' · 暂无收盘价' : ` · 现价 ${plain(price)}（${textOf(row['price_date']) ?? ''}）`}`
    + `${marketValue === null ? '' : ` · 市值 ${money(marketValue)} ${currency}`}`
    + `${unrealized === null ? '' : ` · 浮动 ${signed(unrealized)}${ratio === null ? '' : `（${percent(ratio)}）`}`}`
}

/**
 * Build the tools this plugin contributes to the chat.
 *
 * Returned rather than registered so a test can drive `execute` directly, and so
 * the composition step stays a two-line decision.
 * @param service - the portfolio service.
 * @param deps - the tool's capabilities.
 * @returns the registry-ready definitions, in a stable order.
 */
export function createPortfolioTools(
  service: PortfolioService,
  deps: PortfolioToolDeps = {},
): readonly ToolDefinition[] {
  return [addTradeTool(service, deps), overviewTool(service)]
}

/**
 * Publish the chat tools into the running harness.
 *
 * Registration happens once per plugin load and is undone with the plugin: the
 * disposable returned by `tools.register` is owned by the plugin's own effect
 * scope, so a reload, a stop or an uninstall leaves no tool behind.
 * @param ctx - the plugin context.
 * @param service - the portfolio service.
 */
export function registerPortfolioTools(ctx: Context, service: PortfolioService): void {
  const tools = ctx.get('tools') as ToolRegistry | undefined
  if (tools === undefined) {
    // A composition without a tool registry is a legitimate one (a headless
    // service host); the dashboard half still works, so this is a note.
    console.warn('[stock-portfolio] ctx.tools is not mounted; the chat tools are unavailable')
    return
  }
  const userQuestions = ctx.get('userQuestions') as UserQuestionsCapability | undefined
  for (const tool of createPortfolioTools(service, { userQuestions })) {
    ctx.effect(() => tools.register(tool), `stock-portfolio: tool ${tool.name}`)
  }
}
