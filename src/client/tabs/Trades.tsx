/**
 * Trades: the trade log and its editor.
 *
 * The form is the same component for adding and editing, because the fields are
 * identical and a user correcting a typo should not meet a different UI. It is
 * COLLAPSED by default: the section's job on most visits is to show the log, and
 * an always-open form pushed it below the fold.
 *
 * The `motive` field is deliberately prominent — it is the field the whole
 * analysis tab is built on, so it gets its own full-width row, a per-direction
 * set of quick-pick motives, the motives already in use, and a hint explaining
 * what it is for. The quick picks differ by direction because the two decisions
 * are not the same decision: nobody sells because the valuation is attractive.
 * The list itself is shared with the chat tool (`src/motives.ts`) so a trade
 * recorded by talking to the model carries the same vocabulary as one typed
 * here, which is what keeps the by-motive breakdown meaningful.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconCheckOutline16, IconCloseOutline16, IconEditOutline16, IconPlusOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { Empty, SectionTitle } from '../shared.tsx'
import { api } from '../api.ts'
import { money, quantity, today, tone } from '../format.ts'
import { MOTIVE_HISTORY_LIMIT, MOTIVE_PRESETS } from '../../motives.ts'
import type { PortfolioState, SymbolMatch, Trade, TradeInput } from '../../types.ts'

/** The editable shape of the form. */
interface Draft {
  symbol: string
  side: 'buy' | 'sell'
  quantity: string
  price: string
  tradedAt: string
  motive: string
  note: string
}

/** A blank draft dated today. */
function blankDraft(): Draft {
  return {
    symbol: '',
    side: 'buy',
    quantity: '',
    price: '',
    tradedAt: today(),
    motive: '',
    note: '',
  }
}

/**
 * Turn a stored trade back into editable text.
 * @param trade - the stored trade.
 * @returns the draft.
 */
function draftOf(trade: Trade): Draft {
  return {
    symbol: trade.symbol,
    side: trade.side,
    quantity: String(trade.quantity),
    price: String(trade.price),
    tradedAt: trade.tradedAt,
    motive: trade.motive ?? '',
    note: trade.note ?? '',
  }
}

/**
 * Convert a draft into the API payload.
 * @param draft - the form contents.
 * @returns the trade fields; numeric parsing happens here so the host receives numbers.
 */
function payloadOf(draft: Draft): TradeInput {
  return {
    symbol: draft.symbol.trim(),
    side: draft.side,
    quantity: Number(draft.quantity),
    price: Number(draft.price),
    tradedAt: draft.tradedAt,
    motive: draft.motive.trim() === '' ? null : draft.motive.trim(),
    note: draft.note.trim() === '' ? null : draft.note.trim(),
  }
}

/**
 * Render the trade log section.
 * @param props - the loaded state plus the store's mutations.
 * @returns the section element.
 */
export function Trades({ state, busy, onAdd, onUpdate, onDelete }: {
  state: PortfolioState
  busy: string | null
  onAdd: (trade: TradeInput) => Promise<boolean>
  onUpdate: (id: number, trade: TradeInput) => Promise<boolean>
  onDelete: (trade: Trade) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<Draft>(blankDraft)
  const [editing, setEditing] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<SymbolMatch[]>([])
  const [confirming, setConfirming] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const symbolInput = useRef<HTMLInputElement>(null)

  const patch = (fields: Partial<Draft>): void => { setDraft(current => ({ ...current, ...fields })) }

  // Symbol suggestions: only while the symbol field looks like a partial query,
  // and only when it is not already a complete symbol the user just picked.
  useEffect(() => {
    const query = draft.symbol.trim()
    if (query.length < 2 || query === suggestions.find(row => row.symbol === query.toUpperCase())?.symbol) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void api.lookup(query)
        .then(result => { if (!cancelled) setSuggestions(result.matches) })
        .catch(() => { if (!cancelled) setSuggestions([]) })
    }, 320)
    return () => { cancelled = true; clearTimeout(timer) }
    // `suggestions` is read only to suppress a repeat of the picked value; it
    // must not retrigger the lookup, so it is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.symbol])

  const visible = useMemo(() => {
    const needle = filter.trim().toUpperCase()
    const rows = [...state.trades].reverse()
    if (needle === '') return rows
    return rows.filter(row =>
      row.symbol.includes(needle)
      || (row.name ?? '').toUpperCase().includes(needle)
      || (row.motive ?? '').toUpperCase().includes(needle))
  }, [state.trades, filter])

  const invalid = draft.symbol.trim() === '' || !(Number(draft.quantity) > 0) || Number(draft.price) < 0
    || draft.price.trim() === '' || draft.tradedAt.trim() === ''

  /**
   * Submit the form as either an insert or an update.
   * @param event - the form event.
   */
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (invalid) return
    const payload = payloadOf(draft)
    const ok = editing === null ? await onAdd(payload) : await onUpdate(editing, payload)
    if (!ok) return
    setDraft(current => ({ ...blankDraft(), tradedAt: current.tradedAt, side: current.side }))
    setEditing(null)
    setSuggestions([])
    // One save, one look at the log it produced.
    setOpen(false)
  }

  /**
   * Load a trade into the form for editing.
   * @param trade - the trade to edit.
   */
  const startEdit = (trade: Trade): void => {
    setDraft(draftOf(trade))
    setEditing(trade.id)
    setOpen(true)
    setSuggestions([])
    symbolInput.current?.focus()
  }

  /** Leave edit mode and clear the form. */
  const cancelEdit = (): void => {
    setDraft(blankDraft())
    setEditing(null)
    setSuggestions([])
  }

  /**
   * Delete a trade after the inline confirmation.
   * @param trade - the trade to delete.
   */
  const remove = async (trade: Trade): Promise<void> => {
    await onDelete(trade)
    setConfirming(null)
    if (editing === trade.id) cancelEdit()
  }

  /** The quick picks for the direction being recorded. */
  const presets = MOTIVE_PRESETS[draft.side]
  /** Motives the user has already written that are not already offered above. */
  const known = state.motives.filter(
    motive => motive !== draft.motive.trim() && !presets.includes(motive),
  )

  /**
   * Switch direction, dropping a picked quick-pick motive that belongs to the
   * other side — carrying `止盈` into a buy reads as a mistake, and the field is
   * one click away from being refilled.
   */
  const switchSide = (side: 'buy' | 'sell'): void => {
    const carried = draft.motive.trim()
    const belongsToOther = MOTIVE_PRESETS[side === 'buy' ? 'sell' : 'buy'].includes(carried)
    patch({ side, ...belongsToOther ? { motive: '' } : {} })
  }

  return (
    <div>
      <SectionTitle>
        交易
        <button
          type="button"
          className="dsp-btn"
          data-compact="true"
          onClick={() => {
            if (open) cancelEdit()
            setOpen(current => !current)
          }}
        >
          {open ? <IconCloseOutline16 size={13} /> : <IconPlusOutline16 size={13} />}
          {open ? '收起' : '添加交易'}
        </button>
      </SectionTitle>

      {open && (
        <form className="dsp-form" onSubmit={(event) => { void submit(event) }}>
          <div className="dsp-field" style={{ position: 'relative' }}>
            <label className="dsp-field-label" htmlFor="dsp-symbol">股票代码</label>
            <input
              id="dsp-symbol"
              ref={symbolInput}
              className="dsp-input"
              data-mono="true"
              placeholder="600000.SH"
              value={draft.symbol}
              autoComplete="off"
              onChange={(event) => { patch({ symbol: event.target.value }) }}
            />
            {suggestions.length > 0 && (
              <div className="dsp-suggest" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5 }}>
                {suggestions.map(row => (
                  <button
                    type="button"
                    className="dsp-suggest-item"
                    key={row.symbol}
                    onClick={() => {
                      patch({ symbol: row.symbol })
                      setSuggestions([])
                    }}
                  >
                    <span>{row.symbol}</span>
                    <span className="dsp-suggest-name">{row.name ?? ''}</span>
                    {row.type !== null && row.type !== 'stock' && (
                      <span className="dsp-suggest-name">{row.type.toUpperCase()}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="dsp-field">
            <label className="dsp-field-label" htmlFor="dsp-side">方向</label>
            <select
              id="dsp-side"
              className="dsp-select"
              value={draft.side}
              onChange={(event) => { switchSide(event.target.value === 'sell' ? 'sell' : 'buy') }}
            >
              <option value="buy">买入</option>
              <option value="sell">卖出</option>
            </select>
          </div>

          <div className="dsp-field">
            <label className="dsp-field-label" htmlFor="dsp-qty">数量（股）</label>
            <input
              id="dsp-qty"
              className="dsp-input"
              inputMode="decimal"
              placeholder="100"
              value={draft.quantity}
              onChange={(event) => { patch({ quantity: event.target.value }) }}
            />
          </div>

          <div className="dsp-field">
            <label className="dsp-field-label" htmlFor="dsp-price">成交价</label>
            <input
              id="dsp-price"
              className="dsp-input"
              inputMode="decimal"
              placeholder="0.00"
              value={draft.price}
              onChange={(event) => { patch({ price: event.target.value }) }}
            />
          </div>

          <div className="dsp-field">
            <label className="dsp-field-label" htmlFor="dsp-date">交易日期</label>
            <input
              id="dsp-date"
              className="dsp-input"
              type="date"
              value={draft.tradedAt}
              onChange={(event) => { patch({ tradedAt: event.target.value }) }}
            />
          </div>

          <div className="dsp-field dsp-form-wide">
            {/* The quick picks ride the label line: no dropdown to open, one
                click fills the field. */}
            <div className="dsp-field-head">
              <label className="dsp-field-label" htmlFor="dsp-motive">交易动机</label>
              <div className="dsp-chips">
                {presets.map(motive => (
                  <button
                    type="button"
                    className="dsp-chip"
                    key={motive}
                    data-picked={draft.motive.trim() === motive || undefined}
                    onClick={() => { patch({ motive: draft.motive.trim() === motive ? '' : motive }) }}
                  >
                    {motive}
                  </button>
                ))}
                {known.slice(0, MOTIVE_HISTORY_LIMIT).map(motive => (
                  <button
                    type="button"
                    className="dsp-chip"
                    data-history="true"
                    key={motive}
                    title="用过的动机"
                    onClick={() => { patch({ motive }) }}
                  >
                    {motive}
                  </button>
                ))}
              </div>
            </div>
            <input
              id="dsp-motive"
              className="dsp-input"
              placeholder={draft.side === 'buy' ? '例如：财报超预期 / 回调加仓' : '例如：跌破支撑止损 / 到达目标价'}
              value={draft.motive}
              onChange={(event) => { patch({ motive: event.target.value }) }}
            />
            <span className="dsp-field-hint">
              写清这笔交易的理由，会参与「分析」。点上面的词即可填入，再点一次取消；虚线的是你之前写过的动机，输入框里也可以自由输入。
            </span>
          </div>

          <div className="dsp-field dsp-form-wide">
            <label className="dsp-field-label" htmlFor="dsp-note">备注（可选）</label>
            <textarea
              id="dsp-note"
              className="dsp-textarea"
              placeholder="复盘时的补充说明"
              value={draft.note}
              onChange={(event) => { patch({ note: event.target.value }) }}
            />
          </div>

          <div className="dsp-form-actions">
            <button type="submit" className="dsp-btn" data-variant="primary" disabled={invalid || busy !== null}>
              <IconCheckOutline16 size={13} />
              {editing === null ? '保存交易' : `保存修改 #${String(editing)}`}
            </button>
            <button type="button" className="dsp-btn" data-variant="ghost" onClick={cancelEdit}>
              重置
            </button>
            {editing !== null && (
              <span className="dsp-field-hint">正在编辑已有记录，保存后持仓与盈亏会重新计算。</span>
            )}
          </div>
        </form>
      )}

      {state.trades.length === 0
        ? (
            <Empty title="还没有交易记录">
              点击「添加交易」记录第一笔买入。每笔交易都可以写下动机，之后在「分析」页复盘。
            </Empty>
          )
        : (
            <>
              <div className="dsp-settings-inline" style={{ marginBottom: 10 }}>
                <input
                  className="dsp-input"
                  style={{ maxWidth: 260 }}
                  placeholder="按代码、名称或动机筛选"
                  value={filter}
                  onChange={(event) => { setFilter(event.target.value) }}
                />
                <span className="dsp-field-hint">{`显示 ${String(visible.length)} / ${String(state.trades.length)} 笔`}</span>
              </div>
              <div className="dsp-table-wrap">
                <table className="dsp-table">
                  <thead>
                    <tr>
                      <th data-align="left">日期</th>
                      <th data-align="left">标的</th>
                      <th data-align="left">方向</th>
                      <th>数量</th>
                      <th>成交价</th>
                      <th>金额</th>
                      <th data-align="left">动机</th>
                      <th data-align="left">备注</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(trade => (
                      <tr key={trade.id}>
                        <td data-align="left">{trade.tradedAt}</td>
                        <td data-align="left">
                          <div className="dsp-symbol">
                            <span className="dsp-symbol-code">{trade.symbol}</span>
                            {trade.name !== null && <span className="dsp-symbol-name">{trade.name}</span>}
                          </div>
                        </td>
                        <td data-align="left">
                          <span className="dsp-side-tag" data-side={trade.side}>
                            {trade.side === 'buy' ? '买入' : '卖出'}
                          </span>
                        </td>
                        <td>{quantity(trade.quantity)}</td>
                        <td>{money(trade.price, trade.currency)}</td>
                        <td>{money(trade.quantity * trade.price, trade.currency)}</td>
                        <td data-align="left">
                          {trade.motive === null
                            ? <span className="dsp-flat">未标注</span>
                            : <span className="dsp-motive" title={trade.motive}>{trade.motive}</span>}
                        </td>
                        <td data-align="left">
                          <span className="dsp-symbol-name" title={trade.note ?? ''}>
                            {trade.note ?? ''}
                          </span>
                        </td>
                        <td>
                          {confirming === trade.id
                            ? (
                                <span className="dsp-settings-inline">
                                  <button
                                    type="button"
                                    className="dsp-btn"
                                    data-compact="true"
                                    data-variant="danger"
                                    disabled={busy !== null}
                                    onClick={() => { void remove(trade) }}
                                  >
                                    确认删除
                                  </button>
                                  <button
                                    type="button"
                                    className="dsp-icon-btn"
                                    data-compact="true"
                                    aria-label="取消"
                                    onClick={() => { setConfirming(null) }}
                                  >
                                    <IconCloseOutline16 size={12} />
                                  </button>
                                </span>
                              )
                            : (
                                <span className="dsp-settings-inline">
                                  <button
                                    type="button"
                                    className="dsp-icon-btn"
                                    data-compact="true"
                                    aria-label="编辑"
                                    title="编辑"
                                    onClick={() => { startEdit(trade) }}
                                  >
                                    <IconEditOutline16 size={13} />
                                  </button>
                                  <button
                                    type="button"
                                    className="dsp-icon-btn"
                                    data-compact="true"
                                    aria-label="删除"
                                    title="删除"
                                    onClick={() => { setConfirming(trade.id) }}
                                  >
                                    <IconTrashOutline16 size={13} />
                                  </button>
                                </span>
                              )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="dsp-field-hint" style={{ marginTop: 10 }}>
                持仓与盈亏由交易记录推导：买入计入成本，卖出按摊薄成本结转并锁定已实现盈亏。
                删除或修改历史记录会立即重算全部统计。
              </p>
            </>
          )}
    </div>
  )
}

export { tone }
