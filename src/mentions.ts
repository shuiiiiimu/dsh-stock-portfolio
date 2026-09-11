/**
 * Which portfolio symbols a message mentions.
 *
 * The trigger for the dashboard's 「提及」 view: every user turn and every
 * assistant turn is scanned once, post-commit, and a hit is anything that names
 * a symbol the portfolio already knows about — its code (`600519`, `00700`,
 * `AAPL`), its canonical symbol (`600519.SH`), or its instrument name
 * (`贵州茅台`, `腾讯控股`).
 *
 * ## Why the rules are asymmetric
 *
 * A false positive is worse than a miss here: the panel pops up over the
 * conversation, so matching the word "it" because Gartner's ticker is `IT` would
 * be a bug a user feels every turn. So the tolerance is graded by how ambiguous
 * a spelling actually is:
 *
 * | Shape | Rule | Why |
 * | --- | --- | --- |
 * | `600519`, `00700` | digit-delimited token | six digits inside a longer number (a date, an amount) is not a code |
 * | `AAPL`, `TSLA` | token, case-insensitive from four letters | long tickers are not English words |
 * | `IT`, `ON`, `ALL` | token, UPPER-CASE only | these are ordinary words in prose |
 * | `F`, `T`, `V` | never by code | one letter cannot be told from a word; the name or `F.US` still matches |
 * | `贵州茅台` | substring | Chinese instrument names are not substrings of anything else |
 *
 * The matcher is a pure function of the targets and the text, so the whole rule
 * table is testable without a session, a database, or a model.
 */
import { codeOfSymbol } from './symbols.ts'
import type { MentionBatch, MentionFeed } from './types.ts'

/** One symbol the matcher can recognize. */
export interface MentionTarget {
  /** Canonical symbol, e.g. `600519.SH`. */
  readonly symbol: string
  /** Exchange-local code, e.g. `600519`. */
  readonly code: string
  /** Instrument name as the index spells it, or `null` when unknown. */
  readonly name: string | null
}

/** One symbol found in a message. */
export interface MentionMatch {
  /** Canonical symbol. */
  readonly symbol: string
  /** The text that matched, exactly as it appeared. */
  readonly matched: string
  /** Offset of the match inside the flattened message. */
  readonly index: number
}

/** One matching spelling and the symbol it stands for. */
interface Probe {
  readonly symbol: string
  readonly pattern: RegExp
}

/** The shortest ASCII name worth substring-matching. */
const MIN_NAME_LENGTH = 2

/** How much context a mention excerpt carries on each side of the hit. */
const EXCERPT_RADIUS = 24

/** The longest excerpt kept, so one long paragraph cannot bloat the payload. */
const EXCERPT_LIMIT = 160

/**
 * Escape a literal for use inside a regular expression.
 * @param value - the literal text.
 * @returns the escaped text.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Whether a code is written in digits only.
 * @param code - the exchange-local code.
 * @returns true for a numeric code.
 */
function isNumericCode(code: string): boolean {
  return /^\d+$/u.test(code)
}

/**
 * Whether a name is pure ASCII, and therefore needs word boundaries.
 * @param name - the instrument name.
 * @returns true when every character is ASCII.
 */
function isAscii(name: string): boolean {
  return /^[\u0000-\u007F]+$/u.test(name)
}

/**
 * Build one probe, or `null` when the spelling is too ambiguous to match on.
 * @param symbol - the symbol the probe stands for.
 * @param text - the literal spelling.
 * @param kind - which of the three spellings this is.
 * @returns the probe, or `null` when it is refused by the rule table.
 */
function probe(symbol: string, text: string, kind: 'symbol' | 'code' | 'name'): Probe | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const literal = escapeRegExp(trimmed)

  if (kind === 'symbol') {
    // `.SH` already delimits the code, so only the outer edges need guarding.
    return { symbol, pattern: new RegExp(`(?<![A-Za-z0-9.])${literal}(?![A-Za-z0-9])`, 'iu') }
  }

  if (kind === 'code') {
    if (isNumericCode(trimmed)) {
      return { symbol, pattern: new RegExp(`(?<![\\d.])${literal}(?![\\d.])`, 'u') }
    }
    if (trimmed.length < 2) return null
    // Four letters and up are unambiguous enough to accept in any case; the
    // short ones are ordinary words, so only the way a ticker is written counts.
    const flags = trimmed.length >= 4 ? 'iu' : 'u'
    return { symbol, pattern: new RegExp(`(?<![A-Za-z0-9])${literal}(?![A-Za-z0-9])`, flags) }
  }

  if (trimmed.length < MIN_NAME_LENGTH) return null
  // Chinese names are distinctive enough to find anywhere; an ASCII name needs
  // word boundaries, or "Apple" would match inside "Applebee".
  const head = isAscii(trimmed) ? '(?<![A-Za-z0-9])' : ''
  const tail = isAscii(trimmed) ? '(?![A-Za-z0-9])' : ''
  return { symbol, pattern: new RegExp(`${head}${literal}${tail}`, 'iu') }
}

/**
 * Build the matcher for a target set.
 * @param targets - the portfolio's symbols.
 * @returns a function that scans one message and returns its hits, first first.
 */
export function createMentionMatcher(targets: readonly MentionTarget[]): (text: string) => MentionMatch[] {
  const probes: Probe[] = []
  for (const target of targets) {
    const code = target.code === '' ? codeOfSymbol(target.symbol) : target.code
    for (const [spelling, kind] of [
      [target.symbol, 'symbol'],
      [code, 'code'],
      [target.name ?? '', 'name'],
    ] as const) {
      const built = probe(target.symbol, spelling, kind)
      // A name that is only its own code would double-report the same hit.
      if (built !== null && !(kind === 'name' && spelling.trim() === code)) probes.push(built)
    }
  }

  return (text: string): MentionMatch[] => {
    // One flattened line, so an excerpt never carries a newline and offsets are
    // stable across the two regexes that find the same symbol.
    const flat = text.replace(/\s+/gu, ' ')
    const hits = new Map<string, MentionMatch>()
    for (const entry of probes) {
      const found = entry.pattern.exec(flat)
      if (found === null) continue
      const index = found.index
      const matched = found[0]
      const existing = hits.get(entry.symbol)
      if (existing !== undefined && (existing.index < index || existing.matched.length >= matched.length)) continue
      hits.set(entry.symbol, { symbol: entry.symbol, matched, index })
    }
    return [...hits.values()].sort((left, right) => left.index - right.index)
  }
}

/**
 * The line a mention is reported with: a little context around the hit.
 * @param text - the flattened message.
 * @param match - the hit to describe.
 * @returns the excerpt, ellipsized at both ends.
 */
export function excerptFor(text: string, match: MentionMatch): string {
  const start = Math.max(0, match.index - EXCERPT_RADIUS)
  const end = Math.min(text.length, match.index + match.matched.length + EXCERPT_RADIUS)
  const body = text.slice(start, end).trim().slice(0, EXCERPT_LIMIT)
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/** The session facts the projector reads. */
export interface SessionLike {
  readonly id: string
  readonly header?: { readonly origin?: string } | undefined
}

/** The event facts the projector reads. */
export interface SessionEventLike {
  readonly type: string
  readonly time: number
  readonly data: unknown
}

/** One message worth scanning. */
export interface MentionMessage {
  readonly sessionId: string
  readonly source: 'user' | 'assistant'
  /** Epoch milliseconds of the append. */
  readonly at: number
  /** The message's visible text, already flattened. */
  readonly text: string
}

/**
 * Join the visible text of a message's content blocks.
 *
 * Reasoning, tool calls and attachments are dropped: the panel should react to
 * what the conversation shows, not to what the model thought on the way there.
 * @param content - the message's content blocks.
 * @returns the text, whitespace-flattened.
 */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown, text?: unknown }
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue
    parts.push(candidate.text)
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim()
}

/**
 * Project one appended session event into the message the scanner wants.
 * @param session - the session the event belongs to.
 * @param event - the appended event.
 * @returns the message, or `null` when the event is not a user/assistant turn
 * worth scanning.
 */
export function projectMessage(session: SessionLike, event: SessionEventLike): MentionMessage | null {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return null
  // A subagent's turns are not the conversation surface: whatever it found
  // reaches the user through the parent's own text, and popping the panel for a
  // background child would be noise.
  if (session.header?.origin === 'subagent') return null

  if (event.type === 'user/message') {
    const message = event.data as { source?: { kind?: unknown }, content?: unknown } | null
    // Steering, plugin notices and tool results are user-ROLE messages without
    // being anything the user typed.
    if (message?.source?.kind !== 'user') return null
    const text = textOfContent(message.content)
    return text === '' ? null : { sessionId: session.id, source: 'user', at: event.time, text }
  }

  const data = event.data as { message?: { content?: unknown } } | null
  const text = textOfContent(data?.message?.content)
  return text === '' ? null : { sessionId: session.id, source: 'assistant', at: event.time, text }
}

// ─── the projection unit ─────────────────────────────────────────────────────

/**
 * The projection key this plugin's mention unit owns.
 *
 * A projection is the only sanctioned way to know what a session said: the
 * framework folds it over the log — including the history of a session that was
 * restored from disk — and hands the result back synchronously, which is exactly
 * what "open an old conversation and see what it mentioned" needs. Reading the
 * event log directly is deprecated for new code.
 */
export const MENTION_PROJECTION_KEY = 'stockPortfolioMentions'

/** Bump when the fold or the state shape changes, so old checkpoints are dropped. */
export const MENTION_STATE_VERSION = 1

/** How many turns one session's state keeps; the feed is about the recent past. */
export const MENTION_BATCH_LIMIT = 40

/**
 * One session's mention state: what the fold produces and what the browser reads.
 *
 * Plain JSON by contract (the framework checkpoints it), and small: a batch is a
 * few short fields.
 */
export interface MentionState {
  /** The session this state belongs to; the batches do not repeat it. */
  readonly sessionId: string
  /** A subagent session is skipped whole — its turns are not the conversation. */
  readonly skip: boolean
  /** The turns that named something, oldest first. */
  readonly batches: readonly MentionBatch[]
  /** Monotonic revision: the browser's change cursor, and it never goes back. */
  readonly rev: number
}

/** The session facts {@link initMentionState} reads. */
export interface SessionHeaderLike {
  readonly id: unknown
  readonly origin?: string | undefined
}

/**
 * The empty state for one session.
 * @param header - the session's immutable header.
 * @returns the initial state.
 */
export function initMentionState(header: SessionHeaderLike): MentionState {
  return {
    sessionId: String(header.id),
    skip: header.origin === 'subagent',
    batches: [],
    rev: 0,
  }
}

/**
 * Fold one committed event into the state.
 *
 * The same-reference rule matters: an event this unit does not care about must
 * return the state it was given, or every message in every session would count
 * as a change and wake the browser.
 * @param state - the state covering all prior events.
 * @param event - the next committed event.
 * @param match - the matcher for the portfolio's current symbols.
 * @returns the next state.
 */
export function foldMentionState(
  state: MentionState,
  event: SessionEventLike,
  match: (text: string) => readonly MentionMatch[],
): MentionState {
  if (state.skip) return state
  const message = projectMessage({ id: state.sessionId, header: {} }, event)
  if (message === null) return state
  const matches = match(message.text)
  const first = matches[0]
  if (first === undefined) return state

  const rev = state.rev + 1
  const batch: MentionBatch = {
    rev,
    source: message.source,
    at: message.at,
    symbols: matches.map(hit => hit.symbol),
    excerpt: excerptFor(message.text, first),
  }
  const batches = [...state.batches, batch]
  return {
    ...state,
    rev,
    // The revision keeps climbing after the oldest batches fall off, so the
    // browser's cursor stays meaningful for the lifetime of the session.
    batches: batches.length > MENTION_BATCH_LIMIT ? batches.slice(batches.length - MENTION_BATCH_LIMIT) : batches,
  }
}

/**
 * Validate a value as a mention state.
 *
 * The framework calls this before a checkpointed value seeds a fold, so a state
 * written by an older version is discarded rather than forward-applied into
 * nonsense. It is also the reason this module owns the shape: nothing else may
 * decide what a readable state looks like.
 * @param value - the candidate state.
 * @returns the state.
 * @throws {TypeError} when the value is not a mention state.
 */
export function parseMentionState(value: unknown): MentionState {
  const record = value as Partial<MentionState> | null | undefined
  if (record === null || typeof record !== 'object') throw new TypeError('mention state must be an object')
  if (typeof record.sessionId !== 'string') throw new TypeError('mention state needs a sessionId')
  if (typeof record.skip !== 'boolean') throw new TypeError('mention state needs a skip flag')
  if (typeof record.rev !== 'number' || !Number.isSafeInteger(record.rev) || record.rev < 0) {
    throw new TypeError('mention state needs a non-negative integer rev')
  }
  if (!Array.isArray(record.batches)) throw new TypeError('mention state needs a batches array')
  const batches = record.batches.map((batch: unknown) => {
    const row = batch as Partial<MentionBatch> | null | undefined
    if (row === null || typeof row !== 'object') throw new TypeError('mention batch must be an object')
    if (typeof row.rev !== 'number' || typeof row.at !== 'number') throw new TypeError('mention batch needs rev and at')
    if (row.source !== 'user' && row.source !== 'assistant') throw new TypeError('mention batch needs a source')
    if (!Array.isArray(row.symbols) || typeof row.excerpt !== 'string') {
      throw new TypeError('mention batch needs symbols and an excerpt')
    }
    return {
      rev: row.rev,
      at: row.at,
      source: row.source,
      symbols: row.symbols.map(symbol => String(symbol)),
      excerpt: row.excerpt,
    }
  })
  return { sessionId: record.sessionId, skip: record.skip, rev: record.rev, batches }
}

/**
 * The projection unit this plugin registers.
 *
 * Kept here, apart from the plugin body, so the contract the framework actually
 * reads — the key, the schema, the version, and the fold — is one testable
 * object rather than three literals inside an `apply`.
 * @param match - a supplier for the portfolio's current matcher. A supplier and
 * not the matcher itself: the fold runs on every committed event of every
 * session, and the matcher is rebuilt when the portfolio changes.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function mentionProjectionUnit(match: () => (text: string) => readonly MentionMatch[]): {
  key: string
  stateSchema: { parse(value: unknown): MentionState }
  init(header: SessionHeaderLike): MentionState
  apply(state: MentionState, event: SessionEventLike): MentionState
  stateVersion: number
} {
  return {
    key: MENTION_PROJECTION_KEY,
    stateSchema: { parse: parseMentionState },
    init: initMentionState,
    apply: (state, event) => foldMentionState(state, event, match()),
    stateVersion: MENTION_STATE_VERSION,
  }
}

/**
 * The wire feed for one session's state.
 * @param state - the state, or `undefined` when the session has none.
 * @returns the feed the browser reads.
 */
export function mentionFeedOf(state: MentionState | undefined): MentionFeed {
  if (state === undefined) return { rev: 0, batches: [] }
  return { rev: state.rev, batches: [...state.batches] }
}
