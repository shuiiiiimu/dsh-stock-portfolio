/**
 * Symbol normalization across every market TickFlow covers.
 *
 * Two cases are load-bearing. The Hong Kong five-digit padding, because TickFlow
 * answers an unpadded code with an empty result set rather than an error — a
 * regression there looks like "the price feed is broken". And the bare-code
 * inference, because that is what a user types, and a wrong guess must be visible
 * in the resolved symbol rather than silent.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  currencyOfSymbol, exchangeLabel, exchangeOfSymbol, inferMainlandExchange, normalizeSymbol, padHongKongCode,
} from '../lib/index.js'

test('pads Hong Kong codes to the five digits the exchange uses', () => {
  assert.equal(padHongKongCode('700'), '00700')
  assert.equal(padHongKongCode('0700'), '00700')
  assert.equal(padHongKongCode('00700'), '00700')
  assert.equal(padHongKongCode('9988'), '09988')
  // A non-numeric code is left alone so the API's own "not found" surfaces.
  assert.equal(padHongKongCode('ABC'), 'ABC')
})

test('accepts an explicit suffix for every market, in any case', () => {
  const cases = [
    ['600000.SH', '600000.SH'],
    ['600000.sh', '600000.SH'],
    ['  000001.SZ  ', '000001.SZ'],
    ['430047.BJ', '430047.BJ'],
    ['510300.SH', '510300.SH'],
    ['000300.SH', '000300.SH'],
    ['700.HK', '00700.HK'],
    ['0700.hk', '00700.HK'],
    ['00700.HK', '00700.HK'],
    ['aapl', 'AAPL.US'],
    ['AAPL.us', 'AAPL.US'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(normalizeSymbol(input).symbol, expected, `${input} -> ${expected}`)
  }
})

test('infers the market from a bare code the way a broker app does', () => {
  const cases = [
    // Five digits or fewer can only be Hong Kong.
    ['700', '00700.HK'],
    ['9988', '09988.HK'],
    // Six digits: the prefix is the exchange's own allocation.
    ['600000', '600000.SH'],
    ['688981', '688981.SH'],
    ['601398', '601398.SH'],
    ['000001', '000001.SZ'],
    ['002594', '002594.SZ'],
    ['300750', '300750.SZ'],
    ['430047', '430047.BJ'],
    ['830799', '830799.BJ'],
    // Funds: 5xx is Shanghai, 15x is Shenzhen.
    ['510300', '510300.SH'],
    ['159915', '159915.SZ'],
    // Letters are always a US ticker; no other covered market uses them.
    ['AAPL', 'AAPL.US'],
    ['TSLA', 'TSLA.US'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(normalizeSymbol(input).symbol, expected, `${input} -> ${expected}`)
  }
})

test('resolves a bare prefix to the right mainland exchange', () => {
  assert.equal(inferMainlandExchange('600000'), 'SH')
  assert.equal(inferMainlandExchange('900901'), 'SH')
  assert.equal(inferMainlandExchange('512880'), 'SH')
  assert.equal(inferMainlandExchange('000001'), 'SZ')
  assert.equal(inferMainlandExchange('200011'), 'SZ')
  assert.equal(inferMainlandExchange('159915'), 'SZ')
  assert.equal(inferMainlandExchange('430047'), 'BJ')
  assert.equal(inferMainlandExchange('830799'), 'BJ')
})

test('keeps a dotted class share as part of the code', () => {
  // `BRK.B.US` is the exchange's own form; the dash spelling is the common typo.
  assert.equal(normalizeSymbol('BRK.B.US').symbol, 'BRK.B.US')
  assert.equal(normalizeSymbol('BRK-B.US').symbol, 'BRK.B.US')
  assert.equal(normalizeSymbol('BRK.B').symbol, 'BRK.B.US')
})

test('derives currency from the exchange, never from a guess', () => {
  assert.equal(currencyOfSymbol('600000.SH'), 'CNY')
  assert.equal(currencyOfSymbol('000001.SZ'), 'CNY')
  assert.equal(currencyOfSymbol('430047.BJ'), 'CNY')
  assert.equal(currencyOfSymbol('00700.HK'), 'HKD')
  assert.equal(currencyOfSymbol('AAPL.US'), 'USD')
  assert.equal(exchangeOfSymbol('00700.HK'), 'HK')
  assert.equal(normalizeSymbol('600000').currency, 'CNY')
})

test('labels every covered exchange, and passes an unknown one through', () => {
  assert.equal(exchangeLabel('SH'), '上交所')
  assert.equal(exchangeLabel('SZ'), '深交所')
  assert.equal(exchangeLabel('BJ'), '北交所')
  assert.equal(exchangeLabel('HK'), '港股')
  assert.equal(exchangeLabel('US'), '美股')
  // A market TickFlow adds later must degrade to its own code, not to a throw.
  assert.equal(exchangeLabel('XX'), 'XX')
  assert.equal(currencyOfSymbol('FOO.XX'), 'USD')
})

test('rejects what it cannot address', () => {
  for (const input of ['', '   ', '0700.', '1234567', '.HK']) {
    assert.throws(() => normalizeSymbol(input), { name: 'PortfolioError' }, `should reject ${JSON.stringify(input)}`)
  }
  assert.throws(() => exchangeOfSymbol('AAPL'), { name: 'PortfolioError' })
})
