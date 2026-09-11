/**
 * Domain icons drawn in the shipped 16px thin-stroke house style
 * (`viewBox="0 0 16 16"`, `stroke="currentColor"`, `strokeWidth={1.25}`,
 * colour riding `currentColor`), so the sidebar entry sits beside the harness's
 * own glyphs without looking imported.
 *
 * Only the four glyphs the DSH icon set does not already have live here;
 * everything generic (settings, close, plus, trash, refresh, chevrons) comes
 * from `@deepseek-ai/dsh-client-ui-primitives`.
 */

/** Shared props, matching the primitives' `IconProps`. */
interface IconProps {
  size?: number | undefined
  className?: string | undefined
}

/** A candlestick pair over a rising baseline: the plugin's own mark. */
export function IconPortfolioOutline16({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.9 2.6v2.1M3.9 11.4v2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <rect x="2.4" y="4.7" width="3" height="6.7" rx="1" stroke="currentColor" strokeWidth="1.25" />
      <path d="M12.1 1.9v2.3M12.1 12.4v1.7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <rect x="10.6" y="4.2" width="3" height="8.2" rx="1" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

/** A stack of layers: the holdings table. */
export function IconHoldingsOutline16({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 1.9l5.6 2.9L8 7.7 2.4 4.8 8 1.9z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M2.4 8.1L8 11l5.6-2.9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.4 11.3L8 14.2l5.6-2.9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A ledger row with a pen: the trade log. */
export function IconLedgerOutline16({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2.4" y="2.4" width="8.4" height="11.2" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
      <path d="M4.7 5.6h3.8M4.7 8h2.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M12.3 8.6l1.5 1.5-3 3-1.9.4.4-1.9 3-3z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  )
}

/** Three bars of unequal height: the analysis view. */
export function IconAnalysisOutline16({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2.2 13.6h11.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <rect x="2.9" y="8.2" width="2.6" height="4.1" rx="0.8" stroke="currentColor" strokeWidth="1.25" />
      <rect x="6.7" y="4.9" width="2.6" height="7.4" rx="0.8" stroke="currentColor" strokeWidth="1.25" />
      <rect x="10.5" y="6.7" width="2.6" height="5.6" rx="0.8" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  )
}

/** A dial with a needle: the overview. */
export function IconOverviewOutline16({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.5 12.9a6 6 0 1 1 9 0" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M8 9.3l3.1-3.1" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="9.4" r="1.3" fill="currentColor" />
    </svg>
  )
}
