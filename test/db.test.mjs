/**
 * The storage layer's two load-bearing behaviours: the schema migration, and the
 * windowed "latest close per symbol" query.
 *
 * The migration matters because it is the only code path that touches a database
 * a user already has. It must carry trades forward and discard only caches.
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { DEFAULT_SETTINGS, PortfolioDatabase, databasePath, displayPath } from '../lib/index.js'

const dirs = []

/** Create a scratch data directory. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'dsp-db-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test('a v1 database migrates to the current schema without losing a single trade', () => {
  const dir = scratch()
  const path = databasePath(dir)

  // Hand-build the schema this plugin shipped first: `market` instead of
  // `exchange`, plus the two price tables that no longer exist.
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, market TEXT NOT NULL,
      currency TEXT NOT NULL, name TEXT, side TEXT NOT NULL, quantity REAL NOT NULL,
      price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, traded_at TEXT NOT NULL,
      motive TEXT, note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE holdings (
      symbol TEXT PRIMARY KEY, market TEXT NOT NULL, currency TEXT NOT NULL, name TEXT,
      quantity REAL NOT NULL, avg_cost REAL NOT NULL, cost_basis REAL NOT NULL,
      realized_pnl REAL NOT NULL, fees REAL NOT NULL, trade_count INTEGER NOT NULL,
      first_trade_at TEXT NOT NULL, last_trade_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE quotes (symbol TEXT PRIMARY KEY, price REAL NOT NULL, currency TEXT NOT NULL,
      name TEXT, prev_close REAL, open REAL, high REAL, low REAL, volume REAL,
      source TEXT NOT NULL, as_of TEXT NOT NULL, fetched_at TEXT NOT NULL);
    CREATE TABLE klines (symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL,
      high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
      PRIMARY KEY (symbol, date));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `)
  legacy.prepare(
    'INSERT INTO trades (symbol, market, currency, name, side, quantity, price, fee, traded_at, motive, note, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('00700.HK', 'HK', 'HKD', '腾讯控股', 'buy', 100, 400, 50, '2026-06-01', '财报超预期', null,
    '2026-06-01T00:00:00.000Z')
  legacy.prepare('INSERT INTO quotes (symbol, price, currency, source, as_of, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('00700.HK', 428.4, 'HKD', 'tickflow', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')
  legacy.close()

  const db = new PortfolioDatabase(path)
  try {
    const trades = db.listTrades()
    assert.equal(trades.length, 1, 'the trade log must survive the migration')
    assert.equal(trades[0].symbol, '00700.HK')
    // `market` held `HK`, which is already a valid exchange code.
    assert.equal(trades[0].exchange, 'HK')
    assert.equal(trades[0].currency, 'HKD')
    assert.equal(trades[0].motive, '财报超预期')

    // The holdings projection is rebuilt from the surviving log at open.
    const holdings = db.listHoldings()
    assert.equal(holdings.length, 1)
    assert.equal(holdings[0].quantity, 100)
    // The old fee is gone with the column it lived in: the basis is the shares
    // at their price, nothing else.
    assert.equal(holdings[0].avgCost, 400)
    assert.equal(holdings[0].exchange, 'HK')
    assert.equal('fee' in trades[0], false)

    // The caches are gone; a fresh database's tables are in place instead.
    assert.equal(db.latestPriceDate(), null)
    assert.equal(db.instrumentCount(), 0)
    const check = new DatabaseSync(path)
    const names = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(row => row.name)
    assert.equal(names.includes('quotes'), false)
    assert.equal(names.includes('klines'), false)
    // v3 dropped the fee column from the log as well.
    const columns = check.prepare('PRAGMA table_info(trades)').all()
    check.close()
    assert.equal(columns.some(column => column.name === 'fee'), false)
    assert.ok(names.includes('prices'))
    assert.ok(names.includes('instruments'))
  } finally {
    db.close()
  }
})

test('a v2 database keeps its log and loses only the fee column', () => {
  const dir = scratch()
  const path = databasePath(dir)

  // The schema this plugin shipped before fees were dropped: `exchange` is
  // already correct, `trades.fee` and `holdings.fees` still exist.
  const legacy = new DatabaseSync(path)
  legacy.exec(`
    PRAGMA user_version = 2;
    CREATE TABLE trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, exchange TEXT NOT NULL,
      currency TEXT NOT NULL, name TEXT, side TEXT NOT NULL, quantity REAL NOT NULL,
      price REAL NOT NULL, fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0), traded_at TEXT NOT NULL,
      motive TEXT, note TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE holdings (
      symbol TEXT PRIMARY KEY, exchange TEXT NOT NULL, currency TEXT NOT NULL, name TEXT,
      quantity REAL NOT NULL, avg_cost REAL NOT NULL, cost_basis REAL NOT NULL,
      realized_pnl REAL NOT NULL, fees REAL NOT NULL, trade_count INTEGER NOT NULL,
      first_trade_at TEXT NOT NULL, last_trade_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `)
  const insert = legacy.prepare(
    'INSERT INTO trades (id, symbol, exchange, currency, name, side, quantity, price, fee, '
    + 'traded_at, motive, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  insert.run(1, '600000.SH', 'SH', 'CNY', '浦发银行', 'buy', 1000, 9, 5, '2026-06-01', '低估值买入', null,
    '2026-06-01T00:00:00.000Z')
  insert.run(2, '600000.SH', 'SH', 'CNY', '浦发银行', 'sell', 400, 11, 3, '2026-07-01', '止盈', null,
    '2026-07-01T00:00:00.000Z')
  legacy.close()

  const db = new PortfolioDatabase(path)
  try {
    const trades = db.listTrades()
    assert.equal(trades.length, 2, 'both rows must survive the rebuild')
    assert.deepEqual(trades.map(row => row.id), [1, 2], 'ids are preserved, so the UI keeps its handles')
    assert.deepEqual(trades.map(row => row.side), ['buy', 'sell'])
    assert.equal('fee' in trades[0], false)

    // The projection is rebuilt from the surviving log, at gross cost:
    // 1000 * 9 = 9000, sold 400 -> 3600 removed, 600 left costing 5400.
    const [holding] = db.listHoldings()
    assert.equal(holding.quantity, 600)
    assert.equal(holding.avgCost, 9)
    assert.equal(holding.costBasis, 5400)
    assert.equal(holding.realizedPnl, 800)
    assert.equal(holding.tradeCount, 2)
    assert.equal('fees' in holding, false)
  } finally {
    db.close()
  }
})

test('a path is rendered with the home directory collapsed', () => {
  // The settings page shows where the database lives and nothing more: a full
  // home path is noise on screen and a leak in a screenshot, and the plugin
  // never writes one down — it computes it from $DSH_HOME or the OS home.
  assert.equal(displayPath('/home/ann/.dsh/storages/stock-portfolio/portfolio.db', '/home/ann'),
    '~/.dsh/storages/stock-portfolio/portfolio.db')
  // Trailing slashes on either side must not produce `~~` or a doubled separator.
  assert.equal(displayPath('/home/ann/x.db', '/home/ann/'), '~/x.db')
  // Outside the home directory the real path is the honest answer.
  assert.equal(displayPath('/srv/data/x.db', '/home/ann'), '/srv/data/x.db')
  assert.equal(displayPath('/home/ann', '/home/ann'), '/home/ann')
})

test('a fresh database opens at the current version without migrating', () => {
  const dir = scratch()
  const db = new PortfolioDatabase(databasePath(dir))
  try {
    assert.equal(db.listTrades().length, 0)
    assert.equal(db.readSettings().baseCurrency, 'CNY')
    assert.equal(db.readSettings().refreshIntervalMinutes, 360)
  } finally {
    db.close()
  }
})

test('latestQuotes pairs the newest close with the one before it, per symbol', () => {
  const dir = scratch()
  const db = new PortfolioDatabase(databasePath(dir))
  try {
    db.upsertPrices([
      { symbol: '600000.SH', date: '2026-09-08', open: 9.4, high: 9.5, low: 9.3, close: 9.4, volume: 1, amount: 0 },
      { symbol: '600000.SH', date: '2026-09-09', open: 9.4, high: 9.4, low: 9.3, close: 9.35, volume: 1, amount: 0 },
      { symbol: '600000.SH', date: '2026-09-10', open: 9.35, high: 9.3, low: 9.2, close: 9.26, volume: 1, amount: 0 },
      { symbol: 'AAPL.US', date: '2026-09-10', open: 316, high: 327, low: 316, close: 326.57, volume: 1, amount: 0 },
      { symbol: '00700.HK', date: '2026-09-09', open: 425, high: 426, low: 424, close: 425.6, volume: 1, amount: 0 },
      { symbol: '00700.HK', date: '2026-09-10', open: 426, high: 429, low: 425, close: 428.4, volume: 1, amount: 0 },
    ])

    const quotes = db.latestQuotes(new Date('2026-09-11T00:00:00Z'), new Map([['600000.SH', '浦发银行']]))
    assert.deepEqual(quotes.map(row => row.symbol), ['00700.HK', '600000.SH', 'AAPL.US'])

    const sh = quotes.find(row => row.symbol === '600000.SH')
    assert.equal(sh.price, 9.26)
    assert.equal(sh.prevClose, 9.35)
    assert.equal(sh.date, '2026-09-10')
    assert.equal(sh.currency, 'CNY')
    assert.equal(sh.exchange, 'SH')
    assert.equal(sh.name, '浦发银行')
    assert.equal(sh.stale, false)
    assert.equal(Math.round((sh.changePct ?? 0) * 1e6) / 1e6, Math.round(((9.26 - 9.35) / 9.35) * 1e6) / 1e6)

    const hk = quotes.find(row => row.symbol === '00700.HK')
    assert.equal(hk.currency, 'HKD')
    // A single-bar history leaves the day move unknown rather than zero.
    const us = quotes.find(row => row.symbol === 'AAPL.US')
    assert.equal(us.prevClose, null)
    assert.equal(us.change, null)
    assert.equal(us.changePct, null)
  } finally {
    db.close()
  }
})

test('a close older than the staleness window is flagged', () => {
  const dir = scratch()
  const db = new PortfolioDatabase(databasePath(dir))
  try {
    db.upsertPrices([
      { symbol: 'SUSPEND.SH', date: '2026-01-05', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 0 },
    ])
    const [quote] = db.latestQuotes(new Date('2026-09-11T00:00:00Z'), new Map())
    assert.equal(quote.stale, true)
  } finally {
    db.close()
  }
})

test('prices are keyed by symbol and date, so a re-fetch updates in place', () => {
  const dir = scratch()
  const db = new PortfolioDatabase(databasePath(dir))
  try {
    const bar = { symbol: 'AAPL.US', date: '2026-09-10', open: 1, high: 2, low: 1, close: 2, volume: 1, amount: 0 }
    db.upsertPrices([bar])
    db.upsertPrices([{ ...bar, close: 999 }])
    const closes = db.readCloses(['AAPL.US']).get('AAPL.US')
    assert.equal(closes.length, 1)
    assert.equal(closes[0].close, 999)
    assert.equal(db.latestPriceDate(), '2026-09-10')
  } finally {
    db.close()
  }
})

test('instrument search prefers an exact symbol, then a prefix, then a name match', () => {
  const dir = scratch()
  const db = new PortfolioDatabase(databasePath(dir))
  try {
    db.upsertInstruments([
      { symbol: '600000.SH', exchange: 'SH', code: '600000', name: '浦发银行', type: 'stock', currency: 'CNY' },
      { symbol: '600004.SH', exchange: 'SH', code: '600004', name: '白云机场', type: 'stock', currency: 'CNY' },
      { symbol: '000300.SH', exchange: 'SH', code: '000300', name: '沪深300', type: 'index', currency: 'CNY' },
      { symbol: '00700.HK', exchange: 'HK', code: '00700', name: '腾讯控股', type: 'stock', currency: 'HKD' },
    ])
    assert.equal(db.instrumentCount(), 4)

    assert.equal(db.searchInstruments('600000')[0].symbol, '600000.SH')
    assert.equal(db.searchInstruments('6000')[0].symbol, '600000.SH')
    assert.equal(db.searchInstruments('腾讯')[0].symbol, '00700.HK')
    assert.equal(db.searchInstruments('沪深300')[0].symbol, '000300.SH')
    assert.equal(db.searchInstruments('沪深300')[0].type, 'index')
    assert.deepEqual(db.searchInstruments('   '), [])
    assert.deepEqual(db.searchInstruments('NOTHING'), [])

    // A name lookup answers only for symbols the index actually carries.
    const names = db.namesOf(['00700.HK', 'ZZZZ.US'])
    assert.equal(names.get('00700.HK'), '腾讯控股')
    assert.equal(names.has('ZZZZ.US'), false)
  } finally {
    db.close()
  }
})

test('the meta watermarks live beside settings without polluting them', () => {
  const dir = scratch()
  const db = new PortfolioDatabase(databasePath(dir))
  try {
    assert.equal(db.readMeta('instrumentsSyncedAt'), null)
    db.writeMeta('instrumentsSyncedAt', '2026-09-11T00:00:00.000Z')
    assert.equal(db.readMeta('instrumentsSyncedAt'), '2026-09-11T00:00:00.000Z')
    // The settings reader never sees the `meta.` rows. Counted against the
    // shipped defaults, so adding a setting cannot silently make this vacuous.
    assert.equal(
      Object.keys(db.readSettings()).length,
      Object.keys(DEFAULT_SETTINGS).length,
    )
  } finally {
    db.close()
  }
})
