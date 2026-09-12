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
 * ## Reads, and the one that asks first
 *
 * The read side mirrors the panel: holdings and totals, one symbol's stored
 * series and its indicators, the aggregate analysis, and the local index. None
 * of them interrupts the user — they are the same numbers the dashboard is
 * already showing on screen, and they cost no provider quota.
 *
 * The trade log's individual rows are different. A row carries what the user
 * paid, why they paid it, and whatever else they wrote down, so
 * `stock_list_trades` asks through `ctx.userQuestions` before every read and
 * returns rows only for a clear yes. A refusal, a dismissed card, an unreadable
 * answer, and a caller with nobody to ask all end the same way: a result with no
 * records in it, carrying the question the caller can put to the user itself.
 * The permission is never remembered — “may I look” is a question about this
 * read, not a setting.
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
import type {
  BreakdownRow, ClosedPosition, Currency, PortfolioReviewSnapshot, Position, Quote, ReviewRow, SymbolBar,
  SymbolMatch, SymbolStats, Trade, TradeSide,
} from './types.ts'
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

/** One symbol's stored daily series, its indicators and its holding. */
export const SYMBOL_DETAIL_TOOL = 'stock_symbol_detail'

/** The aggregate analysis: motives, markets, ranking and ratios. */
export const ANALYSIS_TOOL = 'stock_analysis'

/** Local instrument-index search. */
export const SEARCH_TOOL = 'stock_search_symbols'

/** The trade log's individual rows, behind an explicit consent card. */
export const LIST_TRADES_TOOL = 'stock_list_trades'

/** The portfolio review: the current picture in one read, plus the research checklist. */
export const REVIEW_TOOL = 'stock_portfolio_review'

/** How many candidate symbols one question offers before the user must type. */
const SYMBOL_CHOICES = 5

/** How many position rows one overview reply carries before it says it truncated. */
const POSITION_LIMIT = 40

/** How many trailing daily bars a symbol read asks the store for, and its cap. */
const DETAIL_BARS = 120
const DETAIL_BARS_MAX = 500

/** How many of the newest bars the model is shown as a series. */
const RECENT_BARS = 30

/** How many of the newest trades one consent-gated read returns, and its cap. */
const TRADE_LIMIT = 50
const TRADE_LIMIT_MAX = 200

/** How many index hits one search returns, and its cap. */
const SEARCH_LIMIT = 8
const SEARCH_LIMIT_MAX = 30

/** How many ranking rows one analysis returns. */
const RANKING_LIMIT = 15

/** A trade that can still be sold short of what it holds is not the tool's call. */
const DESCRIPTION_ADD_TRADE = '把一笔股票 / ETF / 可转债交易记进 DSH 股票持仓插件的本地交易记录（与侧边栏「股票持仓」面板同一份数据）。'
  + '用户用自然语言说出交易时调用它，只传已经听到的字段：标的、方向、数量、价格、日期、动机中缺的部分会自动弹出问题卡片问用户，'
  + '所以不要为了补齐字段而编造数值，也不要先反问用户再调用。'
  + '「今天」「昨天」可以直接作为日期，6 位 A 股代码、3~5 位港股代码、美股字母代码都能直接传。'
  + '用户明确不想被追问时（例如连续录入多笔）传 ask_motive: false 可以跳过动机提问，其余必填字段仍然会问。'
  + '写入成功后返回该标的更新后的持仓，可以直接用来向用户汇报。'

const DESCRIPTION_OVERVIEW = '读取 DSH 股票持仓插件里的持仓与盈亏（与侧边栏「股票持仓」面板同一份数据）：按最新日线收盘价估值的持仓明细、'
  + '总市值、浮动 / 已实现盈亏、当日盈亏、分币种小计。用户问「我现在持仓怎么样」「某只赚了多少」时调用它，不要靠记忆回答。'

const DESCRIPTION_SYMBOL_DETAIL = '读取 DSH 股票持仓插件里某一个标的的本地日线与持仓统计（与侧边栏「股票持仓」面板同一份 SQLite 数据）：'
  + '最新收盘价与日期、最近若干交易日的收盘 / 成交量，以及 3/5/15/30/60 日涨跌幅、20 日均线偏离、20 日波动率、量比、'
  + '60 日区间与最大回撤、连续涨跌天数，并附该标的的持仓（数量、成本、市值、浮动 / 已实现盈亏、持有天数）与清仓历史。'
  + '用户问「腾讯最近走势怎么样」「茅台这几天涨了多少」「这只波动大不大」时调用它，不要靠记忆回答。'
  + '标的名有歧义时会在同一次调用里弹一张卡片让用户挑，已经说得清楚就一张都不弹；全部读本地日线，不额外请求行情接口。'

const DESCRIPTION_ANALYSIS = '读取 DSH 股票持仓插件的聚合分析（与面板「分析」分区同一份数据）：按交易动机归集的已实现 / 浮动盈亏、按市场的分布、'
  + '标的表现排行、清仓历史，以及胜率、平均盈亏、盈亏比、最好 / 最差标的等比率。'
  + '用户问「我在哪个动机上赚得多」「哪只最赚」「我的胜率多少」时调用它。'
  + '这里只有聚合口径，不含单笔成交的价格、动机与备注；要看单笔明细用 stock_list_trades，它会先问用户同意。'

const DESCRIPTION_SEARCH = '在 DSH 股票持仓插件的本地代码索引里检索标的（全市场规模，离线、即时）：按代码或名称片段返回规范代码、名称、交易所、币种与类型。'
  + '用户问「腾讯的代码是什么」「有哪些叫平安的标的」，或需要把一句话里的名称换成规范代码时调用它。'
  + '查询走本地索引，索引里查不到时才会尝试一次接口探测；这是纯查询，不读写用户的任何交易数据。'

const DESCRIPTION_LIST_TRADES = '读取 DSH 股票持仓插件里的单笔交易记录明细（与面板「交易」分区同一份数据）：成交日期、方向、数量、价格、动机、备注。'
  + '交易记录是用户的隐私数据，这个工具在读取前会自动弹一张授权卡片问用户，用户同意才返回明细，拒绝或没回答都不会返回任何记录。'
  + '所以用户明确说「看看我的交易记录 / 我那几笔买卖」时直接调用它，不要自己先反问；用户没说就别主动读。'
  + '只读，不修改任何记录：改一笔、删一笔仍然在面板里做。'

const DESCRIPTION_REVIEW = '对 DSH 股票持仓插件里的组合做一次复盘，一次调用给全当下该说的数：与面板同一份 SQLite 数据，'
  + '含总市值、浮动 / 已实现 / 当日盈亏、分币种小计、逐只持仓（权重、成本、浮动盈亏、30 日涨跌幅、20 日波动率、'
  + '60 日最大回撤、均线偏离、连续涨跌、持有天数）、约一个月的组合市值变化，以及已经算好的集中度、浮盈浮亏家数、'
  + '行情陈旧度等要点和 caveats。用户问「我的股票表现怎么样」「帮我复盘一下持仓」「我这个组合有什么风险」时调用它，'
  + '不要靠记忆回答，也不要用几个别的读接口自己拼。'
  + '读本地日线与交易记录，不请求行情接口、不含行业分类，也**不含**券商预期、研报、公司公告与新闻。'
  + '所以复盘的第二部分（未来约一个月的走势与催化：行业竞争、券商预期 / 研报、业务进展、管理层变动、新闻动态）'
  + '要你自己用当前的搜索 / 抓取工具按 research.symbols 里的标的逐只查清，并标出信息日期与来源、区分事实与推测；'
  + '不要把这个工具没返回的数字编出来。回复克制：先结论后依据，不要长篇大论。'

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

/**
 * Turn an optional count into a bounded row limit.
 *
 * A read is bounded on purpose: the model asks for what it needs, and a reply
 * that would bury the conversation is worse than one that says it truncated.
 * @param value - the model's number, or anything else.
 * @param fallback - the limit used when it said nothing usable.
 * @param max - the hard ceiling.
 * @returns a positive integer.
 */
function clampLimit(value: number | null, fallback: number, max: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
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
 * The canonical spelling of a query that is already a code.
 *
 * Used to widen a filter rather than to resolve one: a user's trade log stores
 * `600000.SH`, and a filter of `600000` has to find it without the tool having
 * to guess an exchange it was not asked about.
 * @param query - the raw text.
 * @returns the canonical symbol, or `null` when the text is not a code.
 */
function canonicalSymbol(query: string | null): string | null {
  if (query === null) return null
  try {
    return normalizeSymbol(query).symbol
  } catch {
    return null
  }
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
function symbolQuestion(
  candidates: readonly SymbolMatch[],
  question = '这笔交易是哪个标的？',
): UserQuestion {
  const options = candidates.slice(0, SYMBOL_CHOICES).map(candidate => ({
    label: candidate.name === null ? candidate.symbol : `${candidate.symbol}  ${candidate.name}`,
    description: exchangeLabel(candidate.exchange),
  }))
  return {
    id: 'symbol',
    header: '标的',
    question,
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

/** The label the consent card offers for “yes”, and the only one that reads. */
const CONSENT_ALLOW = '允许这一次'

/**
 * The card that stands between the model and the trade log.
 *
 * Trade rows carry what the user paid, why, and whatever they wrote down — the
 * most personal table in the database — so a read of them is asked for out loud
 * rather than inferred from the conversation. The card is per read and says so:
 * a plugin cannot know that this afternoon's question is the same permission.
 * @param scope - what this particular read would cover, in one phrase.
 * @returns the question.
 */
function consentQuestion(scope: string): UserQuestion {
  return {
    id: 'consent',
    header: '交易记录',
    question: '要读取你的交易记录明细吗？',
    detail: `${scope}。交易记录含每笔成交的价格、动机与备注，这次同意只对这一次读取有效。`,
    options: [
      { label: CONSENT_ALLOW, description: '返回本次请求的交易明细' },
      { label: '不允许', description: '不读取，也不返回任何明细' },
    ],
  }
}

/**
 * Whether an answer to the consent card is a yes.
 *
 * The card offers one “yes” label, but the answerer is a waterfall and a user
 * can always type instead. Free text only counts as permission when it actually
 * says so — everything unreadable, skipped or negative is a refusal, because the
 * cost of the two mistakes is not symmetric.
 * @param answer - the answer text, or `null` when nothing came back.
 * @returns true only for an unambiguous yes.
 */
function consentGranted(answer: string | null): boolean {
  if (answer === null) return false
  const text = answer.trim()
  if (text.startsWith('不允许') || text.includes('不同意') || text.includes('拒绝')) return false
  return text.startsWith('允许') || text.includes('同意') || text.includes('可以') || text === '好'
}

/**
 * One phrase describing exactly what a trade read would cover.
 * @param filter - the filters that will be applied, already parsed.
 * @param limit - the row cap.
 * @returns the phrase, for the consent card and the reply.
 */
function describeTradeScope(filter: Readonly<Record<string, unknown>>, limit: number): string {
  const parts: string[] = []
  if (typeof filter['symbol'] === 'string') parts.push(`只看「${filter['symbol']}」`)
  if (filter['side'] === 'buy') parts.push('只看买入')
  if (filter['side'] === 'sell') parts.push('只看卖出')
  if (typeof filter['since'] === 'string') parts.push(`${filter['since']} 起`)
  if (typeof filter['until'] === 'string') parts.push(`到 ${filter['until']} 为止`)
  return `${parts.length === 0 ? '全部交易记录' : parts.join('、')}，最多 ${String(limit)} 笔`
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
  const match = await symbolFromAnswer(service, answer, notes)
  if (match === null) return
  draft.symbol = match.symbol
  draft.name = match.name
  draft.exchange = match.exchange
  draft.currency = match.currency
}

/**
 * Resolve the symbol a user's answer names.
 *
 * An option label leads with the canonical symbol; anything else is text the
 * user typed and goes back through the same resolver. A still-ambiguous answer
 * resolves to its first candidate and says so, because a second question card
 * over a symbol the user just chose is worse than a note they can correct.
 * @param service - the portfolio service.
 * @param answer - the answer text.
 * @param notes - collected remarks for the reply.
 * @returns the resolved symbol, or `null` when nothing could be made of it.
 */
async function symbolFromAnswer(
  service: PortfolioService,
  answer: string,
  notes: string[],
): Promise<Resolved | null> {
  const leading = /^[A-Za-z0-9][A-Za-z0-9.-]*/u.exec(answer)?.[0]
  const query = leading !== undefined && leading.includes('.') ? leading : answer
  const resolution = await resolveSymbol(service, query)
  if (resolution.kind === 'resolved') {
    if (resolution.note !== null) notes.push(resolution.note)
    return resolution.match
  }
  if (resolution.kind === 'ambiguous') {
    const first = resolution.matches[0]
    if (first !== undefined) {
      notes.push(`「${answer}」有 ${String(resolution.matches.length)} 个候选，取了第一个 ${first.symbol}`)
      return toResolved(first)
    }
  }
  notes.push(`无法把「${answer}」识别成标的，请让用户给出代码，例如 600000.SH`)
  return null
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

/** One index hit as the model reads it. */
function projectMatch(match: SymbolMatch): Record<string, unknown> {
  return {
    symbol: match.symbol,
    exchange: match.exchange,
    currency: match.currency,
    ...match.name === null ? {} : { name: match.name },
    ...match.type === null ? {} : { type: match.type },
  }
}

/** One cleared position as the model reads it. */
function projectClosed(row: ClosedPosition): Record<string, unknown> {
  return {
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
  }
}

/** One grouped breakdown row (by motive, or by market). */
function projectBreakdown(row: BreakdownRow): Record<string, unknown> {
  return {
    key: row.key,
    label: row.label,
    trades: row.trades,
    realized_pnl: row.realizedPnl,
    unrealized_pnl: row.unrealizedPnl,
    total_pnl: row.totalPnl,
    market_value: row.marketValue,
  }
}

/** One ranking row: a position's booked and paper result side by side. */
function projectRanking(row: Position): Record<string, unknown> {
  const unrealized = row.unrealizedPnl
  return {
    symbol: row.symbol,
    currency: row.currency,
    trade_count: row.tradeCount,
    realized_pnl: row.realizedPnl,
    total_pnl: row.realizedPnl + (unrealized ?? 0),
    weight: row.weight,
    ...row.name === null ? {} : { name: row.name },
    ...unrealized === null ? {} : { unrealized_pnl: unrealized },
    ...row.marketValue === null ? {} : { market_value: row.marketValue },
  }
}

/**
 * The indicator block, with every unknown left out rather than sent as `null`.
 *
 * A window shorter than its lookback has no answer, and the model must be able
 * to tell “no number” from “zero” — so an absent key is the whole signal.
 */
function projectIndicators(stats: SymbolStats): Record<string, unknown> {
  return {
    bar_count: stats.barCount,
    streak: stats.streak,
    returns: stats.returns.map(period => ({
      days: period.days,
      ...period.change === null ? {} : { change: period.change },
      ...period.pct === null ? {} : { pct: period.pct },
    })),
    ...stats.firstDate === null ? {} : { first_date: stats.firstDate },
    ...stats.lastDate === null ? {} : { last_date: stats.lastDate },
    ...stats.lastClose === null ? {} : { last_close: stats.lastClose },
    ...stats.ma20 === null ? {} : { ma20: stats.ma20 },
    ...stats.ma20Gap === null ? {} : { ma20_gap: stats.ma20Gap },
    ...stats.volatility20 === null ? {} : { volatility20: stats.volatility20 },
    ...stats.volumeRatio === null ? {} : { volume_ratio: stats.volumeRatio },
    ...stats.maxDrawdown60 === null ? {} : { max_drawdown60: stats.maxDrawdown60 },
    ...stats.rangePosition60 === null ? {} : { range_position60: stats.rangePosition60 },
    ...stats.high60 === null ? {} : { high60: stats.high60 },
    ...stats.low60 === null ? {} : { low60: stats.low60 },
  }
}

/** One daily bar as the model reads it. */
function projectBar(bar: SymbolBar): Record<string, unknown> {
  return {
    date: bar.date,
    close: bar.close,
    high: bar.high,
    low: bar.low,
    volume: bar.volume,
  }
}

/**
 * One holding as a review reads it.
 *
 * The dashboard projection is the shape for a panel row; this one is the shape
 * for a judgement, so it states the position against the portfolio (weight,
 * converted value) and against its own recent behaviour (the indicator block)
 * in one flat object the model does not have to join.
 * @param row - the measured holding.
 * @returns the model-facing row.
 */
function projectReviewRow(row: ReviewRow): Record<string, unknown> {
  return {
    symbol: row.symbol,
    exchange: row.exchange,
    currency: row.currency,
    quantity: row.quantity,
    avg_cost: row.avgCost,
    weight: row.weight,
    cost: row.costBase,
    ...row.name === null ? {} : { name: row.name },
    ...row.price === null ? {} : { price: row.price },
    ...row.priceDate === null ? {} : { price_date: row.priceDate },
    ...row.marketValueBase === null ? {} : { market_value: row.marketValueBase },
    ...row.unrealizedPnl === null ? {} : { unrealized_pnl: row.unrealizedPnl },
    ...row.unrealizedPct === null ? {} : { unrealized_pct: row.unrealizedPct },
    ...row.dayPnlPct === null ? {} : { day_pnl_pct: row.dayPnlPct },
    ...row.holdingDays === null ? {} : { holding_days: row.holdingDays },
    trade_count: row.tradeCount,
    ...row.return30Pct === null ? {} : { return30_pct: row.return30Pct },
    ...row.volatility20 === null ? {} : { volatility20: row.volatility20 },
    ...row.maxDrawdown60 === null ? {} : { max_drawdown60: row.maxDrawdown60 },
    ...row.rangePosition60 === null ? {} : { range_position60: row.rangePosition60 },
    ...row.ma20Gap === null ? {} : { ma20_gap: row.ma20Gap },
    streak: row.streak,
    bars: row.bars,
    ...row.priceAgeDays === null ? {} : { price_age_days: row.priceAgeDays },
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
      closed: closed.map(projectClosed),
    },
    ...filter === null ? {} : { filter },
    rates_note: `折算基准货币 ${stats.baseCurrency}；分币种小计见 native，均为各自币种的原始数值`,
  }
}

/**
 * Search the local instrument index.
 *
 * The index is the same one the trade form's suggestion list reads, so a code
 * found here is a code the write path will accept.
 * @param rawArgs - the model's arguments.
 * @param service - the portfolio service.
 * @returns the tool's canonical result value.
 */
async function executeSearch(rawArgs: unknown, service: PortfolioService): Promise<Record<string, unknown>> {
  const args = asRecord(rawArgs)
  const query = textOf(args['query'])
  if (query === null) {
    return { ok: false, message: '要查哪个标的？把代码或名称传进来，例如「腾讯控股」「00700.HK」「AAPL」。' }
  }
  const limit = clampLimit(numberOf(args['limit']), SEARCH_LIMIT, SEARCH_LIMIT_MAX)
  const found = await service.lookup(query)
  const matches = found.slice(0, limit).map(projectMatch)
  const truncated = found.length > matches.length
  return {
    ok: matches.length > 0,
    message: matches.length === 0
      ? `本地代码索引里没有「${query}」。可以试完整代码（600000.SH / 00700.HK / AAPL.US）或名称的一部分。`
      : `本地代码索引里匹配「${query}」的 ${String(found.length)} 条`
        + `${truncated ? `，列出前 ${String(matches.length)} 条` : ''}`,
    query,
    matches,
    truncated,
  }
}

/**
 * Read one symbol: its stored daily series, the indicators measured from it,
 * and whatever position the log holds for it.
 *
 * The series is local, so this costs no provider quota and works offline. A name
 * with several index hits is put to the user in the same call rather than
 * guessed: reading the wrong 平安 is a wrong answer the model cannot detect.
 * @param rawArgs - the model's arguments.
 * @param exec - the execution context.
 * @param service - the portfolio service.
 * @param deps - the tool's capabilities.
 * @returns the tool's canonical result value.
 */
async function executeSymbolDetail(
  rawArgs: unknown,
  exec: ToolRunContext,
  service: PortfolioService,
  deps: PortfolioToolDeps,
): Promise<Record<string, unknown>> {
  const args = asRecord(rawArgs)
  const notes: string[] = []
  const asked: string[] = []
  const dictated = textOf(args['symbol'])
  if (dictated === null) {
    return { ok: false, message: '要看哪个标的？把代码或名称传进来，例如「00700.HK」「腾讯控股」。' }
  }

  const resolution = await resolveSymbol(service, dictated)
  let match: Resolved | null = null
  if (resolution.kind === 'resolved') {
    match = resolution.match
    if (resolution.note !== null) notes.push(resolution.note)
  } else if (resolution.kind === 'ambiguous') {
    const question = symbolQuestion(resolution.matches, '要看哪个标的？')
    const outcome = await askUser(deps, [question], exec)
    if (outcome.kind === 'answered') {
      asked.push('symbol')
      match = await symbolFromAnswer(service, answerText(outcome.answers, 'symbol') ?? '', notes)
    }
    if (match === null) {
      return {
        ok: false,
        message: outcome.kind === 'unavailable'
          ? `${outcome.message}。「${dictated}」有 ${String(resolution.matches.length)} 个候选，请向用户确认是哪一个再调用。`
          : `「${dictated}」有 ${String(resolution.matches.length)} 个候选，没有选中任何一个，这次没有读取。`,
        matches: resolution.matches.slice(0, SYMBOL_CHOICES).map(projectMatch),
        questions: wireQuestions([question]),
        ...notes.length === 0 ? {} : { notes },
      }
    }
  } else {
    return {
      ok: false,
      message: `本地代码索引里没有「${dictated}」，也无法按代码形状推断；先用 ${SEARCH_TOOL} 查一下代码。`,
    }
  }

  const limit = clampLimit(numberOf(args['bars']), DETAIL_BARS, DETAIL_BARS_MAX)
  const read = service.symbolBars(match.symbol, limit)
  const state = service.state()
  const position = state.positions.find(row => row.symbol === read.symbol)
  const cleared = state.closed.find(row => row.symbol === read.symbol)
  const name = match.name ?? position?.name ?? cleared?.name ?? null
  const currency = position?.currency ?? cleared?.currency ?? match.currency
  const stats = read.stats
  const price = position?.price ?? stats.lastClose
  const priceDate = position?.priceDate ?? stats.lastDate

  const message = `${read.symbol}${name === null ? '' : ` ${name}`}：`
    + (stats.barCount === 0
      ? '本地还没有日线，等下一次行情刷新'
      : `${String(stats.barCount)} 根日线（${stats.firstDate ?? '?'} → ${stats.lastDate ?? '?'}），`
        + `最新收盘 ${stats.lastClose === null ? '—' : plain(stats.lastClose)} ${currency}`)
    + (position === undefined
      ? '；当前没有持仓'
      : `；持仓 ${plain(position.quantity)} 股，成本 ${plain(position.avgCost)}`
        + `${position.unrealizedPnl === null ? '' : `，浮动 ${signed(position.unrealizedPnl)}`}`
        + `${position.marketValue === null ? '' : `，市值 ${money(position.marketValue)}`}`)

  return {
    ok: true,
    message,
    symbol: read.symbol,
    exchange: match.exchange,
    currency,
    ...name === null ? {} : { name },
    ...price === null || priceDate === null ? {} : { quote: { price, date: priceDate } },
    history: projectIndicators(stats),
    recent_bars: read.bars.slice(-RECENT_BARS).map(projectBar),
    bars_truncated: read.bars.length >= limit,
    ...position === undefined ? {} : { position: projectPosition(position) },
    ...cleared === undefined ? {} : { closed: projectClosed(cleared) },
    ...asked.length === 0 ? {} : { asked },
    ...notes.length === 0 ? {} : { notes },
  }
}

/**
 * The aggregate analysis: what the trade log says about how the user trades.
 *
 * Every number here is already computed by `derivePortfolio` for the panel's
 * 分析 section, so the tool adds no second arithmetic — only a projection and a
 * bounded ranking.
 * @param rawArgs - the model's arguments.
 * @param service - the portfolio service.
 * @returns the tool's canonical result value.
 */
function executeAnalysis(rawArgs: unknown, service: PortfolioService): Record<string, unknown> {
  const args = asRecord(rawArgs)
  const limit = clampLimit(numberOf(args['limit']), RANKING_LIMIT, POSITION_LIMIT)
  const state = service.state()
  const stats = state.stats
  const ranking = [...state.positions]
    .sort((left, right) => (right.unrealizedPnl ?? 0) + right.realizedPnl
      - ((left.unrealizedPnl ?? 0) + left.realizedPnl))
    .slice(0, limit)
    .map(projectRanking)
  const bestMotive = stats.byMotive.reduce<BreakdownRow | null>(
    (best, row) => best === null || row.totalPnl > best.totalPnl ? row : best,
    null,
  )

  const message = `已实现 ${signed(stats.totalRealizedPnl)} ${stats.baseCurrency}`
    + `（${String(stats.closedPositions)} 次清仓、${String(stats.tradeCount)} 笔交易）`
    + `${stats.winRate === null ? '' : `，胜率 ${(stats.winRate * 100).toFixed(1)}%`}`
    + `${stats.profitFactor === null ? '' : `，盈亏比 ${stats.profitFactor.toFixed(2)}`}`
    + `；按动机 ${String(stats.byMotive.length)} 组、按市场 ${String(stats.byMarket.length)} 组`
    + `${bestMotive === null ? '' : `，「${bestMotive.label}」合计 ${signed(bestMotive.totalPnl)} 最高`}`

  return {
    ok: true,
    message,
    base_currency: stats.baseCurrency,
    ratios: {
      closed_positions: stats.closedPositions,
      open_positions: stats.openPositions,
      trade_count: stats.tradeCount,
      ...stats.winRate === null ? {} : { win_rate: stats.winRate },
      ...stats.avgWin === null ? {} : { avg_win: stats.avgWin },
      ...stats.avgLoss === null ? {} : { avg_loss: stats.avgLoss },
      ...stats.profitFactor === null ? {} : { profit_factor: stats.profitFactor },
      ...stats.bestSymbol === null ? {} : { best_symbol: stats.bestSymbol },
      ...stats.worstSymbol === null ? {} : { worst_symbol: stats.worstSymbol },
    },
    by_motive: stats.byMotive.map(projectBreakdown),
    by_market: stats.byMarket.map(projectBreakdown),
    ranking,
    closed: state.closed.slice(0, limit).map(projectClosed),
    rates_note: `已实现盈亏记在卖出动机上，浮动盈亏按买入动机仍占用的成本比例分摊；金额折算为 ${stats.baseCurrency}`,
  }
}

/**
 * Read the trade log's individual rows, after asking the user out loud.
 *
 * This is the one read that is gated: a row carries what the user paid, why they
 * paid it, and whatever else they wrote down. The card is per call, because
 * “may I look” is a question about this read, not a setting — and every way of
 * not getting a clear yes (declined, dismissed, no answerer at all) ends in a
 * reply with no records in it.
 * @param rawArgs - the model's arguments.
 * @param exec - the execution context.
 * @param service - the portfolio service.
 * @param deps - the tool's capabilities.
 * @returns the tool's canonical result value.
 */
async function executeListTrades(
  rawArgs: unknown,
  exec: ToolRunContext,
  service: PortfolioService,
  deps: PortfolioToolDeps,
): Promise<Record<string, unknown>> {
  const args = asRecord(rawArgs)
  const now = deps.now?.() ?? new Date()
  const notes: string[] = []
  const filter: Record<string, unknown> = {}

  const symbol = textOf(args['symbol'])
  if (symbol !== null) filter['symbol'] = symbol
  const side = parseSide(args['side'])
  if (side !== null) filter['side'] = side
  else if (textOf(args['side']) !== null) notes.push(`方向「${textOf(args['side']) ?? ''}」不是买入或卖出，已忽略`)
  const sinceRaw = textOf(args['since'])
  const since = parseDate(args['since'], now)
  if (since !== null) filter['since'] = since
  else if (sinceRaw !== null) notes.push(`起始日期「${sinceRaw}」看不懂，已忽略`)
  const untilRaw = textOf(args['until'])
  const until = parseDate(args['until'], now)
  if (until !== null) filter['until'] = until
  else if (untilRaw !== null) notes.push(`结束日期「${untilRaw}」看不懂，已忽略`)
  const limit = clampLimit(numberOf(args['limit']), TRADE_LIMIT, TRADE_LIMIT_MAX)

  const question = consentQuestion(describeTradeScope(filter, limit))
  const outcome = await askUser(deps, [question], exec)
  const refused = (message: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ok: false,
    consent: 'declined',
    message,
    ...extra,
    ...notes.length === 0 ? {} : { notes },
  })
  if (outcome.kind === 'unavailable') {
    return refused(
      `${outcome.message}。读取交易记录必须由用户当面同意：请先用你自己的 ask_user_question 向用户说明要看什么并取得允许，再调用一次。`,
      { questions: wireQuestions([question]) },
    )
  }
  if (outcome.kind === 'aborted') {
    return refused('授权卡片被关掉了，没有读取交易记录，也没有返回任何明细。')
  }
  if (!consentGranted(answerText(outcome.answers, 'consent'))) {
    return refused('用户没有同意读取交易记录，这次没有返回任何明细。')
  }

  // Names come from the index when a trade row has none yet: the tool filters on
  // what the user calls a symbol, and the stored row may not carry that name.
  const all = service.db.listTrades()
  const names = service.db.namesOf([...new Set(all.map(trade => trade.symbol))])
  const nameOf = (trade: Trade): string | null => trade.name ?? names.get(trade.symbol) ?? null
  const needle = symbol?.toUpperCase() ?? null
  const canonical = canonicalSymbol(symbol)
  const keeps = (trade: Trade): boolean => {
    if (needle !== null) {
      const name = nameOf(trade)
      const hit = trade.symbol.toUpperCase().includes(needle)
        || (name ?? '').toUpperCase().includes(needle)
        || (canonical !== null && trade.symbol === canonical)
      if (!hit) return false
    }
    if (side !== null && trade.side !== side) return false
    if (since !== null && trade.tradedAt < since) return false
    if (until !== null && trade.tradedAt > until) return false
    return true
  }

  const matched = all.filter(keeps)
  // The store lists the log chronologically; a reader wants the newest first.
  const rows = [...matched].reverse().slice(0, limit).map(trade => {
    const row = projectTrade(trade)
    const name = nameOf(trade)
    return name === null || row['name'] !== undefined ? row : { ...row, name }
  })

  return {
    ok: true,
    consent: 'granted',
    message: `用户已同意；${describeTradeScope(filter, limit)}，共 ${String(matched.length)} 笔`
      + `${matched.length > rows.length ? `，列出最近 ${String(rows.length)} 笔` : ''}`,
    count: matched.length,
    trades: rows,
    truncated: matched.length > rows.length,
    ...Object.keys(filter).length === 0 ? {} : { filter },
    ...notes.length === 0 ? {} : { notes },
  }
}

// ─── schemas ─────────────────────────────────────────────────────────────────

/**
 * The questions a reply hands back, as lossless JSON.
 *
 * Declared once because three tools can return open questions — the write path
 * always, and the reads whenever there is nobody to ask.
 */
const QUESTIONS_SCHEMA: Record<string, unknown> = {
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
}

/** One stored trade row, as the model may read it out of a consenting call. */
const TRADE_SCHEMA: Record<string, unknown> = {
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
}

/** One cleared episode: a symbol that went to zero and what it booked. */
const CLOSED_SCHEMA: Record<string, unknown> = {
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
}

/** One index hit; the shape the search tool and a symbol question both speak. */
const MATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string' },
    name: { type: 'string' },
    exchange: { type: 'string' },
    currency: { type: 'string' },
    type: { type: 'string' },
  },
  required: ['symbol', 'exchange', 'currency'],
}

/** One grouped breakdown row, by motive or by market. */
const BREAKDOWN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string' },
    label: { type: 'string' },
    trades: { type: 'number' },
    realized_pnl: { type: 'number' },
    unrealized_pnl: { type: 'number' },
    total_pnl: { type: 'number' },
    market_value: { type: 'number' },
  },
  required: [
    'key', 'label', 'trades', 'realized_pnl', 'unrealized_pnl', 'total_pnl', 'market_value',
  ],
}

/** One ranking row: what a position booked, and what it is still worth. */
const RANKING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string' },
    name: { type: 'string' },
    currency: { type: 'string' },
    trade_count: { type: 'number' },
    realized_pnl: { type: 'number' },
    unrealized_pnl: { type: 'number' },
    total_pnl: { type: 'number' },
    market_value: { type: 'number' },
    weight: { type: 'number' },
  },
  required: ['symbol', 'currency', 'trade_count', 'realized_pnl', 'total_pnl', 'weight'],
}

/** One daily bar; the series the model is shown is a tail of these. */
const BAR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    date: { type: 'string' },
    close: { type: 'number' },
    high: { type: 'number' },
    low: { type: 'number' },
    volume: { type: 'number' },
  },
  required: ['date', 'close', 'high', 'low', 'volume'],
}

/**
 * The indicators measured from one stored series.
 *
 * `bar_count` and `streak` are always there — zero bars is an answer — while
 * every window that the series is too short for is simply absent, so the model
 * can tell “no number” from “zero”.
 */
const HISTORY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bar_count: { type: 'number' },
    streak: { type: 'number' },
    first_date: { type: 'string' },
    last_date: { type: 'string' },
    last_close: { type: 'number' },
    returns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: { type: 'number' },
          change: { type: 'number' },
          pct: { type: 'number' },
        },
        required: ['days'],
      },
    },
    ma20: { type: 'number' },
    ma20_gap: { type: 'number' },
    volatility20: { type: 'number' },
    volume_ratio: { type: 'number' },
    max_drawdown60: { type: 'number' },
    range_position60: { type: 'number' },
    high60: { type: 'number' },
    low60: { type: 'number' },
  },
  required: ['bar_count', 'streak', 'returns'],
}

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
    trade: TRADE_SCHEMA,
    position: POSITION_SCHEMA,
    asked: { type: 'array', items: { type: 'string' }, description: '这次向用户提了哪些字段的问题。' },
    notes: { type: 'array', items: { type: 'string' }, description: '推断与降级说明，例如代码按形状推断。' },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: '仍然缺失、导致没有写入的字段名。',
    },
    missing_labels: { type: 'array', items: { type: 'string' }, description: '上面那些字段的中文名。' },
    questions: QUESTIONS_SCHEMA,
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
    closed: { type: 'array', items: CLOSED_SCHEMA },
    filter: { type: 'string' },
    rates_note: { type: 'string' },
  },
  required: ['ok', 'message'],
}

/** The search tool's result: index hits, or an honest empty list. */
const SEARCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true 表示索引里有命中。' },
    message: { type: 'string' },
    query: { type: 'string' },
    matches: { type: 'array', items: MATCH_SCHEMA },
    truncated: { type: 'boolean' },
  },
  required: ['ok', 'message'],
}

/** The symbol-detail result: the series, its indicators, and the holding. */
const DETAIL_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true 表示读到了本地数据；false 表示标的没定下来。' },
    message: { type: 'string' },
    symbol: { type: 'string' },
    name: { type: 'string' },
    exchange: { type: 'string' },
    currency: { type: 'string' },
    quote: {
      type: 'object',
      additionalProperties: false,
      properties: { price: { type: 'number' }, date: { type: 'string' } },
      required: ['price', 'date'],
    },
    history: HISTORY_SCHEMA,
    recent_bars: { type: 'array', items: BAR_SCHEMA },
    bars_truncated: { type: 'boolean' },
    position: POSITION_SCHEMA,
    closed: CLOSED_SCHEMA,
    matches: { type: 'array', items: MATCH_SCHEMA },
    questions: QUESTIONS_SCHEMA,
    asked: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'message'],
}

/** The analysis result: ratios, two breakdowns, a ranking and the closed list. */
const ANALYSIS_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    base_currency: { type: 'string' },
    ratios: {
      type: 'object',
      additionalProperties: false,
      properties: {
        closed_positions: { type: 'number' },
        open_positions: { type: 'number' },
        trade_count: { type: 'number' },
        win_rate: { type: 'number' },
        avg_win: { type: 'number' },
        avg_loss: { type: 'number' },
        profit_factor: { type: 'number' },
        best_symbol: { type: 'string' },
        worst_symbol: { type: 'string' },
      },
      required: ['closed_positions', 'open_positions', 'trade_count'],
    },
    by_motive: { type: 'array', items: BREAKDOWN_SCHEMA },
    by_market: { type: 'array', items: BREAKDOWN_SCHEMA },
    ranking: { type: 'array', items: RANKING_SCHEMA },
    closed: { type: 'array', items: CLOSED_SCHEMA },
    rates_note: { type: 'string' },
  },
  required: ['ok', 'message'],
}

/**
 * The consent-gated trade read.
 *
 * `consent` is required in every outcome — including the failures — so a caller
 * can never mistake “nobody agreed” for “there are no trades”.
 */
const TRADES_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'true 表示用户同意且明细已返回；false 表示没有读取。' },
    message: { type: 'string' },
    consent: {
      type: 'string',
      enum: ['granted', 'declined'],
      description: 'granted = 用户这次同意了；declined = 拒绝、关掉了卡片或没人可问。',
    },
    count: { type: 'number', description: '符合筛选条件的交易笔数（不等于返回的条数）。' },
    trades: { type: 'array', items: TRADE_SCHEMA },
    truncated: { type: 'boolean' },
    filter: {
      type: 'object',
      additionalProperties: false,
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        since: { type: 'string' },
        until: { type: 'string' },
      },
      required: [],
    },
    questions: QUESTIONS_SCHEMA,
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'message', 'consent'],
}

// ─── the review ──────────────────────────────────────────────────────────────

/** How many holdings a review returns before it says it truncated. */
const REVIEW_LIMIT = 30

/** The lookbacks a research pass should cover, as one line each. */
const RESEARCH_ANGLES: readonly string[] = [
  '行业与竞争：所在行业近一个月的景气变化、对手动作、价格或份额之争',
  '券商预期 / 研报：最近的目标价、评级调整与盈利预测修正（写清机构与日期）',
  '业务进展：最近的财报或预告、订单 / 产量 / 销量、监管或政策口径变化',
  '管理层与股东：人事变动、增减持、回购、股权激励',
  '新闻与舆情：近一个月的实质新闻、诉讼、事故、供应链或客户变动',
]

/** What the local read model cannot see, and the caller therefore must fetch. */
const REVIEW_LIMITS: readonly string[] = [
  '不含行业 / 板块分类：行业维度只能靠搜索或你自己的判断补，不要假设本工具知道',
  '估值全部基于本地最新日线收盘价，界面上的价格永远带日期；行情可能滞后',
  '组合区间变化是按当前数量回溯的市值路径，不是资金加权收益率',
]

/** How one concentration band reads in the model's view. */
const CONCENTRATION_LABEL: Readonly<Record<string, string>> = {
  low: '偏低',
  moderate: '中等',
  high: '偏高',
}

const REVIEW_ROW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    symbol: { type: 'string' },
    name: { type: 'string' },
    exchange: { type: 'string' },
    currency: { type: 'string' },
    quantity: { type: 'number' },
    avg_cost: { type: 'number' },
    price: { type: 'number' },
    price_date: { type: 'string' },
    market_value: { type: 'number', description: '折算为基准货币的市值。' },
    cost: { type: 'number', description: '折算为基准货币的成本。' },
    weight: { type: 'number', description: '占组合的比重，0~1。' },
    unrealized_pnl: { type: 'number' },
    unrealized_pct: { type: 'number' },
    day_pnl_pct: { type: 'number' },
    holding_days: { type: 'number' },
    trade_count: { type: 'number' },
    return30_pct: { type: 'number', description: '30 个交易日涨跌幅；日线不足时不给。' },
    volatility20: { type: 'number', description: '20 日年化波动率。' },
    max_drawdown60: { type: 'number', description: '近 60 个交易日最大回撤，正数。' },
    range_position60: { type: 'number', description: '最新收盘在 60 日区间里的位置，0=最低、1=最高。' },
    ma20_gap: { type: 'number', description: '最新收盘相对 20 日均线的偏离。' },
    streak: { type: 'number', description: '连涨（正）或连跌（负）天数。' },
    bars: { type: 'number', description: '本地可用的日线根数。' },
    price_age_days: { type: 'number', description: '最新收盘价距今多少天。' },
  },
  required: ['symbol', 'weight'],
}

const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string', description: '给用户看的一段结论，已经按重要性排好序。' },
    generated_at: { type: 'string' },
    base_currency: { type: 'string' },
    price_date: { type: 'string', description: '组合里最新的一根日线的日期。' },
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
        profit_factor: { type: 'number' },
      },
    },
    window_return_pct: { type: 'number', description: '约一个月的组合市值变化，见 research.limits。' },
    native: {
      type: 'array',
      description: '分币种小计，均为该币种的原始数值，不做折算。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          currency: { type: 'string' },
          market_value: { type: 'number' },
          cost: { type: 'number' },
          unrealized_pnl: { type: 'number' },
          weight: { type: 'number' },
        },
        required: ['currency'],
      },
    },
    holdings: { type: 'array', items: REVIEW_ROW_SCHEMA },
    holdings_truncated: { type: 'boolean' },
    signals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        concentration: { type: 'number', description: '第一重仓的占比。' },
        concentration_symbol: { type: 'string' },
        concentration_label: { type: 'string', enum: ['low', 'moderate', 'high'] },
        top_three: { type: 'number' },
        winners: { type: 'number' },
        losers: { type: 'number' },
        flat: { type: 'number' },
        stale_share: { type: 'number', description: '行情已过期的成本占比。' },
        unpriced: { type: 'number' },
        most_volatile_symbol: { type: 'string' },
        most_volatile: { type: 'number' },
        deepest_drawdown_symbol: { type: 'string' },
        deepest_drawdown: { type: 'number' },
      },
    },
    top_gainers: { type: 'array', items: REVIEW_ROW_SCHEMA },
    top_losers: { type: 'array', items: REVIEW_ROW_SCHEMA },
    by_market: { type: 'array', items: BREAKDOWN_SCHEMA },
    by_motive: {
      type: 'array',
      description: '按交易动机归集的盈亏：已实现记在卖出动机上，浮动按买入动机分摊。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          realized_pnl: { type: 'number' },
          unrealized_pnl: { type: 'number' },
          total_pnl: { type: 'number' },
          trades: { type: 'number' },
        },
        required: ['label'],
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: '已经算好的当下要点。' },
    research: {
      type: 'object',
      description: '第二部分（未来约一个月）的研究清单，由调用方自己去查。',
      additionalProperties: false,
      properties: {
        symbols: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              symbol: { type: 'string' },
              name: { type: 'string' },
              exchange: { type: 'string' },
              weight: { type: 'number' },
              price_date: { type: 'string' },
            },
            required: ['symbol'],
          },
        },
        angles: { type: 'array', items: { type: 'string' } },
        limits: { type: 'array', items: { type: 'string' } },
        next: { type: 'array', items: { type: 'string' } },
      },
    },
    focus: { type: 'string' },
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

/** The tool that reads one symbol's stored series and its holding. */
function symbolDetailTool(service: PortfolioService, deps: PortfolioToolDeps): ToolDefinition {
  return {
    name: SYMBOL_DETAIL_TOOL,
    description: DESCRIPTION_SYMBOL_DETAIL,
    parameters: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '标的代码或名称：600000.SH / 00700.HK / AAPL / 腾讯控股。有歧义时会弹卡片让用户挑。',
        },
        bars: {
          type: 'number',
          description: `返回多少根日线，默认 ${String(DETAIL_BARS)}，最多 ${String(DETAIL_BARS_MAX)}；各窗口指标按自己的长度算，与它无关。`,
        },
      },
      required: ['symbol'],
    },
    output: { schema: DETAIL_OUTPUT_SCHEMA, render: renderSymbolDetail },
    execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      return executeSymbolDetail(args, exec, service, deps)
    },
    presentCall(args: unknown): ToolCallView | undefined {
      try {
        const symbol = textOf(asRecord(args)['symbol'])
        return { card: 'generic', title: `读取 ${symbol ?? '标的'}` }
      } catch {
        return undefined
      }
    },
  }
}

/** The tool that reports the aggregate analysis. */
function analysisTool(service: PortfolioService): ToolDefinition {
  return {
    name: ANALYSIS_TOOL,
    description: DESCRIPTION_ANALYSIS,
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `排行与清仓历史各返回多少行，默认 ${String(RANKING_LIMIT)}，最多 ${String(POSITION_LIMIT)}。`,
        },
      },
    },
    output: { schema: ANALYSIS_OUTPUT_SCHEMA, render: renderAnalysis },
    execute(args: unknown): Promise<unknown> {
      return Promise.resolve(executeAnalysis(args, service))
    },
    presentCall(): ToolCallView {
      return { card: 'generic', title: '分析持仓' }
    },
  }
}

/** The tool that searches the local instrument index. */
function searchTool(service: PortfolioService): ToolDefinition {
  return {
    name: SEARCH_TOOL,
    description: DESCRIPTION_SEARCH,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '代码或名称片段：600000 / 00700.HK / AAPL / 腾讯 / 平安。' },
        limit: {
          type: 'number',
          description: `最多返回多少条，默认 ${String(SEARCH_LIMIT)}，最多 ${String(SEARCH_LIMIT_MAX)}。`,
        },
      },
      required: ['query'],
    },
    output: { schema: SEARCH_OUTPUT_SCHEMA, render: renderSearch },
    execute(args: unknown): Promise<unknown> {
      return executeSearch(args, service)
    },
    presentCall(args: unknown): ToolCallView | undefined {
      try {
        const query = textOf(asRecord(args)['query'])
        return { card: 'generic', title: `检索 ${query ?? '标的'}` }
      } catch {
        return undefined
      }
    },
  }
}

/**
 * Run one portfolio review.
 *
 * The whole point is that this is ONE read: the current picture, the derived
 * findings and the research checklist arrive together, so the reviewing model
 * does not spend four calls reconciling four partial answers. The only reason
 * this is a read rather than a prompt is that the forward-looking half is a
 * research task — the numbers are facts and belong here, the news does not.
 * @param rawArgs - the model's arguments.
 * @param service - the portfolio service.
 * @returns the tool's canonical result value.
 */
function executeReview(rawArgs: unknown, service: PortfolioService): Record<string, unknown> {
  const args = asRecord(rawArgs)
  const focus = textOf(args['focus'])
  const limit = clampLimit(numberOf(args['limit']), REVIEW_LIMIT, POSITION_LIMIT)
  const snapshot: PortfolioReviewSnapshot = service.reviewSnapshot()
  const needle = focus?.toUpperCase() ?? null
  const keeps = (row: ReviewRow): boolean => needle === null
    || row.symbol.toUpperCase().includes(needle)
    || (row.name ?? '').toUpperCase().includes(needle)
  const selected = needle === null ? snapshot.rows : snapshot.rows.filter(keeps)
  const rows = selected.slice(0, limit)

  if (snapshot.rows.length === 0) {
    return {
      ok: true,
      message: '组合里还没有持仓，没有可复盘的标的。先说一笔交易（例如「昨天买了 100 股腾讯」）或直接说想买什么，我再看。',
      generated_at: snapshot.generatedAt,
      base_currency: snapshot.baseCurrency,
      holdings: [],
      holdings_truncated: false,
      notes: [],
      research: { symbols: [], angles: [], limits: [], next: [] },
    }
  }

  const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`
  // One line, not the whole findings list: the findings are rendered directly
  // underneath, and a message that repeats them doubles the model's reading for
  // no extra information.
  const ups = snapshot.totals.unrealizedPnl >= 0 ? '浮盈' : '浮亏'
  const scopeNote = rows.length === snapshot.rows.length
    ? `共 ${String(rows.length)} 只持仓`
    : `列出 ${String(rows.length)} 只（组合共 ${String(snapshot.rows.length)} 只）`
  const message = rows.length === 0
    ? `组合里没有匹配「${focus ?? ''}」的持仓；当前共 ${String(snapshot.rows.length)} 只。`
    : `复盘${focus === null ? '整个组合' : `「${focus}」`}：${scopeNote}，`
      + `市值 ${snapshot.totals.marketValue.toFixed(0)} ${snapshot.baseCurrency}`
      + `（${ups} ${snapshot.totals.unrealizedPnl.toFixed(0)}`
      + `${snapshot.totals.unrealizedPct === null ? '' : `，${pct(snapshot.totals.unrealizedPct)}`}），`
      + `第一重仓占 ${pct(snapshot.signals.concentration)}`
      + `（集中度${CONCENTRATION_LABEL[snapshot.signals.concentrationLabel] ?? '未知'}）；`
      + `行情日期 ${snapshot.priceDate ?? '未知'}，以下是当下数据，未来一个月的走势与催化需要你自己查。`

  return {
    ok: true,
    message,
    generated_at: snapshot.generatedAt,
    base_currency: snapshot.baseCurrency,
    ...snapshot.priceDate === null ? {} : { price_date: snapshot.priceDate },
    totals: {
      market_value: snapshot.totals.marketValue,
      cost: snapshot.totals.cost,
      unrealized_pnl: snapshot.totals.unrealizedPnl,
      realized_pnl: snapshot.totals.realizedPnl,
      total_pnl: snapshot.totals.totalPnl,
      day_pnl: snapshot.totals.dayPnl,
      open_positions: snapshot.totals.openPositions,
      closed_positions: snapshot.totals.closedPositions,
      trade_count: snapshot.totals.tradeCount,
      ...snapshot.totals.unrealizedPct === null ? {} : { unrealized_pct: snapshot.totals.unrealizedPct },
      ...snapshot.totals.dayPnlPct === null ? {} : { day_pnl_pct: snapshot.totals.dayPnlPct },
      ...snapshot.totals.winRate === null ? {} : { win_rate: snapshot.totals.winRate },
      ...snapshot.totals.profitFactor === null ? {} : { profit_factor: snapshot.totals.profitFactor },
    },
    ...snapshot.windowReturnPct === null ? {} : { window_return_pct: snapshot.windowReturnPct },
    native: snapshot.native.map(total => ({
      currency: total.currency,
      market_value: total.marketValue,
      cost: total.cost,
      unrealized_pnl: total.unrealizedPnl,
      weight: total.weight,
    })),
    holdings: rows.map(projectReviewRow),
    holdings_truncated: selected.length > rows.length,
    signals: {
      concentration: snapshot.signals.concentration,
      top_three: snapshot.signals.topThree,
      concentration_label: snapshot.signals.concentrationLabel,
      winners: snapshot.signals.winners,
      losers: snapshot.signals.losers,
      flat: snapshot.signals.flat,
      stale_share: snapshot.signals.staleShare,
      unpriced: snapshot.signals.unpriced,
      ...snapshot.signals.concentrationSymbol === null ? {} : { concentration_symbol: snapshot.signals.concentrationSymbol },
      ...snapshot.signals.mostVolatileSymbol === null ? {} : { most_volatile_symbol: snapshot.signals.mostVolatileSymbol },
      ...snapshot.signals.mostVolatile === null ? {} : { most_volatile: snapshot.signals.mostVolatile },
      ...snapshot.signals.deepestDrawdownSymbol === null
        ? {} : { deepest_drawdown_symbol: snapshot.signals.deepestDrawdownSymbol },
      ...snapshot.signals.deepestDrawdown === null ? {} : { deepest_drawdown: snapshot.signals.deepestDrawdown },
    },
    top_gainers: snapshot.topGainers.map(projectReviewRow),
    top_losers: snapshot.topLosers.map(projectReviewRow),
    by_market: snapshot.byMarket.map(projectBreakdown),
    by_motive: snapshot.byMotive.map(row => ({
      label: row.label,
      realized_pnl: row.realizedPnl,
      unrealized_pnl: row.unrealizedPnl,
      total_pnl: row.totalPnl,
      trades: row.trades,
    })),
    notes: snapshot.notes,
    research: {
      symbols: rows.map(row => ({
        symbol: row.symbol,
        exchange: row.exchange,
        weight: row.weight,
        ...row.name === null ? {} : { name: row.name },
        ...row.priceDate === null ? {} : { price_date: row.priceDate },
      })),
      angles: [...RESEARCH_ANGLES],
      limits: [...snapshot.caveats, ...REVIEW_LIMITS],
      next: [
        `逐只搜「${rows.map(row => row.name ?? row.symbol).join('、')}」的券商目标价 / 评级调整、最近财报或预告日期、公告与管理层变动。`,
        `行业层面搜一次板块近况与主要对手动作${rows.length === 0 ? '' : `（${rows.map(row => row.symbol).join(' / ')} 共占 ${pct(snapshot.signals.topThree)} 仓位）`}。`,
        '每条写清信息日期与来源，区分「已发生」与「预期」；不要给出确定的价格预测，也不要编造工具没返回的数字。',
        '最终回复控制在一屏内：先当下结论与风险，再一个月视角的催化与变量，最后一句免责。',
      ],
    },
    ...needle === null ? {} : { focus: focus ?? '' },
  }
}

/** The tool that reviews the portfolio as one read. */
function reviewTool(service: PortfolioService): ToolDefinition {
  return {
    name: REVIEW_TOOL,
    description: DESCRIPTION_REVIEW,
    parameters: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: '只复盘这一只（代码或名称片段）；不传就是整个组合。复盘整个组合时留空。',
        },
        limit: {
          type: 'number',
          description: `最多返回多少行持仓，默认 ${String(REVIEW_LIMIT)}，最多 ${String(POSITION_LIMIT)}。`,
        },
      },
    },
    output: { schema: REVIEW_OUTPUT_SCHEMA, render: renderReview },
    execute(args: unknown): Promise<unknown> {
      return Promise.resolve(executeReview(args, service))
    },    presentCall(args: unknown): ToolCallView | undefined {
      try {
        const focus = textOf(asRecord(args)['focus'])
        return { card: 'generic', title: focus === null ? '复盘持仓' : `复盘 ${focus}` }
      } catch {
        return undefined
      }
    },
  }
}

/** The consent-gated tool that reads the trade log's rows. */
function listTradesTool(service: PortfolioService, deps: PortfolioToolDeps): ToolDefinition {  return {
    name: LIST_TRADES_TOOL,
    description: DESCRIPTION_LIST_TRADES,
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只看这一个标的（代码或名称片段）；不传就是全部。' },
        side: { type: 'string', enum: ['buy', 'sell'], description: '只看买入或只看卖出；不传就是两边都要。' },
        since: { type: 'string', description: '起始成交日期 YYYY-MM-DD；「今天」「昨天」也可以。' },
        until: { type: 'string', description: '结束成交日期 YYYY-MM-DD。' },
        limit: {
          type: 'number',
          description: `最多返回多少笔（最近的优先），默认 ${String(TRADE_LIMIT)}，最多 ${String(TRADE_LIMIT_MAX)}。`,
        },
      },
    },
    output: { schema: TRADES_OUTPUT_SCHEMA, render: renderTrades },
    execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      return executeListTrades(args, exec, service, deps)
    },
    presentCall(): ToolCallView {
      return { card: 'generic', title: '读取交易记录' }
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
    lines.push(closedLine(asRecord(cleared)))
  }
  if (result['positions_truncated'] === true) lines.push('（持仓行多于这里列出的数量，已截断）')

  for (const note of stringList(result['notes'])) lines.push(`· ${note}`)
  lines.push(...questionLines(result))
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * What the model reads as one symbol's read result.
 *
 * Same contract as {@link renderResult}: the series and the indicator block have
 * to be spelled out here, because this projection is the model's entire view.
 */
function renderSymbolDetail(_args: unknown, value: unknown): readonly TextBlock[] {
  const result = asRecord(value)
  const lines: string[] = []
  const message = textOf(result['message'])
  if (message !== null) lines.push(message)

  const position = asRecord(result['position'])
  if (Object.keys(position).length > 0) lines.push(positionLine(position))
  for (const cleared of Array.isArray(result['closed']) ? result['closed'] : []) {
    lines.push(closedLine(asRecord(cleared)))
  }
  const history = asRecord(result['history'])
  if (Object.keys(history).length > 0) {
    const summary = historyLine(history)
    if (summary !== '') lines.push(summary)
  }
  const bars = Array.isArray(result['recent_bars']) ? result['recent_bars'] : []
  if (bars.length > 0) {
    const tail = bars.map(entry => {
      const bar = asRecord(entry)
      return `${(textOf(bar['date']) ?? '').slice(5)} ${plain(numberValue(bar['close']))}`
    })
    lines.push(`最近 ${String(bars.length)} 个交易日收盘：${tail.join(' · ')}`)
  }
  if (result['bars_truncated'] === true) lines.push('（可能还有更早的日线，需要更长窗口就把 bars 调大）')
  for (const row of Array.isArray(result['matches']) ? result['matches'] : []) {
    lines.push(matchLine(asRecord(row)))
  }
  for (const note of stringList(result['notes'])) lines.push(`· ${note}`)
  lines.push(...questionLines(result))
  return [{ type: 'text', text: lines.join('\n') }]
}

/** What the model reads as the aggregate analysis. */
function renderAnalysis(_args: unknown, value: unknown): readonly TextBlock[] {
  const result = asRecord(value)
  const lines: string[] = []
  const message = textOf(result['message'])
  if (message !== null) lines.push(message)

  const ratios = asRecord(result['ratios'])
  const extras: string[] = []
  if (typeof ratios['avg_win'] === 'number') extras.push(`平均盈利 ${money(ratios['avg_win'])}`)
  if (typeof ratios['avg_loss'] === 'number') extras.push(`平均亏损 ${money(ratios['avg_loss'])}`)
  if (typeof ratios['profit_factor'] === 'number') extras.push(`盈亏比 ${ratios['profit_factor'].toFixed(2)}`)
  if (typeof ratios['best_symbol'] === 'string') extras.push(`最好 ${ratios['best_symbol']}`)
  if (typeof ratios['worst_symbol'] === 'string') extras.push(`最差 ${ratios['worst_symbol']}`)
  if (extras.length > 0) lines.push(extras.join(' · '))

  const sections: readonly [string, string][] = [
    ['by_motive', '按动机（已实现记在卖出动机，浮动按买入动机的成本占比分摊）'],
    ['by_market', '按市场'],
  ]
  for (const [key, title] of sections) {
    const rows = Array.isArray(result[key]) ? result[key] : []
    if (rows.length === 0) continue
    lines.push(`${title}：`)
    for (const entry of rows) lines.push(`- ${breakdownLine(asRecord(entry))}`)
  }
  const ranking = Array.isArray(result['ranking']) ? result['ranking'] : []
  if (ranking.length > 0) {
    lines.push('标的表现排行（合计 = 已实现 + 浮动）：')
    for (const entry of ranking) {
      const row = asRecord(entry)
      const name = textOf(row['name'])
      const weight = typeof row['weight'] === 'number' ? ` · 仓位 ${(row['weight'] * 100).toFixed(1)}%` : ''
      lines.push(`- ${textOf(row['symbol']) ?? ''}${name === null ? '' : ` ${name}`}`
        + `：已实现 ${signed(numberValue(row['realized_pnl']))}`
        + `${typeof row['unrealized_pnl'] === 'number' ? ` · 浮动 ${signed(row['unrealized_pnl'])}` : ''}`
        + ` · 合计 ${signed(numberValue(row['total_pnl']))}${weight}`)
    }
  }
  for (const cleared of Array.isArray(result['closed']) ? result['closed'] : []) {
    lines.push(closedLine(asRecord(cleared)))
  }
  const ratesNote = textOf(result['rates_note'])
  if (ratesNote !== null) lines.push(`· ${ratesNote}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** One review holding as a line of the model's view. */
function reviewRowLine(row: Record<string, unknown>): string {
  const name = textOf(row['name'])
  const parts: string[] = [
    `${textOf(row['symbol']) ?? ''}${name === null ? '' : ` ${name}`}`,
    `仓位 ${(numberValue(row['weight']) * 100).toFixed(1)}%`,
    `浮动 ${signed(numberValue(row['unrealized_pnl']))}`,
  ]
  if (typeof row['unrealized_pct'] === 'number') parts.push(percent(row['unrealized_pct']))
  if (typeof row['price'] === 'number') {
    parts.push(`现价 ${plain(row['price'])}${textOf(row['price_date']) === null ? '' : `（${textOf(row['price_date']) ?? ''}）`}`)
  }
  if (typeof row['return30_pct'] === 'number') parts.push(`30 日 ${percent(row['return30_pct'])}`)
  if (typeof row['volatility20'] === 'number') parts.push(`波动率 ${(row['volatility20'] * 100).toFixed(1)}%`)
  if (typeof row['max_drawdown60'] === 'number') parts.push(`60 日回撤 ${(row['max_drawdown60'] * 100).toFixed(1)}%`)
  if (typeof row['ma20_gap'] === 'number') parts.push(`20 日均线偏离 ${percent(row['ma20_gap'])}`)
  if (typeof row['holding_days'] === 'number') parts.push(`持有 ${String(row['holding_days'])} 天`)
  return `- ${parts.join(' · ')}`
}

/**
 * What the model reads as a portfolio review.
 *
 * Same contract as {@link renderResult}: the rows and the derived findings have
 * to be spelled out here, because this projection is the model's entire view.
 * The research block is the exception — it is instructions for the caller, so
 * it states the scope and the angles rather than anything about the portfolio.
 */
function renderReview(_args: unknown, value: unknown): readonly TextBlock[] {
  const result = asRecord(value)
  const lines: string[] = []
  const message = textOf(result['message'])
  if (message !== null) lines.push(message)

  const totals = asRecord(result['totals'])
  if (Object.keys(totals).length > 0) {
    lines.push(`基准货币 ${textOf(result['base_currency']) ?? ''}`
      + ` · 市值 ${money(numberValue(totals['market_value']))}`
      + ` · 成本 ${money(numberValue(totals['cost']))}`
      + ` · 浮动 ${signed(numberValue(totals['unrealized_pnl']))}`
      + ` · 已实现 ${signed(numberValue(totals['realized_pnl']))}`
      + ` · 当日 ${signed(numberValue(totals['day_pnl']))}`
      + `${typeof totals['unrealized_pct'] === 'number' ? ` · 浮动比例 ${percent(totals['unrealized_pct'])}` : ''}`)
  }
  for (const entry of Array.isArray(result['native']) ? result['native'] : []) {
    const row = asRecord(entry)
    lines.push(`${textOf(row['currency']) ?? ''}：市值 ${money(numberValue(row['market_value']))}`
      + ` · 成本 ${money(numberValue(row['cost']))}`
      + ` · 浮动 ${signed(numberValue(row['unrealized_pnl']))}`
      + ` · 占比 ${(numberValue(row['weight']) * 100).toFixed(1)}%`)
  }
  if (typeof result['window_return_pct'] === 'number') {
    lines.push(`最近约一个月的组合市值变化：${percent(result['window_return_pct'])}`)
  }

  const signals = asRecord(result['signals'])
  if (Object.keys(signals).length > 0) {
    const findings: string[] = []
    if (typeof signals['concentration'] === 'number') {
      findings.push(`第一重仓 ${textOf(signals['concentration_symbol']) ?? ''}`
        + ` ${percent(signals['concentration'])}`
        + `（集中度${CONCENTRATION_LABEL[textOf(signals['concentration_label']) ?? ''] ?? '未知'}）`)
    }
    if (typeof signals['top_three'] === 'number') findings.push(`前三合计 ${percent(signals['top_three'])}`)
    findings.push(`浮盈 ${plain(numberValue(signals['winners']))} / 浮亏 ${plain(numberValue(signals['losers']))} / 持平 ${plain(numberValue(signals['flat']))}`)
    if (typeof signals['most_volatile'] === 'number') {
      findings.push(`波动最大 ${textOf(signals['most_volatile_symbol']) ?? ''} ${(signals['most_volatile'] * 100).toFixed(1)}%`)
    }
    if (typeof signals['deepest_drawdown'] === 'number') {
      findings.push(`回撤最深 ${textOf(signals['deepest_drawdown_symbol']) ?? ''} ${(signals['deepest_drawdown'] * 100).toFixed(1)}%`)
    }
    if (typeof signals['stale_share'] === 'number' && signals['stale_share'] > 0) {
      findings.push(`行情过期成本占比 ${(signals['stale_share'] * 100).toFixed(0)}%`)
    }
    lines.push(findings.join(' · '))
  }

  const holdings = Array.isArray(result['holdings']) ? result['holdings'] : []
  if (holdings.length > 0) {
    lines.push('持仓：')
    for (const entry of holdings) lines.push(reviewRowLine(asRecord(entry)))
  }
  if (result['holdings_truncated'] === true) lines.push('（还有更多持仓没列出）')

  for (const key of ['top_gainers', 'top_losers'] as const) {
    const rows = Array.isArray(result[key]) ? result[key] : []
    if (rows.length === 0) continue
    lines.push(`${key === 'top_gainers' ? '浮盈最多' : '浮亏最多'}：`)
    for (const entry of rows) lines.push(reviewRowLine(asRecord(entry)))
  }
  for (const entry of Array.isArray(result['by_market']) ? result['by_market'] : []) {
    lines.push(breakdownLine(asRecord(entry)))
  }
  for (const entry of Array.isArray(result['by_motive']) ? result['by_motive'] : []) {
    const row = asRecord(entry)
    lines.push(`动机「${textOf(row['label']) ?? ''}」：${plain(numberValue(row['trades']))} 笔`
      + ` · 已实现 ${signed(numberValue(row['realized_pnl']))}`
      + ` · 浮动 ${signed(numberValue(row['unrealized_pnl']))}`
      + ` · 合计 ${signed(numberValue(row['total_pnl']))}`)
  }
  for (const note of stringList(result['notes'])) lines.push(`· ${note}`)

  const research = asRecord(result['research'])
  const scope = Array.isArray(research['symbols']) ? research['symbols'] : []
  if (scope.length > 0) {
    lines.push('第二部分（未来约一个月）的研究范围：')
    for (const entry of scope) {
      const row = asRecord(entry)
      const name = textOf(row['name'])
      lines.push(`- ${textOf(row['symbol']) ?? ''}${name === null ? '' : ` ${name}`}`
        + ` · 仓位 ${(numberValue(row['weight']) * 100).toFixed(1)}%`)
    }
  }
  for (const angle of stringList(research['angles'])) lines.push(`· 查：${angle}`)
  for (const limit of stringList(research['limits'])) lines.push(`· 注意：${limit}`)
  for (const step of stringList(research['next'])) lines.push(`· 下一步：${step}`)

  return [{ type: 'text', text: lines.join('\n') }]
}

/** What the model reads as an index search. */
function renderSearch(_args: unknown, value: unknown): readonly TextBlock[] {  const result = asRecord(value)
  const lines: string[] = []
  const message = textOf(result['message'])
  if (message !== null) lines.push(message)
  for (const row of Array.isArray(result['matches']) ? result['matches'] : []) {
    lines.push(matchLine(asRecord(row)))
  }
  if (result['truncated'] === true) lines.push('（命中多于这里列出的数量，已截断）')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** What the model reads as a trade-log read, consent or no consent. */
function renderTrades(_args: unknown, value: unknown): readonly TextBlock[] {
  const result = asRecord(value)
  const lines: string[] = []
  const message = textOf(result['message'])
  if (message !== null) lines.push(message)
  for (const entry of Array.isArray(result['trades']) ? result['trades'] : []) {
    const row = asRecord(entry)
    const name = textOf(row['name'])
    const motive = textOf(row['motive'])
    const note = textOf(row['note'])
    lines.push(`#${plain(numberValue(row['id']))} ${textOf(row['traded_at']) ?? ''} `
      + `${row['side'] === 'sell' ? '卖出' : '买入'} ${textOf(row['symbol']) ?? ''}`
      + `${name === null ? '' : ` ${name}`} ${plain(numberValue(row['quantity']))} @ `
      + `${plain(numberValue(row['price']))} ${textOf(row['currency']) ?? ''}`
      + `${motive === null ? '' : `（动机：${motive}）`}${note === null ? '' : ` · ${note}`}`)
  }
  if (result['truncated'] === true) lines.push('（交易记录多于这里列出的数量，已截断）')
  for (const note of stringList(result['notes'])) lines.push(`· ${note}`)
  lines.push(...questionLines(result))
  return [{ type: 'text', text: lines.join('\n') }]
}

/** The open questions restated for the calling model, if there are any. */
function questionLines(result: Record<string, unknown>): string[] {
  const lines: string[] = []
  const questions = Array.isArray(result['questions']) ? result['questions'] : []
  if (questions.length === 0) return lines
  lines.push('需要向用户确认：')
  for (const entry of questions) {
    const question = asRecord(entry)
    const labels = (Array.isArray(question['options']) ? question['options'] : [])
      .map(option => textOf(asRecord(option)['label']))
      .filter((label): label is string => label !== null)
    lines.push(`- [${textOf(question['id']) ?? ''}] ${textOf(question['question']) ?? ''}`
      + `${labels.length === 0 ? '' : ` 选项：${labels.join(' / ')}`}`)
  }
  return lines
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

/** One cleared episode as a line of the model's view. */
function closedLine(row: Record<string, unknown>): string {
  return `（已清仓）${textOf(row['symbol']) ?? ''} ${textOf(row['name']) ?? ''}：`
    + `${textOf(row['opened_at']) ?? ''} → ${textOf(row['closed_at']) ?? ''}`
    + ` · 已实现 ${signed(numberValue(row['realized_pnl']))} ${textOf(row['currency']) ?? ''}`
}

/** One index hit as a line of the model's view. */
function matchLine(row: Record<string, unknown>): string {
  const name = textOf(row['name'])
  const type = textOf(row['type'])
  return `- ${textOf(row['symbol']) ?? ''}${name === null ? '' : ` ${name}`}`
    + ` · ${textOf(row['exchange']) ?? ''} · ${textOf(row['currency']) ?? ''}`
    + `${type === null ? '' : ` · ${type}`}`
}

/** One grouped breakdown row as a line of the model's view. */
function breakdownLine(row: Record<string, unknown>): string {
  return `${textOf(row['label']) ?? ''}：${plain(numberValue(row['trades']))} 笔`
    + ` · 已实现 ${signed(numberValue(row['realized_pnl']))}`
    + ` · 浮动 ${signed(numberValue(row['unrealized_pnl']))}`
    + ` · 合计 ${signed(numberValue(row['total_pnl']))}`
    + ` · 市值 ${money(numberValue(row['market_value']))}`
}

/**
 * The indicator block as one line.
 *
 * Every window is independent: a short series answers what it can and leaves the
 * rest out, and this line simply does not mention what is not there.
 */
function historyLine(history: Record<string, unknown>): string {
  const parts: string[] = []
  const windows = (Array.isArray(history['returns']) ? history['returns'] : []).map(entry => {
    const period = asRecord(entry)
    const pct = typeof period['pct'] === 'number' ? period['pct'] : null
    return `${plain(numberValue(period['days']))} 日 ${pct === null ? '—' : percent(pct)}`
  })
  if (windows.length > 0) parts.push(windows.join(' / '))

  const ma20 = typeof history['ma20'] === 'number' ? history['ma20'] : null
  const gap = typeof history['ma20_gap'] === 'number' ? history['ma20_gap'] : null
  if (ma20 !== null) parts.push(`20 日均线 ${plain(ma20)}${gap === null ? '' : `（偏离 ${percent(gap)}）`}`)
  const volatility = typeof history['volatility20'] === 'number' ? history['volatility20'] : null
  if (volatility !== null) parts.push(`20 日波动率 ${(volatility * 100).toFixed(2)}%`)
  const volumeRatio = typeof history['volume_ratio'] === 'number' ? history['volume_ratio'] : null
  if (volumeRatio !== null) parts.push(`量比 ${volumeRatio.toFixed(2)}`)
  const drawdown = typeof history['max_drawdown60'] === 'number' ? history['max_drawdown60'] : null
  if (drawdown !== null) parts.push(`60 日最大回撤 ${(drawdown * 100).toFixed(2)}%`)
  const high = typeof history['high60'] === 'number' ? history['high60'] : null
  const low = typeof history['low60'] === 'number' ? history['low60'] : null
  const where = typeof history['range_position60'] === 'number' ? history['range_position60'] : null
  if (high !== null && low !== null) {
    parts.push(`60 日区间 ${plain(low)}—${plain(high)}`
      + `${where === null ? '' : `（位置 ${(where * 100).toFixed(0)}%）`}`)
  }
  const streak = typeof history['streak'] === 'number' ? history['streak'] : 0
  if (streak > 0) parts.push(`连涨 ${String(streak)} 天`)
  if (streak < 0) parts.push(`连跌 ${String(-streak)} 天`)
  return parts.join(' · ')
}

/**
 * Build the tools this plugin contributes to the chat.
 *
 * Returned rather than registered so a test can drive `execute` directly, and so
 * the composition step stays a two-line decision. The order is the order the
 * model sees them in: the two that write and summarize, then the three reads
 * that need no permission, then the one read that does.
 * @param service - the portfolio service.
 * @param deps - the tool's capabilities.
 * @returns the registry-ready definitions, in a stable order.
 */
export function createPortfolioTools(
  service: PortfolioService,
  deps: PortfolioToolDeps = {},
): readonly ToolDefinition[] {
  return [
    addTradeTool(service, deps),
    overviewTool(service),
    symbolDetailTool(service, deps),
    analysisTool(service),
    reviewTool(service),
    searchTool(service),
    listTradesTool(service, deps),
  ]
}

/**
 * Publish the chat tools into the running harness.
 *
 * Registration happens once per plugin load and is undone with the plugin: the
 * disposable returned by `tools.register` is owned by the plugin's own effect
 * scope, so a reload, a stop or an uninstall leaves no tool behind.
 *
 * ## Why this waits instead of sampling
 *
 * `ctx.get('tools')` is a ONE-TIME read, and a Loader row may be applied before
 * the row that provides the registry. Sampling once therefore does not degrade
 * gracefully, it silently registers nothing at all — and the failure mode is
 * invisible: the panel and the slash command keep working, so the only symptom
 * is a model that says it cannot review the portfolio. That is exactly what a
 * cold start produced, while a hot reload (applied after the registry already
 * existed) looked fine.
 *
 * `ctx.inject` is the harness's own optional-registration path for this: the
 * callback runs as soon as the service appears, and immediately when it is
 * already there. The synchronous lookup below is only the diagnostic — it fires
 * while a miss still means something, rather than after a delay that would also
 * be reached the moment a late registry arrives.
 * @param ctx - the plugin context.
 * @param service - the portfolio service.
 */
export function registerPortfolioTools(ctx: Context, service: PortfolioService): void {
  if (ctx.get('tools') === undefined) {
    // A composition that has not mounted the registry YET is the common case
    // here, so this is a note rather than a failure; a composition that never
    // mounts one is the legitimate headless case.
    console.warn('[stock-portfolio] tool registry is not up yet; the chat tools will register when it is')
  }
  ctx.inject(['tools'], (scope: Context) => {
    const tools = scope.get('tools') as ToolRegistry | undefined
    if (tools === undefined) return
    const userQuestions = scope.get('userQuestions') as UserQuestionsCapability | undefined
    for (const tool of createPortfolioTools(service, { userQuestions })) {
      scope.effect(() => tools.register(tool), `stock-portfolio: tool ${tool.name}`)
    }
  })
}
