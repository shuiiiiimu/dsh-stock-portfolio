/**
 * The chat tools: recording a trade out of a conversation.
 *
 * The answerer is a stub, so every case here is about the plugin's own
 * behaviour — what it asks for, what it does with the answer, and what it leaves
 * in the database — rather than about whichever UI happens to be mounted.
 *
 * The market is stubbed twice over: the service is handed a `fetch` that answers
 * 404 to everything (so an accidental network call is a silent no-op instead of
 * a test that depends on TickFlow's uptime), and the prices the cases assert on
 * are seeded straight into SQLite.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  ADD_TRADE_TOOL, ANALYSIS_TOOL, LIST_TRADES_TOOL, OVERVIEW_TOOL, SEARCH_TOOL, SYMBOL_DETAIL_TOOL,
  PortfolioService, createPortfolioTools, registerPortfolioTools,
} from '../lib/index.js'

/** Noon on a fixed local day: every relative-date assertion is timezone-proof. */
const NOW = new Date(2026, 8, 11, 12, 0, 0)

/** The instrument index the cases search. */
const INSTRUMENTS = [
  { symbol: '600000.SH', exchange: 'SH', code: '600000', name: '浦发银行', type: 'stock', currency: 'CNY' },
  { symbol: '000001.SZ', exchange: 'SZ', code: '000001', name: '平安银行', type: 'stock', currency: 'CNY' },
  { symbol: '00700.HK', exchange: 'HK', code: '00700', name: '腾讯控股', type: 'stock', currency: 'HKD' },
  { symbol: 'AAPL.US', exchange: 'US', code: 'AAPL', name: '苹果', type: 'stock', currency: 'USD' },
]

/** Two stored closes for the symbol the price question offers. */
const PRICES = [
  { symbol: '00700.HK', date: '2026-09-09', open: 425.6, high: 425.6, low: 425.6, close: 425.6, volume: 1000, amount: 0 },
  { symbol: '00700.HK', date: '2026-09-10', open: 428.4, high: 428.4, low: 428.4, close: 428.4, volume: 1000, amount: 0 },
]

/** Everything the cases opened, torn down when the file finishes. */
const services = []
const dirs = []

/**
 * Build a service over a throwaway database, with the index and one close seeded.
 * @returns the service.
 */
function makeService() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsp-tool-'))
  dirs.push(dataDir)
  const service = new PortfolioService({
    dataDir,
    fetchImpl: async () => new Response('not found', { status: 404 }),
    dotenvPath: join(dataDir, '.env'),
    now: () => NOW,
  })
  services.push(service)
  service.db.upsertInstruments(INSTRUMENTS)
  service.db.upsertPrices(PRICES)
  return service
}

/**
 * A `ctx.userQuestions` stand-in.
 * @param script - the answers to return, or a function of the request.
 * @returns the capability and the requests it received.
 */
function answerer(script) {
  const asked = []
  return {
    asked,
    capability: {
      async ask(request) {
        asked.push(request)
        return { answers: typeof script === 'function' ? script(request) : script }
      },
    },
  }
}

/**
 * A `ctx.userQuestions` stand-in that fails the way a subagent's would.
 * @param code - the `UserQuestionError` code to throw.
 * @returns the capability.
 */
function refusing(code) {
  return { async ask() { throw Object.assign(new Error(code), { code }) } }
}

/** A real abort signal: the tools forward it to the answerer. */
const SIGNAL = new AbortController().signal

/**
 * Call one tool and check its own output contract.
 *
 * The registry validates every successful value against `output.schema` before
 * the model sees it, so a schema that rejects its tool's own value is a runtime
 * failure with no test-time symptom. Validating here is what keeps the two in
 * step.
 * @param tools - the definitions.
 * @param name - the tool to call.
 * @param args - the model's arguments.
 * @param exec - execution extras, such as a calling agent.
 * @returns the canonical value.
 */
async function run(tools, name, args, exec = {}) {
  const tool = tools.find(candidate => candidate.name === name)
  assert.ok(tool !== undefined, `no tool named ${name}`)
  const value = await tool.execute(args, { signal: SIGNAL, ...exec })
  assert.deepEqual(validate(tool.output.schema, value), [], `${name} result violates output.schema`)
  const blocks = tool.output.render(args, value)
  assert.ok(Array.isArray(blocks) && typeof blocks[0].text === 'string')
  tool.presentCall?.(args)
  return value
}

/**
 * Call one tool and return the text the model would actually read.
 *
 * The rendered blocks are the model's whole view of a result — the canonical
 * value is validated and rendered, and never reaches it — so a row that exists
 * only in the returned object is a row the model cannot talk about.
 * @param tools - the definitions.
 * @param name - the tool to call.
 * @param args - the model's arguments.
 * @returns the joined text of every rendered block.
 */
async function view(tools, name, args) {
  const tool = tools.find(candidate => candidate.name === name)
  assert.ok(tool !== undefined, `no tool named ${name}`)
  const value = await tool.execute(args, { signal: SIGNAL })
  return tool.output.render(args, value).map(block => block.text).join('\n')
}

// ─── a schema checker for the enforced subset ────────────────────────────────
//
// The harness enforces a small JSON Schema subset on tool outputs, and the
// plugin cannot import its validator (it is not a dependency of this package).
// The subset is small enough to restate exactly, which is what these two
// functions do: `schemaViolations` proves a declared schema is inside it, and
// `validate` proves a returned value satisfies that schema.

/** Keywords the subset accepts, from `assertSupportedJsonSchema`. */
const KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

/**
 * Check that one schema node stays inside the enforced subset.
 * @param schema - the node.
 * @param path - where it sits, for the message.
 * @returns the violations.
 */
function schemaViolations(schema, path = 'schema') {
  const violations = []
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${path}: must be an object`]
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) violations.push(`${path}.${key}: unsupported keyword`)
  }
  if (schema.oneOf !== undefined) {
    if (schema.type !== undefined) violations.push(`${path}: oneOf and type cannot combine`)
    schema.oneOf.forEach((branch, index) => {
      violations.push(...schemaViolations(branch, `${path}.oneOf[${index}]`))
    })
  }
  if (schema.type === 'object') {
    if (typeof schema.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties: object nodes must declare it explicitly`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      violations.push(...schemaViolations(child, `${path}.properties.${key}`))
    }
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(schema.properties ?? {}, name)) {
        violations.push(`${path}.required: "${name}" is not a declared property`)
      }
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    violations.push(...schemaViolations(schema.items, `${path}.items`))
  }
  return violations
}

/**
 * Check one value against one schema node.
 * @param schema - the node.
 * @param value - the value.
 * @param path - where it sits, for the message.
 * @returns the violations.
 */
function validate(schema, value, path = 'value') {
  const violations = []
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.filter(branch => validate(branch, value, path).length === 0)
    if (matched.length !== 1) violations.push(`${path}: oneOf matched ${matched.length} branches`)
    return violations
  }
  const type = schema.type
  if (type !== undefined && !hasType(type, value)) return [`${path}: expected ${type}, got ${typeof value}`]
  if (schema.const !== undefined && value !== schema.const) violations.push(`${path}: expected const`)
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(`${path}: ${JSON.stringify(value)} is outside the enum`)
  }
  if (type === 'object' && value !== null && typeof value === 'object') {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) violations.push(`${path}.${name}: required key is missing`)
    }
    for (const [key, child] of Object.entries(value)) {
      const property = (schema.properties ?? {})[key]
      if (property === undefined) {
        if (schema.additionalProperties === false) violations.push(`${path}.${key}: undeclared key`)
        continue
      }
      violations.push(...validate(property, child, `${path}.${key}`))
    }
  }
  if (type === 'array' && Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      violations.push(...validate(schema.items, item, `${path}[${index}]`))
    })
  }
  return violations
}

/**
 * Whether a value is of one JSON Schema type.
 * @param type - the declared type.
 * @param value - the value.
 * @returns true when it matches.
 */
function hasType(type, value) {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return Number.isInteger(value)
  return typeof value === type
}

after(() => {
  for (const service of services) service.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// ─── recording a trade ───────────────────────────────────────────────────────

test('a fully dictated trade is written without asking anything', async () => {
  const service = makeService()
  const { capability, asked } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, {
    symbol: '腾讯',
    side: '买入',
    quantity: 100,
    price: 430,
    traded_at: '昨天',
    motive: '回调加仓',
  })

  assert.equal(asked.length, 0, 'nothing was missing, so nothing may be asked')
  assert.equal(result.ok, true)
  assert.equal(result.trade.symbol, '00700.HK')
  assert.equal(result.trade.name, '腾讯控股')
  assert.equal(result.trade.currency, 'HKD')
  assert.equal(result.trade.side, 'buy')
  assert.equal(result.trade.traded_at, '2026-09-10')
  assert.equal(result.trade.price, 430)
  assert.equal(result.position.quantity, 100)
  assert.match(result.message, /已记录交易 #1/)
  assert.match(result.message, /腾讯控股/)
  assert.equal(service.db.listTrades().length, 1)
})

test('what the sentence left out is asked once, in one card', async () => {
  const service = makeService()
  const { capability, asked } = answerer([
    { id: 'side', selected: ['买入'] },
    { id: 'quantity', custom: '200' },
    { id: 'price', selected: ['使用最新收盘价 428.4（2026-09-10）'] },
    { id: 'traded_at', selected: ['昨天（2026-09-10）'] },
    { id: 'motive', selected: ['定投'] },
  ])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, { symbol: '00700.HK' })

  assert.equal(asked.length, 1, 'one card, not one question at a time')
  assert.deepEqual(
    asked[0].questions.map(question => question.id),
    ['side', 'quantity', 'price', 'traded_at', 'motive'],
  )
  const price = asked[0].questions.find(question => question.id === 'price')
  assert.match(price.options[0].label, /最新收盘价 428\.4（2026-09-10）/)
  const date = asked[0].questions.find(question => question.id === 'traded_at')
  assert.deepEqual(date.options.map(option => option.label), ['今天（2026-09-11）', '昨天（2026-09-10）'])

  assert.equal(result.ok, true)
  assert.deepEqual(result.asked, ['side', 'quantity', 'price', 'traded_at', 'motive'])
  assert.equal(result.trade.price, 428.4, 'the latest close the option named')
  assert.equal(result.trade.quantity, 200)
  assert.equal(result.trade.motive, '定投')
  assert.equal(result.trade.traded_at, '2026-09-10')
  assert.equal(result.position.market_value, 85680, 'the stored close values the answered price')
  assert.deepEqual(result.asked, ['side', 'quantity', 'price', 'traded_at', 'motive'])
  assert.equal(result.trade.price, 428.4, 'the latest close the option named')
  assert.equal(result.trade.quantity, 200)
  assert.equal(result.trade.motive, '定投')
  assert.equal(result.trade.traded_at, '2026-09-10')
})

test('the motive is asked with the direction\'s quick picks, and may be declined', async () => {
  const service = makeService()
  const { capability, asked } = answerer([{ id: 'motive', selected: ['不记录动机'] }])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, {
    symbol: 'AAPL.US', side: 'sell', quantity: 5, price: 300, traded_at: '2026-09-10',
  })

  assert.deepEqual(asked[0].questions.map(question => question.id), ['motive'])
  assert.ok(asked[0].questions[0].options.some(option => option.label === '止盈'))
  assert.ok(asked[0].questions[0].options.some(option => option.label === '不记录动机'))
  assert.equal(result.ok, false, 'there is nothing to sell')
  assert.match(result.message, /超过了当时持有/)
})

test('ask_motive: false lets a bulk entry through without a card', async () => {
  const service = makeService()
  const { capability, asked } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, {
    symbol: '600000', side: 'buy', quantity: 1000, price: 9.26, traded_at: '2026-09-10', ask_motive: false,
  })

  assert.equal(asked.length, 0)
  assert.equal(result.ok, true)
  assert.equal(result.trade.symbol, '600000.SH')
  assert.equal(result.trade.motive, undefined)
})

test('an ambiguous name becomes candidate options, and the pick is adopted', async () => {
  const service = makeService()
  const { capability, asked } = answerer(request => {
    const options = request.questions.find(question => question.id === 'symbol').options
    return [
      { id: 'symbol', selected: [options[1].label] },
      { id: 'side', selected: ['买入'] },
      { id: 'quantity', custom: '100 股' },
      { id: 'price', custom: '11.5 元' },
      { id: 'traded_at', custom: '2026-09-10' },
      { id: 'motive', custom: '' },
    ]
  })
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, { symbol: '银行' })

  const symbolQuestion = asked[0].questions.find(question => question.id === 'symbol')
  assert.deepEqual(symbolQuestion.options.map(option => option.label), [
    '000001.SZ  平安银行',
    '600000.SH  浦发银行',
  ])
  assert.equal(result.trade.symbol, '600000.SH', 'the label the user picked')
  assert.equal(result.trade.name, '浦发银行')
  assert.equal(result.trade.quantity, 100, 'a typed answer keeps its unit out of the number')
  assert.equal(result.trade.price, 11.5)
  assert.equal(result.trade.motive, undefined, 'an empty custom answer is not a motive')
})

test('a bare code the index does not carry is inferred by shape', async () => {
  const service = makeService()
  const { capability } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, {
    symbol: '002594', side: 'buy', quantity: 100, price: 250, traded_at: '2026-09-01', ask_motive: false,
  })

  assert.equal(result.trade.symbol, '002594.SZ')
  assert.ok(result.notes.some(note => note.includes('按代码形状推断')))
})

test('an unresolvable name is asked for in free text, and reported when unreadable', async () => {
  const service = makeService()
  const { capability, asked } = answerer([{ id: 'symbol', custom: '我也不知道' }])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, { symbol: '阿拉丁控股' })

  assert.deepEqual(
    asked[0].questions.map(question => question.id),
    ['symbol', 'side', 'quantity', 'price', 'traded_at', 'motive'],
    'one card carries everything that is open, the unknown symbol included',
  )
  assert.equal(asked[0].questions[0].options, undefined, 'nothing to offer, so the user types')
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['symbol', 'side', 'quantity', 'price', 'traded_at'])
  assert.ok(result.notes.some(note => note.includes('无法把「我也不知道」识别成标的')))
  assert.equal(service.db.listTrades().length, 0)
})

test('a composition with no answerer returns the questions instead of writing', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, { symbol: '00700.HK' })

  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['side', 'quantity', 'price', 'traded_at'])
  assert.deepEqual(result.missing_labels, ['方向', '数量', '价格', '成交日期'])
  assert.match(result.message, /ask_user_question/)
  assert.deepEqual(
    result.questions.map(question => question.id),
    ['side', 'quantity', 'price', 'traded_at', 'motive'],
  )
  assert.equal(result.questions[2].options[0].label, '使用最新收盘价 428.4（2026-09-10）')
  assert.equal(service.db.listTrades().length, 0)

  const text = await view(tools, ADD_TRADE_TOOL, { symbol: '00700.HK' })
  assert.match(text, /需要向用户确认：/)
  assert.match(text, /\[price\] .*选项：使用最新收盘价 428\.4（2026-09-10）/)
})

test('a subagent, which has nobody to ask, is told so', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { userQuestions: refusing('DELEGATED_CALLER'), now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, { symbol: '00700.HK' }, { agent: { id: 'child-1' } })

  assert.equal(result.ok, false)
  assert.match(result.message, /无法直接向用户提问/)
  assert.equal(service.db.listTrades().length, 0)
})

test('an aborted card writes nothing and says so', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { userQuestions: refusing('ASK_ABORTED'), now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, { symbol: '00700.HK' })

  assert.equal(result.ok, false)
  assert.match(result.message, /取消了这次填写/)
  assert.equal(service.db.listTrades().length, 0)
})

test('skipped questions leave the fields open rather than guessing', async () => {
  const service = makeService()
  const { capability } = answerer([
    { id: 'side', selected: [] },
    { id: 'quantity', selected: [], custom: '' },
    { id: 'price', selected: [] },
    { id: 'traded_at', selected: [] },
    { id: 'motive', selected: [] },
  ])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, { symbol: '00700.HK' })

  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['side', 'quantity', 'price', 'traded_at'])
  assert.equal(service.db.listTrades().length, 0)
})

test('a trade the service refuses comes back readable, and nothing is written', async () => {
  const service = makeService()
  const { capability } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const result = await run(tools, ADD_TRADE_TOOL, {
    symbol: '00700.HK', side: 'sell', quantity: 100, price: 400, traded_at: '2026-09-10', ask_motive: false,
  })

  assert.equal(result.ok, false)
  assert.match(result.message, /超过了当时持有/)
  assert.equal(service.db.listTrades().length, 0)
})

// ─── reading the portfolio ───────────────────────────────────────────────────

test('the overview reports totals, rows and per-currency subtotals', async () => {
  const service = makeService()
  const { capability } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  await run(tools, ADD_TRADE_TOOL, {
    symbol: '00700.HK', side: 'buy', quantity: 100, price: 400, traded_at: '2026-09-10', ask_motive: false,
  })
  await run(tools, ADD_TRADE_TOOL, {
    symbol: '600000.SH', side: 'buy', quantity: 1000, price: 9, traded_at: '2026-09-10', ask_motive: false,
  })

  const all = await run(tools, OVERVIEW_TOOL, {})
  assert.equal(all.ok, true)
  assert.equal(all.base_currency, 'CNY')
  assert.equal(all.totals.open_positions, 2)
  assert.equal(all.totals.trade_count, 2)
  assert.equal(all.positions.length, 2)
  assert.equal(all.positions_truncated, false)
  assert.deepEqual(all.native.map(total => total.currency).sort(), ['CNY', 'HKD'])
  const tencent = all.positions.find(row => row.symbol === '00700.HK')
  assert.equal(tencent.quantity, 100)
  assert.equal(tencent.avg_cost, 400)
  assert.equal(tencent.price, 428.4, 'valued at the latest stored close')
  assert.equal(tencent.market_value, 42840)

  const filtered = await run(tools, OVERVIEW_TOOL, { symbol: '腾讯' })
  assert.equal(filtered.positions.length, 1)
  assert.equal(filtered.positions[0].symbol, '00700.HK')
  assert.equal(filtered.filter, '腾讯')
})

test('the rendered overview carries the rows, not just the total', async () => {
  const service = makeService()
  const { capability } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  await run(tools, ADD_TRADE_TOOL, {
    symbol: '00700.HK', side: 'buy', quantity: 100, price: 400, traded_at: '2026-09-10', ask_motive: false,
  })

  const text = await view(tools, OVERVIEW_TOOL, {})
  assert.match(text, /1 个标的、1 笔交易/)
  assert.match(text, /00700\.HK 腾讯控股：100 股 · 仓位 100\.0% · 成本 400/)
  assert.match(text, /现价 428\.4（2026-09-10）/)
  assert.match(text, /市值 42840\.00 HKD · 浮动 \+2840\.00（\+7\.10%）/)
  assert.match(text, /HKD：市值 42840\.00 · 成本 40000\.00 · 浮动 \+2840\.00/)
})

test('the overview carries cleared positions only when asked', async () => {
  const service = makeService()
  const { capability } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  await run(tools, ADD_TRADE_TOOL, {
    symbol: '600000.SH', side: 'buy', quantity: 1000, price: 9, traded_at: '2026-09-01', ask_motive: false,
  })
  await run(tools, ADD_TRADE_TOOL, {
    symbol: '600000.SH', side: 'sell', quantity: 1000, price: 11, traded_at: '2026-09-08', ask_motive: false,
  })

  assert.equal((await run(tools, OVERVIEW_TOOL, {})).closed, undefined)
  const withClosed = await run(tools, OVERVIEW_TOOL, { include_closed: true })
  assert.equal(withClosed.closed.length, 1)
  assert.equal(withClosed.closed[0].symbol, '600000.SH')
  assert.equal(withClosed.closed[0].realized_pnl, 2000)
})

// ─── reading one symbol, the analysis and the index ──────────────────────────

test('the symbol detail reads the stored series, its holding and its name', async () => {
  const service = makeService()
  const { capability, asked } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  await run(tools, ADD_TRADE_TOOL, {
    symbol: '00700.HK', side: 'buy', quantity: 100, price: 400, traded_at: '2026-09-10', ask_motive: false,
  })

  const detail = await run(tools, SYMBOL_DETAIL_TOOL, { symbol: '腾讯控股' })
  assert.equal(asked.length, 0, 'a read of holdings data needs no permission')
  assert.equal(detail.ok, true)
  assert.equal(detail.symbol, '00700.HK')
  assert.equal(detail.name, '腾讯控股')
  assert.equal(detail.currency, 'HKD')
  assert.equal(detail.history.bar_count, 2)
  assert.equal(detail.history.last_close, 428.4)
  assert.equal(detail.history.streak, 1)
  assert.equal(detail.history.ma20, undefined, 'a window the series is too short for is absent, not zero')
  assert.deepEqual(detail.recent_bars.map(bar => bar.date), ['2026-09-09', '2026-09-10'])
  assert.equal(detail.position.quantity, 100)
  assert.equal(detail.position.unrealized_pnl, 2840)
  assert.deepEqual(detail.quote, { price: 428.4, date: '2026-09-10' })

  const text = await view(tools, SYMBOL_DETAIL_TOOL, { symbol: '00700.HK' })
  assert.match(text, /00700\.HK 腾讯控股：2 根日线（2026-09-09 → 2026-09-10）/)
  assert.match(text, /00700\.HK 腾讯控股：100 股 · 仓位 100\.0% · 成本 400/)
  assert.match(text, /最近 2 个交易日收盘：09-09 425\.6 · 09-10 428\.4/)
  assert.match(text, /连涨 1 天/)
})

test('an ambiguous name is put to the user, and the pick is what gets read', async () => {
  const service = makeService()
  const { capability, asked } = answerer([{ id: 'symbol', selected: ['000001.SZ  平安银行'] }])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  const detail = await run(tools, SYMBOL_DETAIL_TOOL, { symbol: '银行' })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].questions[0].id, 'symbol')
  assert.deepEqual(asked[0].questions[0].options.map(option => option.label), [
    '000001.SZ  平安银行', '600000.SH  浦发银行',
  ])
  assert.equal(detail.ok, true)
  assert.equal(detail.symbol, '000001.SZ')
  assert.equal(detail.name, '平安银行')
  assert.deepEqual(detail.asked, ['symbol'])
})

test('a subagent gets the candidates instead of a guess', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { userQuestions: refusing('DELEGATED_CALLER'), now: () => NOW })

  const detail = await run(tools, SYMBOL_DETAIL_TOOL, { symbol: '银行' }, { agent: { id: 'sub-1' } })
  assert.equal(detail.ok, false)
  assert.equal(detail.symbol, undefined)
  assert.deepEqual(detail.matches.map(row => row.symbol).sort(), ['000001.SZ', '600000.SH'])
  assert.equal(detail.questions[0].id, 'symbol')
  assert.match(detail.message, /子代理会话没有人类回答者/)
})

test('an unknown name sends the model to the search tool', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { now: () => NOW })

  const detail = await run(tools, SYMBOL_DETAIL_TOOL, { symbol: '不存在的名字' })
  assert.equal(detail.ok, false)
  assert.match(detail.message, new RegExp(SEARCH_TOOL))
})

test('the search reads the local index, offline', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { now: () => NOW })

  const found = await run(tools, SEARCH_TOOL, { query: '腾讯' })
  assert.equal(found.ok, true)
  assert.deepEqual(found.matches.map(row => row.symbol), ['00700.HK'])
  assert.equal(found.matches[0].name, '腾讯控股')
  assert.equal(found.matches[0].exchange, 'HK')
  assert.equal(found.matches[0].currency, 'HKD')

  const text = await view(tools, SEARCH_TOOL, { query: '00700' })
  assert.match(text, /- 00700\.HK 腾讯控股 · HK · HKD · stock/)

  const nothing = await run(tools, SEARCH_TOOL, { query: '不存在的名字' })
  assert.equal(nothing.ok, false)
  assert.deepEqual(nothing.matches, [])
})

test('the analysis groups by motive and ranks the symbols', async () => {
  const service = makeService()
  const { capability, asked } = answerer([])
  const tools = createPortfolioTools(service, { userQuestions: capability, now: () => NOW })

  await run(tools, ADD_TRADE_TOOL, {
    symbol: '600000.SH', side: 'buy', quantity: 1000, price: 9, traded_at: '2026-09-01', motive: '回调加仓',
  })
  await run(tools, ADD_TRADE_TOOL, {
    symbol: '600000.SH', side: 'sell', quantity: 1000, price: 11, traded_at: '2026-09-08', motive: '止盈',
  })

  const analysis = await run(tools, ANALYSIS_TOOL, {})
  assert.equal(asked.length, 0, 'aggregates need no permission')
  assert.equal(analysis.ok, true)
  assert.equal(analysis.base_currency, 'CNY')
  assert.equal(analysis.ratios.closed_positions, 1)
  assert.equal(analysis.ratios.open_positions, 0)
  assert.equal(analysis.ratios.win_rate, 1)
  assert.deepEqual(analysis.by_motive.map(row => row.key).sort(), ['回调加仓', '止盈'])
  assert.equal(analysis.by_motive.find(row => row.key === '止盈').realized_pnl, 2000)
  assert.equal(analysis.closed[0].realized_pnl, 2000)
  assert.deepEqual(analysis.ranking, [], 'nothing is open after the sell')

  const text = await view(tools, ANALYSIS_TOOL, {})
  assert.match(text, /已实现 \+2000\.00 CNY（1 次清仓、2 笔交易）/)
  assert.match(text, /止盈：1 笔 · 已实现 \+2000\.00/)
  assert.match(text, /（已清仓）600000\.SH 浦发银行：2026-09-01 → 2026-09-08/)
})

// ─── the trade log, behind a consent card ────────────────────────────────────

/**
 * Two trades, one of them carrying a motive — the rows a trade read returns.
 * @returns the service and the tools.
 */
function tradeFixture() {
  const service = makeService()
  const tools = (capability) => createPortfolioTools(service, { userQuestions: capability, now: () => NOW })
  return { service, tools }
}

test('the trade read returns rows only after the user agrees', async () => {
  const { service, tools } = tradeFixture()
  const { capability, asked } = answerer([{ id: 'consent', selected: ['允许这一次'] }])
  const definitions = tools(capability)

  await run(definitions, ADD_TRADE_TOOL, {
    symbol: '600000.SH', side: 'buy', quantity: 1000, price: 9, traded_at: '2026-09-01', motive: '回调加仓',
  })
  await run(definitions, ADD_TRADE_TOOL, {
    symbol: '00700.HK', side: 'buy', quantity: 100, price: 400, traded_at: '2026-09-10', ask_motive: false,
  })

  const read = await run(definitions, LIST_TRADES_TOOL, {})
  assert.equal(asked.length, 1, 'the card is the first thing the read does')
  assert.equal(asked[0].questions[0].id, 'consent')
  assert.deepEqual(asked[0].questions[0].options.map(option => option.label), ['允许这一次', '不允许'])
  assert.equal(read.ok, true)
  assert.equal(read.consent, 'granted')
  assert.equal(read.count, 2)
  assert.equal(read.truncated, false)
  assert.deepEqual(read.trades.map(row => row.symbol), ['00700.HK', '600000.SH'], 'newest first')
  assert.equal(read.trades[1].motive, '回调加仓')
  assert.equal(read.trades[0].name, '腾讯控股', 'the name comes from the index when the row has none')
  assert.equal(service.db.listTrades().length, 2, 'a read never writes')

  const filtered = await run(definitions, LIST_TRADES_TOOL, { symbol: '600000', since: '2026-09-01' })
  assert.equal(filtered.count, 1)
  assert.equal(filtered.trades[0].symbol, '600000.SH')
  assert.equal(filtered.filter.symbol, '600000')

  const text = await view(definitions, LIST_TRADES_TOOL, { symbol: '600000' })
  assert.match(text, /#\d+ 2026-09-01 买入 600000\.SH 浦发银行 1000 @ 9 CNY（动机：回调加仓）/)
})

test('a refused card returns no rows at all', async () => {
  const { tools } = tradeFixture()
  const { capability } = answerer([{ id: 'consent', selected: ['不允许'] }])
  const definitions = tools(capability)

  await run(definitions, ADD_TRADE_TOOL, {
    symbol: '600000.SH', side: 'buy', quantity: 1000, price: 9, traded_at: '2026-09-01', ask_motive: false,
  })

  const read = await run(definitions, LIST_TRADES_TOOL, {})
  assert.equal(read.ok, false)
  assert.equal(read.consent, 'declined')
  assert.equal(read.trades, undefined)
  assert.equal(read.count, undefined)
  assert.match(read.message, /没有同意/)
})

test('an unanswered card is a refusal too', async () => {
  const { tools } = tradeFixture()
  const { capability } = answerer([{ id: 'consent', custom: '以后再说' }])
  const definitions = tools(capability)

  const read = await run(definitions, LIST_TRADES_TOOL, {})
  assert.equal(read.ok, false)
  assert.equal(read.consent, 'declined')
  assert.equal(read.trades, undefined)
})

test('a subagent is told to ask the human itself, and reads nothing', async () => {
  const { tools } = tradeFixture()
  const definitions = tools(refusing('DELEGATED_CALLER'))

  const read = await run(definitions, LIST_TRADES_TOOL, {}, { agent: { id: 'sub-1' } })
  assert.equal(read.ok, false)
  assert.equal(read.consent, 'declined')
  assert.equal(read.trades, undefined)
  assert.equal(read.questions[0].id, 'consent')
  assert.match(read.message, /必须由用户当面同意/)

  const text = await view(definitions, LIST_TRADES_TOOL, {})
  assert.match(text, /需要向用户确认/)
  assert.match(text, /允许这一次/)
})

test('the consent card names exactly what the read would cover', async () => {
  const { tools } = tradeFixture()
  const { capability, asked } = answerer([{ id: 'consent', selected: ['不允许'] }])
  const definitions = tools(capability)

  await run(definitions, LIST_TRADES_TOOL, { symbol: '腾讯', side: 'sell', since: '2026-01-01', until: '2026-09-10' })
  assert.match(asked[0].questions[0].detail, /只看「腾讯」、只看卖出、2026-01-01 起、到 2026-09-10 为止/)
})

// ─── what the registry is handed ─────────────────────────────────────────────

test('every declared schema stays inside the enforced subset', () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { now: () => NOW })

  assert.deepEqual(tools.map(tool => tool.name), [
    ADD_TRADE_TOOL, OVERVIEW_TOOL, SYMBOL_DETAIL_TOOL, ANALYSIS_TOOL, SEARCH_TOOL, LIST_TRADES_TOOL,
  ])
  for (const tool of tools) {
    assert.deepEqual(schemaViolations(tool.output.schema), [], `${tool.name} output schema`)
    assert.equal(tool.parameters.type, 'object')
    assert.ok(Object.keys(tool.parameters.properties ?? {}).length > 0)
    assert.equal(tool.description.length > 80, true)
  }
})

test('registration publishes every tool and disposes with the plugin', () => {
  const service = makeService()
  const registered = []
  const disposed = []
  const disposers = []
  const ctx = {
    get: name => name === 'tools'
      ? { register: tool => { registered.push(tool.name); return () => disposed.push(tool.name) } }
      : undefined,
    effect: work => { disposers.push(work()) },
  }

  registerPortfolioTools(ctx, service)

  const expected = [
    ADD_TRADE_TOOL, OVERVIEW_TOOL, SYMBOL_DETAIL_TOOL, ANALYSIS_TOOL, SEARCH_TOOL, LIST_TRADES_TOOL,
  ]
  assert.deepEqual(registered, expected)
  for (const disposer of disposers) disposer()
  assert.deepEqual(disposed, expected)
})

test('a composition without a tool registry is a note, not a crash', () => {
  const service = makeService()
  const warnings = []
  const original = console.warn
  console.warn = (...values) => { warnings.push(values.join(' ')) }
  try {
    registerPortfolioTools({ get: () => undefined, effect: () => { throw new Error('must not register') } }, service)
  } finally {
    console.warn = original
  }
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /ctx\.tools is not mounted/)
})
