/**
 * SQLite persistence, owned directly by this plugin.
 *
 * ## Why `node:sqlite` and not `ctx.storageDomain`
 *
 * DSH's storage seam exposes a schema-validated key/value domain whose backend
 * the *composition* chooses — this deployment mounts the JSON backend, and the
 * SQLite backend is not part of any shipped composition. The seam also has no
 * query, aggregate, or transaction surface, and a portfolio needs "every trade
 * for this symbol, oldest first", "the latest close per symbol", and "search
 * 23,000 instruments by name".
 *
 * The sanctioned precedent for that is a plugin owning its own `node:sqlite`
 * handle (as `session-query-sqlite` does): the database is ours, lives under
 * `$DSH_HOME/storages/stock-portfolio/`, and needs no composition change beyond
 * this plugin's own row.
 *
 * ## Tables
 *
 *   trades       — the single source of truth. Every position derives from it.
 *   holdings     — the fold of `trades`, materialized per symbol. A durable,
 *                  directly queryable projection (including fully closed symbols,
 *                  whose `quantity` is 0), rebuilt transactionally whenever a
 *                  trade changes. It is a cache of a pure function, never a
 *                  second source of truth: `test/portfolio.test.mjs` asserts the
 *                  two agree.
 *   prices       — one row per symbol per trading day and nothing finer.
 *   instruments  — the local name index: every instrument on every exchange the
 *                  provider carries, fetched once and searched offline.
 *   settings     — plugin-wide key/value, including the market-data API key.
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { foldLedgers } from './portfolio.ts'
import { currencyOfSymbol, exchangeOfSymbol } from './symbols.ts'
import { PortfolioError } from './types.ts'
import type {
  Currency, Exchange, Instrument, InstrumentType, PriceBar, Quote, SymbolBar, Trade, TradeSide,
} from './types.ts'

/** The database file name inside the data directory. */
export const DATABASE_FILE = 'portfolio.db'

/**
 * Structural schema version, stored in `PRAGMA user_version`.
 *
 * v1 held a `quotes` snapshot table and a `klines` cache; v2 replaced both with a
 * single daily `prices` table plus an `instruments` index, and renamed the
 * `market` column to `exchange` once the plugin covered every market rather than
 * two. v3 dropped the per-trade fee: cost basis and realized P&L are gross, so
 * `trades.fee` and `holdings.fees` carry nothing the plugin still reads.
 */
const SCHEMA_VERSION = 3

/**
 * How many days a close may age before the UI calls it stale.
 *
 * Deliberately generous: it must survive a mainland golden week, a Hong Kong
 * typhoon closure and a US holiday run without crying wolf, while still catching
 * a symbol whose data stopped arriving.
 */
export const STALE_AFTER_DAYS = 12

/** Every table, in dependency order. `IF NOT EXISTS` keeps startup idempotent. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol      TEXT    NOT NULL,
  exchange    TEXT    NOT NULL,
  currency    TEXT    NOT NULL,
  name        TEXT,
  side        TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity    REAL    NOT NULL CHECK (quantity > 0),
  price       REAL    NOT NULL CHECK (price >= 0),
  traded_at   TEXT    NOT NULL,
  motive      TEXT,
  note        TEXT,
  created_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS trades_symbol_date ON trades (symbol, traded_at, id);
CREATE INDEX IF NOT EXISTS trades_date        ON trades (traded_at, id);

CREATE TABLE IF NOT EXISTS holdings (
  symbol         TEXT    PRIMARY KEY,
  exchange       TEXT    NOT NULL,
  currency       TEXT    NOT NULL,
  name           TEXT,
  quantity       REAL    NOT NULL,
  avg_cost       REAL    NOT NULL,
  cost_basis     REAL    NOT NULL,
  realized_pnl   REAL    NOT NULL,
  trade_count    INTEGER NOT NULL,
  first_trade_at TEXT    NOT NULL,
  last_trade_at  TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS holdings_open ON holdings (quantity, symbol);

-- One row per symbol per trading day. This is the entire price history the
-- plugin keeps; there is no intraday table by design.
CREATE TABLE IF NOT EXISTS prices (
  symbol TEXT NOT NULL,
  date   TEXT NOT NULL,
  open   REAL NOT NULL,
  high   REAL NOT NULL,
  low    REAL NOT NULL,
  close  REAL NOT NULL,
  volume REAL NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, date)
);

CREATE INDEX IF NOT EXISTS prices_date ON prices (date DESC);

CREATE TABLE IF NOT EXISTS instruments (
  symbol     TEXT PRIMARY KEY,
  exchange   TEXT NOT NULL,
  code       TEXT NOT NULL,
  name       TEXT,
  type       TEXT,
  currency   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS instruments_exchange ON instruments (exchange, code);
CREATE INDEX IF NOT EXISTS instruments_name     ON instruments (name);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

/** A trade row as SQLite returns it. */
interface TradeRow {
  id: number
  symbol: string
  exchange: string
  currency: string
  name: string | null
  side: string
  quantity: number
  price: number
  traded_at: string
  motive: string | null
  note: string | null
  created_at: string
}

/** A `prices` row with its per-symbol recency rank. */
interface PriceRankRow {
  symbol: string
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  rn: number
}

/** User-editable settings with their defaults. */
export interface StoredSettings {
  /** The market-data API key. Empty string means "use the keyless tier". */
  readonly apiKey: string
  readonly baseCurrency: Currency
  /** Units of HKD that one USD buys. */
  readonly usdHkd: number
  /** Units of CNY that one USD buys. */
  readonly usdCny: number
  /** How often the background job re-reads daily bars. */
  readonly refreshIntervalMinutes: number
  readonly autoRefresh: boolean
  /** Whether a conversation turn naming a held symbol pops the panel open. */
  readonly mentionPopup: boolean
}

/** Settings as they stand before the user has changed anything. */
export const DEFAULT_SETTINGS: StoredSettings = {
  apiKey: '',
  baseCurrency: 'CNY',
  // Rounded placeholders. The dashboard exposes both so a user can keep the
  // converted total honest rather than trusting a stale constant.
  usdHkd: 7.8,
  usdCny: 7.15,
  refreshIntervalMinutes: 360,
  autoRefresh: true,
  // On by default: the popup is the feature, and the switch is there for the
  // user who would rather read the answer without the panel moving.
  mentionPopup: true,
}

/**
 * Map a trade row onto the domain type.
 * @param row - the SQLite row.
 * @returns the trade.
 */
function toTrade(row: TradeRow): Trade {
  return {
    id: row.id,
    symbol: row.symbol,
    exchange: row.exchange,
    currency: row.currency as Currency,
    name: row.name,
    side: row.side as TradeSide,
    quantity: row.quantity,
    price: row.price,
    tradedAt: row.traded_at,
    motive: row.motive,
    note: row.note,
    createdAt: row.created_at,
  }
}

/**
 * Resolve the on-disk database path for a data directory.
 * @param dataDir - the configured data directory.
 * @returns the absolute database path.
 */
export function databasePath(dataDir: string): string {
  return `${dataDir.replace(/\/+$/u, '')}/${DATABASE_FILE}`
}

/**
 * Render an absolute path with the home directory collapsed to `~`.
 *
 * For display only — the settings page says where the database lives, and no
 * screen or screenshot needs a full `/Users/<name>/…` in it. The real path is
 * never written down anywhere: it is computed at startup from `$DSH_HOME`, or
 * from the OS home directory when that variable is unset.
 * @param path - the absolute path to render.
 * @param home - the home directory to collapse; defaults to the OS home.
 * @returns the display path, with `~` standing in for the home directory.
 */
export function displayPath(path: string, home: string = homedir()): string {
  const root = home.replace(/\/+$/u, '')
  return root !== '' && path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path
}

/**
 * Whether a trading date is old enough to be worth flagging.
 * @param date - `YYYY-MM-DD`.
 * @param now - the reference instant.
 * @returns true when the date is more than {@link STALE_AFTER_DAYS} days back.
 */
function isStale(date: string, now: Date): boolean {
  const parsed = Date.parse(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed)) return true
  return now.getTime() - parsed > STALE_AFTER_DAYS * 86_400_000
}

/** The plugin's SQLite store. One instance per plugin fiber. */
export class PortfolioDatabase {
  private readonly db: DatabaseSync
  private depth = 0

  /**
   * Open (and create) the database, applying the schema and any migration.
   * @param path - the database file path, or `:memory:` for tests.
   */
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    }
    this.db = new DatabaseSync(path)
    // WAL keeps a dashboard read from blocking a trade write. The file may hold
    // positions and a broker key, so it stays owner-only.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.migrate()
    this.db.exec(SCHEMA)
    this.db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.ensureDefaults()
    if (this.count('trades') > 0) this.rebuildHoldings()
  }

  /**
   * Bring a database written by an older schema forward.
   *
   * Only cached data is dropped: `trades` is the one table a user would miss,
   * and it survives the column rename untouched.
   */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const version = row?.user_version ?? 0
    if (version === 0 || version >= SCHEMA_VERSION) return
    if (version < 2) {
      // `market` held `HK`/`US`, which are already valid exchange codes.
      this.db.exec('ALTER TABLE trades RENAME COLUMN market TO exchange')
      // All three are caches of remote data, re-fetched on the next refresh.
      this.db.exec('DROP TABLE IF EXISTS quotes')
      this.db.exec('DROP TABLE IF EXISTS klines')
      this.db.exec('DROP TABLE IF EXISTS holdings')
    }
    if (version < 3) {
      // SQLite cannot drop a column an index or constraint still names, and the
      // fee carried a CHECK, so the log is rebuilt instead: same rows, one
      // column fewer. `holdings` is a projection of `trades` and is dropped
      // outright — the constructor rebuilds it from the surviving rows.
      this.db.exec('DROP TABLE IF EXISTS holdings')
      this.db.exec(`
        CREATE TABLE trades_v3 (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol      TEXT    NOT NULL,
          exchange    TEXT    NOT NULL,
          currency    TEXT    NOT NULL,
          name        TEXT,
          side        TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
          quantity    REAL    NOT NULL CHECK (quantity > 0),
          price       REAL    NOT NULL CHECK (price >= 0),
          traded_at   TEXT    NOT NULL,
          motive      TEXT,
          note        TEXT,
          created_at  TEXT    NOT NULL
        );
        INSERT INTO trades_v3 (id, symbol, exchange, currency, name, side, quantity, price,
                               traded_at, motive, note, created_at)
          SELECT id, symbol, exchange, currency, name, side, quantity, price,
                 traded_at, motive, note, created_at
          FROM trades;
        DROP TABLE trades;
        ALTER TABLE trades_v3 RENAME TO trades;
      `)
    }
  }

  /** Close the handle. Safe to call once per instance. */
  close(): void {
    this.db.close()
  }

  /**
   * Count rows in one of this module's tables.
   * @param table - the table name; only literals from this module are passed.
   * @returns the row count.
   */
  private count(table: 'trades' | 'instruments' | 'prices'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined
    return row?.n ?? 0
  }

  // ─── settings ──────────────────────────────────────────────────────────────

  /** Seed any setting the user has never written. */
  private ensureDefaults(): void {
    const now = new Date().toISOString()
    const insert = this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
    )
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insert.run(key, JSON.stringify(value), now)
    }
  }

  /**
   * Read every setting, falling back to the shipped default per key.
   * @returns the resolved settings.
   */
  readSettings(): StoredSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as unknown as {
      key: string, value: string
    }[]
    const raw = new Map(rows.map(row => [row.key, row.value]))
    return {
      apiKey: this.readSetting(raw, 'apiKey', DEFAULT_SETTINGS.apiKey, v => typeof v === 'string'),
      baseCurrency: this.readSetting(raw, 'baseCurrency', DEFAULT_SETTINGS.baseCurrency,
        v => v === 'CNY' || v === 'HKD' || v === 'USD'),
      usdHkd: this.readSetting(raw, 'usdHkd', DEFAULT_SETTINGS.usdHkd,
        v => typeof v === 'number' && Number.isFinite(v) && v > 0),
      usdCny: this.readSetting(raw, 'usdCny', DEFAULT_SETTINGS.usdCny,
        v => typeof v === 'number' && Number.isFinite(v) && v > 0),
      refreshIntervalMinutes: this.readSetting(raw, 'refreshIntervalMinutes', DEFAULT_SETTINGS.refreshIntervalMinutes,
        v => typeof v === 'number' && Number.isInteger(v) && v >= 15),
      autoRefresh: this.readSetting(raw, 'autoRefresh', DEFAULT_SETTINGS.autoRefresh,
        v => typeof v === 'boolean'),
      mentionPopup: this.readSetting(raw, 'mentionPopup', DEFAULT_SETTINGS.mentionPopup,
        v => typeof v === 'boolean'),
    }
  }

  /**
   * Decode one stored setting, preferring the default over a corrupt row.
   * @param raw - the raw `key -> JSON text` map.
   * @param key - the setting key.
   * @param fallback - the value to use when the row is absent or invalid.
   * @param accept - type guard for the decoded value.
   * @returns the decoded value or the fallback.
   */
  private readSetting<T>(
    raw: ReadonlyMap<string, string>,
    key: string,
    fallback: T,
    accept: (value: unknown) => boolean,
  ): T {
    const text = raw.get(key)
    if (text === undefined) return fallback
    try {
      const decoded: unknown = JSON.parse(text)
      return accept(decoded) ? (decoded as T) : fallback
    } catch {
      return fallback
    }
  }

  /**
   * Write one setting.
   * @param key - the setting key.
   * @param value - the JSON-serializable value.
   */
  writeSetting(key: keyof StoredSettings, value: unknown): void {
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, JSON.stringify(value), new Date().toISOString())
  }

  /**
   * Read an internal bookkeeping value.
   *
   * Shares the `settings` table but not {@link StoredSettings}: these are the
   * plugin's own sync watermarks, not anything a user edits, so they live under
   * a `meta.` prefix that the settings reader never looks at.
   * @param key - the watermark name.
   * @returns the stored string, or `null` when never written.
   */
  readMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`meta.${key}`) as
      | { value?: string }
      | undefined
    if (row?.value === undefined) return null
    try {
      const decoded: unknown = JSON.parse(row.value)
      return typeof decoded === 'string' ? decoded : null
    } catch {
      /* v8 ignore next -- a corrupt watermark is the same as an absent one. */
      return null
    }
  }

  /**
   * Write an internal bookkeeping value.
   * @param key - the watermark name.
   * @param value - the value to store.
   */
  writeMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(`meta.${key}`, JSON.stringify(value), new Date().toISOString())
  }

  // ─── trades ────────────────────────────────────────────────────────────────

  /**
   * Read every trade, oldest first.
   * @returns the trade log.
   */
  listTrades(): Trade[] {
    const rows = this.db.prepare(
      'SELECT * FROM trades ORDER BY traded_at ASC, id ASC',
    ).all() as unknown as TradeRow[]
    return rows.map(toTrade)
  }

  /**
   * Insert one trade and materialize the holdings projection in the same
   * transaction, so a crash cannot leave the two disagreeing.
   * @param trade - the trade to insert, without its server-owned fields.
   * @returns the inserted trade.
   */
  insertTrade(trade: Omit<Trade, 'id' | 'createdAt'>): Trade {
    const createdAt = new Date().toISOString()
    const id = this.transaction(() => {
      this.db.prepare(
        'INSERT INTO trades (symbol, exchange, currency, name, side, quantity, price, traded_at, motive, note, created_at) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        trade.symbol, trade.exchange, trade.currency, trade.name, trade.side,
        trade.quantity, trade.price, trade.tradedAt,
        trade.motive, trade.note, createdAt,
      )
      const last = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id?: number } | undefined
      this.rebuildHoldings()
      return last?.id ?? 0
    })
    return { ...trade, id, createdAt }
  }

  /**
   * Replace one trade's editable fields.
   * @param id - the trade id.
   * @param trade - the new field values.
   * @returns the updated trade.
   * @throws {PortfolioError} when no trade has that id.
   */
  updateTrade(id: number, trade: Omit<Trade, 'id' | 'createdAt'>): Trade {
    this.transaction(() => {
      const changes = Number(this.db.prepare(
        'UPDATE trades SET symbol = ?, exchange = ?, currency = ?, name = ?, side = ?, quantity = ?, '
        + 'price = ?, traded_at = ?, motive = ?, note = ? WHERE id = ?',
      ).run(
        trade.symbol, trade.exchange, trade.currency, trade.name, trade.side,
        trade.quantity, trade.price, trade.tradedAt,
        trade.motive, trade.note, id,
      ).changes)
      if (changes === 0) throw new PortfolioError(`交易记录 #${String(id)} 不存在`, 404)
      this.rebuildHoldings()
    })
    const row = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as unknown as TradeRow | undefined
    /* v8 ignore next -- the row was just updated inside the same transaction. */
    if (row === undefined) throw new PortfolioError(`交易记录 #${String(id)} 不存在`, 404)
    return toTrade(row)
  }

  /**
   * Delete one trade.
   * @param id - the trade id.
   * @throws {PortfolioError} when no trade has that id.
   */
  deleteTrade(id: number): void {
    this.transaction(() => {
      const changes = Number(this.db.prepare('DELETE FROM trades WHERE id = ?').run(id).changes)
      if (changes === 0) throw new PortfolioError(`交易记录 #${String(id)} 不存在`, 404)
      this.rebuildHoldings()
    })
  }

  /**
   * Distinct motives already in use, most frequent first.
   *
   * Feeds the trade form's suggestion list, so a user reuses their own vocabulary
   * instead of inventing a near-duplicate tag every time.
   * @returns the motive strings.
   */
  listMotives(): string[] {
    const rows = this.db.prepare(
      "SELECT motive, COUNT(*) AS uses FROM trades WHERE motive IS NOT NULL AND TRIM(motive) <> '' "
      + 'GROUP BY TRIM(motive) ORDER BY uses DESC, motive ASC LIMIT 50',
    ).all() as unknown as { motive: string }[]
    return rows.map(row => row.motive)
  }

  // ─── holdings ──────────────────────────────────────────────────────────────

  /**
   * Rebuild the `holdings` projection from the trade log.
   *
   * Runs inside the caller's transaction. Every symbol that has ever traded keeps
   * a row — a fully closed symbol keeps `quantity = 0` so its realized P&L
   * survives for statistics.
   * @param now - the timestamp stamped onto the rows.
   */
  rebuildHoldings(now: Date = new Date()): void {
    const ledgers = foldLedgers(this.listTrades())
    const updatedAt = now.toISOString()
    // Replace rather than merge: a projection that lags a deleted symbol is a
    // worse failure than doing the whole rewrite, and the log is small.
    this.db.exec('DELETE FROM holdings')
    const insert = this.db.prepare(
      'INSERT INTO holdings (symbol, exchange, currency, name, quantity, avg_cost, cost_basis, realized_pnl, '
      + 'trade_count, first_trade_at, last_trade_at, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const ledger of ledgers) {
      insert.run(
        ledger.symbol, ledger.exchange, ledger.currency, ledger.name, ledger.quantity,
        ledger.avgCost, ledger.cost, ledger.realizedPnl, ledger.tradeCount,
        ledger.firstTradeAt, ledger.lastTradeAt, updatedAt,
      )
    }
  }

  /**
   * Read the materialized holdings projection.
   * @returns one row per symbol that has ever traded.
   */
  listHoldings(): {
    symbol: string, exchange: Exchange, currency: Currency, name: string | null, quantity: number,
    avgCost: number, costBasis: number, realizedPnl: number, tradeCount: number,
    firstTradeAt: string, lastTradeAt: string, updatedAt: string,
  }[] {
    const rows = this.db.prepare('SELECT * FROM holdings ORDER BY quantity DESC, symbol ASC').all() as unknown as {
      symbol: string, exchange: string, currency: string, name: string | null, quantity: number,
      avg_cost: number, cost_basis: number, realized_pnl: number, trade_count: number,
      first_trade_at: string, last_trade_at: string, updated_at: string,
    }[]
    return rows.map(row => ({
      symbol: row.symbol,
      exchange: row.exchange,
      currency: row.currency as Currency,
      name: row.name,
      quantity: row.quantity,
      avgCost: row.avg_cost,
      costBasis: row.cost_basis,
      realizedPnl: row.realized_pnl,
      tradeCount: row.trade_count,
      firstTradeAt: row.first_trade_at,
      lastTradeAt: row.last_trade_at,
      updatedAt: row.updated_at,
    }))
  }

  // ─── prices ────────────────────────────────────────────────────────────────

  /**
   * The latest daily close per symbol, with the move against the day before.
   *
   * One windowed query rather than a query per symbol: `rn = 1` is the latest bar
   * and `rn = 2` the previous one, so the day's change needs no second pass.
   * @param now - the clock used to decide staleness.
   * @param names - display names, keyed by symbol.
   * @returns the quote rows, symbol-sorted.
   */
  latestQuotes(now: Date, names: ReadonlyMap<string, string | null>): Quote[] {
    const rows = this.db.prepare(
      'SELECT symbol, date, open, high, low, close, volume, rn FROM ('
      + '  SELECT symbol, date, open, high, low, close, volume, '
      + '         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn '
      + '  FROM prices'
      + ') WHERE rn <= 2 ORDER BY symbol ASC, date DESC',
    ).all() as unknown as PriceRankRow[]

    const latest = new Map<string, PriceRankRow>()
    const previous = new Map<string, PriceRankRow>()
    for (const row of rows) {
      if (row.rn === 1) latest.set(row.symbol, row)
      else previous.set(row.symbol, row)
    }

    return [...latest.values()].map((row) => {
      const prevClose = previous.get(row.symbol)?.close ?? null
      const change = prevClose === null ? null : row.close - prevClose
      return {
        symbol: row.symbol,
        name: names.get(row.symbol) ?? null,
        exchange: exchangeOfSymbol(row.symbol),
        currency: currencyOfSymbol(row.symbol),
        price: row.close,
        prevClose,
        open: row.open,
        high: row.high,
        low: row.low,
        volume: row.volume,
        date: row.date,
        change,
        changePct: change === null || prevClose === null || prevClose === 0 ? null : change / prevClose,
        stale: isStale(row.date, now),
      }
    }).sort((left, right) => left.symbol.localeCompare(right.symbol))
  }

  /**
   * Upsert daily bars. Idempotent: re-fetching an overlapping window is free.
   * @param bars - the bars to store.
   */
  upsertPrices(bars: readonly PriceBar[]): void {
    const statement = this.db.prepare(
      'INSERT INTO prices (symbol, date, open, high, low, close, volume, amount) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(symbol, date) DO UPDATE SET open = excluded.open, high = excluded.high, '
      + 'low = excluded.low, close = excluded.close, volume = excluded.volume, amount = excluded.amount',
    )
    this.transaction(() => {
      for (const bar of bars) {
        statement.run(bar.symbol, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount)
      }
    })
  }

  /**
   * Read stored daily closes for a set of symbols.
   * @param symbols - the symbols to read.
   * @returns ascending closes keyed by symbol.
   */
  readCloses(symbols: readonly string[]): Map<string, { date: string, close: number }[]> {
    const closes = new Map<string, { date: string, close: number }[]>()
    if (symbols.length === 0) return closes
    const statement = this.db.prepare(
      'SELECT date, close FROM prices WHERE symbol = ? ORDER BY date ASC',
    )
    for (const symbol of symbols) {
      const rows = statement.all(symbol) as unknown as { date: string, close: number }[]
      closes.set(symbol, rows)
    }
    return closes
  }

  /**
   * Read one symbol's trailing daily bars, newest `limit` rows, ascending.
   *
   * The expanded holdings row draws from this: a close line, a volume column per
   * bar, and the 60-bar window the indicators measure. Newest-first is the only
   * order SQLite can answer without sorting the whole symbol, so the tail is
   * selected descending and reversed here.
   * @param symbol - the canonical symbol.
   * @param limit - how many trailing bars to return.
   * @returns ascending bars; empty when nothing has been fetched for the symbol.
   */
  readBars(symbol: string, limit: number): SymbolBar[] {
    const rows = this.db.prepare(
      'SELECT date, high, low, close, volume FROM prices WHERE symbol = ? ORDER BY date DESC LIMIT ?',
    ).all(symbol, Math.max(1, Math.floor(limit))) as unknown as SymbolBar[]
    return rows.reverse()
  }

  /**
   * The newest trading date held for any symbol.
   * @returns `YYYY-MM-DD`, or `null` when no price has been fetched.
   */
  latestPriceDate(): string | null {
    const row = this.db.prepare('SELECT MAX(date) AS date FROM prices').get() as { date?: string | null } | undefined
    return row?.date ?? null
  }

  /**
   * The newest stored bar date per symbol.
   *
   * How far behind a series is, is one number per symbol, and it is what decides
   * whether a refresh needs to ask the provider at all. Only symbols that have
   * ever been priced appear, so this reads the primary-key index and returns a
   * row per holding rather than per instrument.
   * @returns the newest date per symbol, for every symbol that has bars.
   */
  latestPriceDates(): Map<string, string> {
    const rows = this.db.prepare('SELECT symbol, MAX(date) AS date FROM prices GROUP BY symbol').all() as unknown as {
      symbol: string, date: string,
    }[]
    return new Map(rows.map(row => [row.symbol, row.date]))
  }

  // ─── instruments ───────────────────────────────────────────────────────────

  /**
   * Upsert the instrument index.
   * @param instruments - the rows to store.
   */
  upsertInstruments(instruments: readonly Instrument[]): void {
    const statement = this.db.prepare(
      'INSERT INTO instruments (symbol, exchange, code, name, type, currency, updated_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(symbol) DO UPDATE SET exchange = excluded.exchange, code = excluded.code, '
      + 'name = excluded.name, type = excluded.type, currency = excluded.currency, '
      + 'updated_at = excluded.updated_at',
    )
    const updatedAt = new Date().toISOString()
    this.transaction(() => {
      for (const row of instruments) {
        statement.run(row.symbol, row.exchange, row.code, row.name, row.type, row.currency, updatedAt)
      }
    })
  }

  /** How many instruments the local name index holds. */
  instrumentCount(): number {
    return this.count('instruments')
  }

  /**
   * Search the instrument index by symbol prefix or name substring.
   *
   * Local by design: the whole index is ~23,000 rows, so a query is instant,
   * works offline, and costs no API quota.
   * @param query - the raw search text.
   * @param limit - maximum rows to return.
   * @returns best matches first: exact symbol, then symbol prefix, then name.
   */
  searchInstruments(query: string, limit = 12): Instrument[] {
    const trimmed = query.trim()
    if (trimmed === '') return []
    const upper = trimmed.toUpperCase()
    const rows = this.db.prepare(
      'SELECT symbol, exchange, code, name, type, currency FROM instruments '
      + 'WHERE symbol = ? OR symbol LIKE ? OR code LIKE ? OR name LIKE ? '
      + 'ORDER BY CASE WHEN symbol = ? THEN 0 WHEN symbol LIKE ? THEN 1 ELSE 2 END, '
      + '         LENGTH(symbol), symbol '
      + 'LIMIT ?',
    ).all(upper, `${upper}%`, `${upper}%`, `%${trimmed}%`, upper, `${upper}%`, limit) as unknown as {
      symbol: string, exchange: string, code: string, name: string | null,
      type: string | null, currency: string,
    }[]
    return rows.map(row => ({
      symbol: row.symbol,
      exchange: row.exchange,
      code: row.code,
      name: row.name,
      type: row.type as InstrumentType | null,
      currency: row.currency as Currency,
    }))
  }

  /**
   * Look up display names for specific symbols.
   * @param symbols - canonical symbols.
   * @returns a name lookup keyed by symbol, for every symbol the index carries.
   */
  namesOf(symbols: readonly string[]): Map<string, string | null> {
    const names = new Map<string, string | null>()
    if (symbols.length === 0) return names
    const statement = this.db.prepare('SELECT name FROM instruments WHERE symbol = ?')
    for (const symbol of symbols) {
      const row = statement.get(symbol) as { name?: string | null } | undefined
      if (row !== undefined) names.set(symbol, row.name ?? null)
    }
    return names
  }

  /**
   * Run a function inside a transaction, rolling back on any throw.
   *
   * `node:sqlite` has no transaction helper of its own, and a nested BEGIN would
   * be a syntax error, so the depth counter makes this re-entrant.
   * @param work - the work to run.
   * @returns whatever `work` returns.
   */
  private transaction<T>(work: () => T): T {
    if (this.depth > 0) return work()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth += 1
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.depth -= 1
    }
  }
}
