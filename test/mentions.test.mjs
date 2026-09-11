/**
 * Mention detection: what pops the panel open, and — more importantly — what
 * does not.
 *
 * The asymmetry is the whole design. A missed mention costs one click; a false
 * positive throws a panel over the conversation mid-sentence, so every rule here
 * is written as a pair: the spelling that must match, and the ordinary text that
 * must not.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createMentionMatcher, excerptFor, foldMentionState, initMentionState, mentionFeedOf, mentionProjectionUnit,
  parseMentionState, projectMessage, textOfContent,
} from '../lib/index.js'

/** The portfolio the cases below scan against. */
const TARGETS = [
  { symbol: '600519.SH', code: '600519', name: '贵州茅台' },
  { symbol: '00700.HK', code: '00700', name: '腾讯控股' },
  { symbol: 'AAPL.US', code: 'AAPL', name: '苹果' },
  { symbol: 'IT.US', code: 'IT', name: 'Gartner' },
  { symbol: 'F.US', code: 'F', name: '福特汽车' },
]

/**
 * Run the matcher over one message.
 * @param text - the message text.
 * @returns the matched symbols, in order.
 */
function scan(text) {
  return createMentionMatcher(TARGETS)(text).map(match => match.symbol)
}

test('a mainland code is matched as a standalone number', () => {
  assert.deepEqual(scan('600519 今天怎么样？'), ['600519.SH'])
  assert.deepEqual(scan('我看了看600519的财报'), ['600519.SH'])
  assert.deepEqual(scan('贵州茅台（600519.SH）收盘 1268.5'), ['600519.SH'])
  // Six digits inside a longer number are a date or an amount, not a code.
  assert.deepEqual(scan('订单号 1600519 已提交'), [])
  assert.deepEqual(scan('成交额 6005190000 元'), [])
})

test('a Hong Kong code is matched in the padded form the portfolio stores', () => {
  assert.deepEqual(scan('00700 跌了'), ['00700.HK'])
  assert.deepEqual(scan('00700.HK 股息'), ['00700.HK'])
  // `700` is how a person says it, but it is also a number that appears in
  // ordinary text, so it is deliberately not a probe of its own.
  assert.deepEqual(scan('花了 700 块'), [])
})

test('a long ticker is matched in any case, a short one only as a ticker is written', () => {
  assert.deepEqual(scan('aapl 的财报'), ['AAPL.US'])
  assert.deepEqual(scan('AAPL.US 已经涨了'), ['AAPL.US'])
  // `IT` is a word before it is a ticker: the upper-case form is the signal.
  assert.deepEqual(scan('it is fine'), [])
  assert.deepEqual(scan('IT 这家公司'), ['IT.US'])
  // A single letter is never matched on its own.
  assert.deepEqual(scan('F 系列卡车'), [])
  assert.deepEqual(scan('F.US 的分红'), ['F.US'])
})

test('an instrument name is matched as a substring', () => {
  assert.deepEqual(scan('贵州茅台的估值'), ['600519.SH'])
  assert.deepEqual(scan('腾讯控股今天回购了'), ['00700.HK'])
  // An ASCII name needs its own boundaries, or it matches inside a word.
  assert.deepEqual(scan('Gartner 上调了预期'), ['IT.US'])
  assert.deepEqual(scan('Gartnerville 是个地名'), [])
})

test('a symbol mentioned twice is reported once, in order of first appearance', () => {
  assert.deepEqual(scan('600519 和 600519.SH 是同一只'), ['600519.SH'])
  assert.deepEqual(scan('先看 00700，再看 600519，最后回到 AAPL'), ['00700.HK', '600519.SH', 'AAPL.US'])
  assert.deepEqual(scan('今天天气不错'), [])
})

test('a mention reports where it sat, and the excerpt quotes it', () => {
  const text = '我把 600519 的仓位减了一半，剩下的继续拿着，等三季报出来再看。'
  const [match] = createMentionMatcher(TARGETS)(text)
  assert.equal(match.matched, '600519')
  assert.equal(text.slice(match.index, match.index + match.matched.length), '600519')

  // The hit sits at the head of the sentence, so only the tail is ellipsized.
  const excerpt = excerptFor(text, match)
  assert.ok(excerpt.includes('600519'), excerpt)
  assert.ok(excerpt.startsWith('我把'), excerpt)
  assert.ok(excerpt.endsWith('…'), excerpt)

  // A hit buried in a long message is trimmed on both sides.
  const long = `${'前面说了很多无关的话，'.repeat(6)}600519${'后面也还有很多话。'.repeat(6)}`
  const [deep] = createMentionMatcher(TARGETS)(long)
  const deepExcerpt = excerptFor(long, deep)
  assert.ok(deepExcerpt.startsWith('…') && deepExcerpt.endsWith('…'), deepExcerpt)
  assert.ok(deepExcerpt.length < 120, deepExcerpt)
})

test('only the visible text of a message is scanned', () => {
  const content = [
    { type: 'reasoning', text: '让我想想 600519 的估值' },
    { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"symbol":"00700.HK"}' },
    { type: 'text', text: '先说结论：' },
    { type: 'text', text: '600519 的毛利率仍然最高。' },
  ]
  const text = textOfContent(content)
  assert.equal(text, '先说结论： 600519 的毛利率仍然最高。')
  assert.deepEqual(createMentionMatcher(TARGETS)(text).map(match => match.symbol), ['600519.SH'])
})

test('the projector reads the two event shapes and refuses everything else', () => {
  const session = { id: 'session-1', header: {} }
  const at = Date.parse('2026-09-11T12:00:00.000Z')

  const user = projectMessage(session, {
    type: 'user/message',
    time: at,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '600519 怎么样' }] },
  })
  assert.deepEqual(user, { sessionId: 'session-1', source: 'user', at, text: '600519 怎么样' })

  const assistant = projectMessage(session, {
    type: 'assistant/message',
    time: at,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '600519 的毛利率' }] } },
  })
  assert.equal(assistant.source, 'assistant')
  assert.equal(assistant.text, '600519 的毛利率')

  // A plugin notice, a tool result and a system message are user-ROLE without
  // being anything the user typed.
  assert.equal(projectMessage(session, {
    type: 'user/message',
    time: at,
    data: { source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: '600519' }] },
  }), null)
  assert.equal(projectMessage(session, {
    type: 'user/message',
    time: at,
    data: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result' }] },
  }), null)
  assert.equal(projectMessage(session, { type: 'tool/result', time: at, data: {} }), null)
  assert.equal(projectMessage(session, {
    type: 'assistant/message',
    time: at,
    data: { message: { content: [{ type: 'reasoning', text: '600519' }] } },
  }), null)
  assert.equal(projectMessage(session, {
    type: 'user/message',
    time: at,
    data: { source: { kind: 'user' }, content: [] },
  }), null)
})

test('a subagent turn is not the conversation', () => {
  const at = Date.parse('2026-09-11T12:00:00.000Z')
  const event = {
    type: 'assistant/message',
    time: at,
    data: { message: { content: [{ type: 'text', text: '600519 毛利 91%' }] } },
  }
  assert.equal(projectMessage({ id: 'sub-1', header: { origin: 'subagent' } }, event), null)
  assert.notEqual(projectMessage({ id: 'session-1', header: {} }, event), null)
})

/** One committed event of each shape the fold cares about. */
function userEvent(text, seq, at) {
  return { type: 'user/message', seq, time: at, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

/** An assistant turn that says `text`. */
function assistantEvent(text, seq, at) {
  return {
    type: 'assistant/message', seq, time: at,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
  }
}

test('the fold turns a whole stored conversation into its mentions', () => {
  // This is what a restored session is: a list of committed events, folded by
  // the framework on first read. The pane's history comes from exactly this.
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    userEvent('早上好', 1, 1_000),
    assistantEvent('早上好，有什么可以帮你的？', 2, 2_000),
    userEvent('600519 现在贵吗？', 3, 3_000),
    assistantEvent('按 1268.5 的成本算，600519.SH 现在浮亏 7.8%；腾讯不在你的持仓里。', 4, 4_000),
    { type: 'tool/call', seq: 5, time: 5_000, data: { name: 'stock_portfolio_overview' } },
  ]
  const state = events.reduce(
    (current, event) => foldMentionState(current, event, createMentionMatcher(TARGETS)),
    initMentionState({ id: 'session-old', origin: undefined }),
  )

  assert.equal(state.sessionId, 'session-old')
  assert.equal(state.rev, 2)
  assert.deepEqual(state.batches.map(batch => batch.source), ['user', 'assistant'])
  assert.deepEqual(state.batches[0].symbols, ['600519.SH'])
  // The second turn names the symbol twice and still reports it once.
  assert.deepEqual(state.batches[1].symbols, ['600519.SH'])
  assert.equal(state.batches[1].at, 4_000)
  assert.ok(state.batches[1].excerpt.includes('600519'))
  assert.deepEqual(mentionFeedOf(state), { rev: 2, batches: state.batches })
})

test('an uninterested event returns the state it was given', () => {
  // The reference rule is load-bearing: the framework treats a changed
  // reference as a change and wakes the browser.
  const state = initMentionState({ id: 's', origin: undefined })
  for (const event of [
    { type: 'turn/start', seq: 0, time: 1, data: {} },
    userEvent('今天天气不错', 1, 1_000),
    assistantEvent('是啊', 2, 2_000),
  ]) {
    assert.equal(foldMentionState(state, event, createMentionMatcher(TARGETS)), state)
  }
})

test('a subagent session folds to nothing, however much it mentions', () => {
  const state = foldMentionState(
    initMentionState({ id: 'sub-1', origin: 'subagent' }),
    assistantEvent('600519 的毛利率是 91%', 0, 1_000),
    createMentionMatcher(TARGETS),
  )
  assert.equal(state.rev, 0)
  assert.deepEqual(state.batches, [])
})

test('a checkpointed state is validated before it seeds a fold', () => {
  const state = initMentionState({ id: 's', origin: undefined })
  const folded = foldMentionState(state, userEvent('600519', 0, 5_000), createMentionMatcher(TARGETS))
  assert.deepEqual(parseMentionState(JSON.parse(JSON.stringify(folded))), folded)

  // A state from another version, or garbage, is refused rather than applied.
  for (const bad of [null, {}, { sessionId: 's' }, { sessionId: 's', skip: false, rev: -1, batches: [] },
    { sessionId: 's', skip: false, rev: 1, batches: [{ rev: 1 }] }]) {
    assert.throws(() => parseMentionState(bad), TypeError)
  }
  assert.deepEqual(mentionFeedOf(undefined), { rev: 0, batches: [] })
})

test('the oldest batches fall off while the revision keeps climbing', () => {
  let state = initMentionState({ id: 's', origin: undefined })
  const match = createMentionMatcher(TARGETS)
  for (let index = 0; index < 60; index += 1) {
    state = foldMentionState(state, userEvent(`第 ${String(index)} 次提到 600519`, index, index * 1_000), match)
  }
  assert.equal(state.rev, 60)
  assert.equal(state.batches.length, 40)
  assert.equal(state.batches.at(-1).rev, 60)
  assert.equal(state.batches[0].rev, 21)
})

test('the registered unit is the contract the framework reads', () => {
  // The projection registry takes exactly these five fields: a key it owns
  // alone, a schema that validates a checkpointed state before it seeds a fold,
  // an init, a pure apply, and a version that invalidates old checkpoints.
  const unit = mentionProjectionUnit(() => createMentionMatcher(TARGETS))
  assert.equal(unit.key, 'stockPortfolioMentions')
  assert.equal(unit.stateVersion, 1)
  assert.equal(typeof unit.init, 'function')
  assert.equal(typeof unit.apply, 'function')
  assert.equal(typeof unit.stateSchema.parse, 'function')

  // Driving it the way the drive does: one event at a time, from init.
  const events = [
    userEvent('600519 怎么样？', 0, 1_000),
    assistantEvent('600519.SH 今天跌了 2.6%。', 1, 2_000),
  ]
  const state = events.reduce((current, event) => unit.apply(current, event), unit.init({ id: 'session-9', origin: undefined }))
  assert.equal(state.rev, 2)
  assert.deepEqual(mentionFeedOf(state).batches.map(batch => batch.symbols), [['600519.SH'], ['600519.SH']])

  // What the framework hands back from a checkpoint round-trips through the
  // schema unchanged, which is what makes a resumed session cheap.
  assert.deepEqual(unit.stateSchema.parse(JSON.parse(JSON.stringify(state))), state)
})
