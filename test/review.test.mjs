/**
 * The portfolio review: one read that states the portfolio as it stands.
 *
 * Every case here is about a number a reviewer would act on — the weight, the
 * window, the concentration call — so the fixtures are small enough to compute
 * by hand and the assertions are stated as the arithmetic rather than as a
 * snapshot of whatever the code happened to return.
 *
 * The market is stubbed twice over, exactly as `tool.test.mjs` does it: the
 * service is handed a `fetch` that answers 404 to everything, and the closes the
 * cases measure are seeded straight into SQLite.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  REVIEW_TOOL, PortfolioService, createPortfolioTools,
} from '../lib/index.js'

/** Noon on a fixed local day: every relative-date assertion is timezone-proof. */
const NOW = new Date(2026, 8, 11, 12, 0, 0)

/** The day the newest seeded bar belongs to, two days before {@link NOW}. */
const LAST_BAR = '2026-09-09'

/** How many bars the fixtures carry: long enough for every 60-bar indicator. */
const BARS = 70

/** A read limit smaller than the fixture, so truncation is observable. */
const READ_LIMIT_BARS = 30

/** The rate table every converted total in these cases pivots through. */
const RATES = { usdCny: 7.15, usdHkd: 7.8 }

/**
 * Convert one native amount into the base currency, through USD.
 *
 * Restated rather than imported: the dashboard's own `convert` is what the
 * service uses, and a test that calls it would be asserting that a function
 * agrees with itself. Every table entry is units of that currency per USD.
 * @param amount - the amount in `currency`.
 * @param currency - its currency.
 * @returns the amount in CNY.
 */
function toCny(amount, currency) {
  if (currency === 'CNY') return amount
  const perUsd = currency === 'USD' ? 1 : RATES.usdHkd
  return amount / perUsd * RATES.usdCny
}

/**
 * Build an ascending daily series ending at the requested close.
 *
 * The shape is fixed rather than random so a drawdown or a return is something
 * this file can state exactly: `start` rises to `peak` over the first
 * sixty bars, then falls to `end` over the last ten — which puts the peak
 * inside the 60-bar window the drawdown measures.
 * @param start - the first close.
 * @param peak - the highest close, sixty bars in.
 * @param end - the last close.
 * @returns the bars, oldest first.
 */
function series(start, peak, end) {
  const bars = []
  const first = new Date(`${LAST_BAR}T00:00:00`)
  first.setDate(first.getDate() - (BARS - 1))
  for (let index = 0; index < BARS; index += 1) {
    const at = new Date(first)
    at.setDate(first.getDate() + index)
    const close = index <= BARS - 10
      ? start + (peak - start) * (index / (BARS - 10))
      : peak + (end - peak) * ((index - (BARS - 10)) / 9)
    const date = `${String(at.getFullYear())}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    bars.push({ symbol: '', date, open: close, high: close, low: close, close, volume: 1000, amount: 0 })
  }
  return bars
}

/** The trade log the review cases measure. */
const TRADES = [
  {
    symbol: '600519.SH', exchange: 'SH', currency: 'CNY', name: '贵州茅台',
    side: 'buy', quantity: 100, price: 1280, tradedAt: '2026-09-07', motive: '长期看好', note: null,
  },
  {
    symbol: 'AAPL.US', exchange: 'US', currency: 'USD', name: '苹果',
    side: 'buy', quantity: 50, price: 320, tradedAt: '2026-09-07', motive: '财报超预期', note: null,
  },
  {
    symbol: '00001.HK', exchange: 'HK', currency: 'HKD', name: '长和',
    side: 'buy', quantity: 100, price: 68, tradedAt: '2026-09-10', motive: '定投', note: null,
  },
]

/** What was seeded, and therefore what the cases assert against. */
const SEEDED = [
  { symbol: '600519.SH', bars: series(1000, 1220, 1100), price: 1100 },
  // Deliberately the widest swings of the three, so "most volatile" and
  // "deepest drawdown" name the same symbol for a reason the fixtures state.
  { symbol: 'AAPL.US', bars: series(300, 380, 340), price: 340 },
  { symbol: '00001.HK', bars: series(66, 72, 71), price: 71 },
]

/** Everything the cases opened, torn down when the file finishes. */
const services = []
const dirs = []

/**
 * Build a service with the fixtures seeded, or an empty one.
 * @param options - `empty` seeds nothing at all.
 * @returns the service.
 */
function makeService(options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsp-review-'))
  dirs.push(dataDir)
  const service = new PortfolioService({
    dataDir,
    fetchImpl: async () => new Response('not found', { status: 404 }),
    dotenvPath: join(dataDir, '.env'),
    now: () => NOW,
  })
  services.push(service)
  service.updateSettings({ baseCurrency: 'CNY', usdCny: RATES.usdCny, usdHkd: RATES.usdHkd })
  if (options.empty === true) return service
  for (const trade of TRADES) service.db.insertTrade(trade)
  for (const entry of SEEDED) {
    service.db.upsertPrices(entry.bars.map(bar => ({ ...bar, symbol: entry.symbol })))
  }
  // Inserting a trade materialized the holdings projection while every symbol
  // was still unpriced, so the seeded closes only reach the positions after a
  // rebuild — the same order a real refresh arrives in.
  service.db.rebuildHoldings()
  return service
}

/**
 * Call one tool and check its own output contract.
 * @param tools - the definitions.
 * @param name - the tool to call.
 * @param args - the model's arguments.
 * @returns the canonical value.
 */
async function run(tools, name, args) {
  const tool = tools.find(candidate => candidate.name === name)
  assert.ok(tool !== undefined, `no tool named ${name}`)
  const value = await tool.execute(args, { signal: new AbortController().signal })
  assert.deepEqual(validate(tool.output.schema, value), [], `${name} result violates output.schema`)
  return value
}

/**
 * Call one tool and return the text the model would actually read.
 * @param tools - the definitions.
 * @param name - the tool to call.
 * @param args - the model's arguments.
 * @returns the joined text of every rendered block.
 */
async function view(tools, name, args) {
  const tool = tools.find(candidate => candidate.name === name)
  assert.ok(tool !== undefined, `no tool named ${name}`)
  const value = await tool.execute(args, { signal: new AbortController().signal })
  return tool.output.render(args, value).map(block => block.text).join('\n')
}

// ─── the schema checker, restated from tool.test.mjs ─────────────────────────
//
// The harness enforces a small JSON Schema subset on tool outputs and the plugin
// cannot import its validator, so the subset is restated here. It is duplicated
// rather than shared because a test that shares its own checker with the code
// under test stops being able to catch a schema the runner would reject.

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

// ─── the read model ──────────────────────────────────────────────────────────

test('every tool schema stays inside the enforced subset', () => {
  const service = makeService()
  for (const tool of createPortfolioTools(service, { now: () => NOW })) {
    assert.deepEqual(schemaViolations(tool.output.schema), [], `${tool.name} declares an unsupported schema`)
  }
})

test('the snapshot measures each holding against the portfolio and its own series', () => {
  const service = makeService()
  const snapshot = service.reviewSnapshot()

  assert.equal(snapshot.rows.length, 3)
  assert.equal(snapshot.baseCurrency, 'CNY')
  assert.equal(snapshot.priceDate, LAST_BAR)

  const byWeight = [...snapshot.rows].sort((left, right) => right.weight - left.weight)
  // Apple's converted value (50 × 340 USD, at 7.15 CNY per USD) is larger than
  // the Moutai line, so the biggest position is the foreign one.
  assert.equal(byWeight[0].symbol, 'AAPL.US')
  // The weights are shares of one converted total, so they have to add to 1.
  assert.ok(Math.abs(snapshot.rows.reduce((sum, row) => sum + row.weight, 0) - 1) < 1e-9)

  const apple = snapshot.rows.find(row => row.symbol === 'AAPL.US')
  assert.ok(apple !== undefined)
  assert.equal(apple.name, '苹果')
  assert.equal(apple.bars, 60)
  assert.equal(apple.price, 340)
  // 50 × (340 − 320), in the symbol's own currency.
  assert.ok(Math.abs(apple.unrealizedPnl - 1000) < 1e-6)
  assert.ok(Math.abs(apple.marketValueBase - toCny(50 * 340, 'USD')) < 1e-6)
  // 340 against the close 30 bars back (352) — the window the review quotes.
  assert.ok(apple.return30Pct !== null && Math.abs(apple.return30Pct - (340 / 352 - 1)) < 1e-9)
  assert.ok(apple.volatility20 !== null && apple.volatility20 > 0)
  // The seeded peak sits inside the 60-bar window and 340 is below it.
  assert.ok(apple.maxDrawdown60 !== null && apple.maxDrawdown60 > 0)
  assert.equal(apple.priceAgeDays, 2)

  // Money in a foreign currency is stated unconverted in `native`, and the
  // converted versions have to add up to the converted total.
  const usd = snapshot.native.find(total => total.currency === 'USD')
  const cny = snapshot.native.find(total => total.currency === 'CNY')
  const hkd = snapshot.native.find(total => total.currency === 'HKD')
  assert.ok(usd !== undefined && cny !== undefined && hkd !== undefined)
  assert.ok(Math.abs(usd.marketValue - 50 * 340) < 1e-6)
  assert.ok(Math.abs(usd.unrealizedPnl - 1000) < 1e-6)
  assert.ok(Math.abs(
    snapshot.totals.marketValue
    - (toCny(cny.marketValue, 'CNY') + toCny(usd.marketValue, 'USD') + toCny(hkd.marketValue, 'HKD')),
  ) < 1e-6)
})

test('a single dominant position is called out as high concentration', () => {
  const service = makeService()
  const snapshot = service.reviewSnapshot()
  assert.equal(snapshot.signals.concentrationSymbol, 'AAPL.US')
  assert.equal(snapshot.signals.concentrationLabel, 'high')
  assert.ok(snapshot.signals.concentration > 0.4)
  assert.ok(snapshot.notes.some(note => note.includes('集中度偏高')))
})

test('the findings name the most volatile and deepest-drawing holdings', () => {
  const service = makeService()
  const snapshot = service.reviewSnapshot()
  assert.equal(snapshot.signals.mostVolatileSymbol, 'AAPL.US')
  assert.equal(snapshot.signals.deepestDrawdownSymbol, 'AAPL.US')
  assert.ok(snapshot.signals.winners + snapshot.signals.losers + snapshot.signals.flat === 3)
})

test('an empty portfolio is answered without inventing a picture', () => {
  const service = makeService({ empty: true })
  const snapshot = service.reviewSnapshot()
  assert.deepEqual(snapshot.rows, [])
  assert.equal(snapshot.totals.marketValue, 0)
  assert.equal(snapshot.windowReturnPct, null)
  assert.equal(snapshot.signals.concentrationSymbol, null)
})

test('the stored series is read per symbol, oldest first and no longer than asked', () => {
  const service = makeService()
  const seriesMap = service.db.readBarsFor(['AAPL.US', '600519.SH'], READ_LIMIT_BARS)
  assert.deepEqual([...seriesMap.keys()].sort(), ['600519.SH', 'AAPL.US'])
  const apple = seriesMap.get('AAPL.US')
  assert.equal(apple.length, READ_LIMIT_BARS)
  assert.equal(apple[0].date < apple.at(-1).date, true)
  assert.deepEqual(seriesMap.get('00700.HK') ?? [], [])
})

// ─── the tool ────────────────────────────────────────────────────────────────

test('the review tool returns the picture and the research scope in one call', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { now: () => NOW })
  const result = await run(tools, REVIEW_TOOL, {})

  assert.equal(result.ok, true)
  assert.equal(result.holdings.length, 3)
  assert.equal(result.holdings_truncated, false)
  assert.equal(result.price_date, LAST_BAR)
  assert.equal(result.totals.open_positions, 3)
  assert.equal(result.signals.concentration_label, 'high')
  assert.equal(result.research.symbols.length, 3)
  assert.ok(result.research.symbols.every(entry => typeof entry.weight === 'number'))
  assert.ok(result.research.angles.some(angle => angle.includes('券商')))
  assert.ok(result.research.limits.some(limit => limit.includes('不含行业')))
  assert.ok(result.research.limits.some(limit => limit.includes('不含券商预期')))
  assert.ok(result.research.next.length >= 3)
  // The forward-looking half is never fabricated: no news field exists at all.
  assert.equal(Object.hasOwn(result, 'news'), false)
})

test('the tool reads a holding the way a reviewer needs it, not the way the panel does', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { now: () => NOW })
  const result = await run(tools, REVIEW_TOOL, {})
  const apple = result.holdings.find(row => row.symbol === 'AAPL.US')
  assert.ok(apple !== undefined)
  assert.equal(apple.currency, 'USD')
  assert.equal(typeof apple.return30_pct, 'number')
  assert.equal(typeof apple.volatility20, 'number')
  assert.equal(apple.bars, 60)
  // The converted value, not the native one.
  assert.ok(Math.abs(apple.market_value - toCny(50 * 340, 'USD')) < 1e-6)
})

test('focus narrows the rows and the research scope without hiding the portfolio', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { now: () => NOW })
  const result = await run(tools, REVIEW_TOOL, { focus: '苹果' })

  assert.equal(result.holdings.length, 1)
  assert.equal(result.holdings[0].symbol, 'AAPL.US')
  assert.equal(result.research.symbols.length, 1)
  assert.equal(result.research.symbols[0].symbol, 'AAPL.US')
  // The concentration finding still describes the whole portfolio.
  assert.equal(result.signals.concentration_label, 'high')
  assert.ok(result.total_pnl !== undefined || result.totals.total_pnl !== undefined)
})

test('the rendered view states every holding and the research checklist', async () => {
  const service = makeService()
  const tools = createPortfolioTools(service, { now: () => NOW })
  const text = await view(tools, REVIEW_TOOL, {})

  assert.match(text, /贵州茅台/)
  assert.match(text, /苹果/)
  assert.match(text, /仓位 \d+\.\d%/)
  assert.match(text, /集中度|第一重仓/)
  assert.match(text, /研究范围/)
  assert.match(text, /查：/)
  assert.match(text, /不要给出确定的价格预测/)
})

test('an empty portfolio answers politely instead of failing', async () => {
  const service = makeService({ empty: true })
  const tools = createPortfolioTools(service, { now: () => NOW })
  const result = await run(tools, REVIEW_TOOL, {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.holdings, [])
  assert.match(result.message, /还没有持仓/)
})
