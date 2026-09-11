/**
 * The quick-pick trade motives, shared by the dashboard form and the chat tool.
 *
 * These are the reasons a retail holder actually writes down, kept short enough
 * to read at a glance. They are suggestions, never a closed set: every consumer
 * keeps the field free text, and anything the user has used before joins the row
 * below.
 *
 * One list, two surfaces. The form offers the presets for the direction the user
 * picked; the chat tool offers the same words as question options. That is what
 * keeps a trade dictated to the model and a trade typed into the panel carrying
 * the same vocabulary — which is the whole point of the by-motive breakdown.
 */
import type { TradeSide } from './types.ts'

/** The presets, per direction. */
export const MOTIVE_PRESETS: Readonly<Record<TradeSide, readonly string[]>> = {
  buy: ['低估值买入', '财报超预期', '行业景气', '回调加仓', '定投', '突破买入', '分红再投', '长期看好'],
  sell: ['止盈', '止损', '估值过高', '基本面恶化', '调仓换股', '到达目标价', '短期涨幅过大', '需要用钱'],
}

/** How many previously-used motives to offer alongside the presets. */
export const MOTIVE_HISTORY_LIMIT = 6
