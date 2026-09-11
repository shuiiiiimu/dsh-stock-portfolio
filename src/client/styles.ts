/**
 * The plugin's stylesheet, injected by the client half as one owned `<style>`
 * tag.
 *
 * A plugin bundle cannot ship a side `.css` file — the factory closure is the
 * only place allowed to touch the document — so the sheet travels as a string
 * and `apply()` registers its lifetime with `ctx.effect`. Every colour and
 * radius comes from the DSH theme tokens (`--dsw-alias-*`), so light mode, dark
 * mode, and the corner-shape setting all apply without a second stylesheet.
 */

/** The `data-` attribute marking this plugin's stylesheet. */
export const STYLE_TAG_ID = 'dsh-stock-portfolio'

export const STYLES = `
.dsp-root {
  /* Money colours. DSH ships success/error states but no "gain" pair, and a
     Chinese trading UI wants red-up / green-down by convention, so the two
     directions are named here and swapped by one rule. */
  --dsp-up: var(--dsw-alias-state-error-primary);
  --dsp-down: var(--dsw-alias-state-success-primary);
  --dsp-flat: var(--dsw-alias-label-tertiary);
  font-family: var(--dsw-font-base-16-font-family, inherit);
  color: var(--dsw-alias-label-primary);
}

/* ── sidebar entry ───────────────────────────────────────────────────────── */

/* The sidebar's footer strip is a flex ROW whose existing occupant claims
   width:100%. A second full-width row would overflow, so the plugin makes the
   strip a COLUMN for as long as it is mounted — which is what the shipped
   comment ("Footer actions stack above Settings") already describes. The
   override is applied imperatively and reverted on unload; see index.tsx. */

/* Geometry, type scale, colour, and edge alignment are copied from the
   harness's own settings trigger in the same footer strip (ui-settings-general
   SettingsRoot.module.css): 42px row, 14/22 label in label-primary, 12px radius,
   and the +4px / -2px overhang that makes the two rows share both edges. Anything
   else reads as a plugin bolted onto the sidebar rather than part of it. */
.dsp-nav {
  flex: none;
  box-sizing: border-box;
  width: calc(100% + 4px);
  height: 42px;
  margin: 4px -2px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 8px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  cursor: pointer;
  text-align: left;
  transition: background var(--ds-transition-duration-fast, 120ms) var(--ds-ease-in-out, ease);
}

.dsp-nav:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsp-nav:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dsp-nav-glyph { flex: none; display: inline-flex; }

.dsp-nav-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dsp-nav-badge {
  flex: none;
  font-size: 13px;
  line-height: 22px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

/* Collapsed rail: the same 36px circle as the settings trigger beside it. */
.dsp-nav[data-wide='false'] {
  width: 36px;
  height: 36px;
  margin: 8px auto 10px;
  padding: 0;
  justify-content: center;
  border-radius: 50%;
  corner-shape: round;
}

/* ── dashboard shell ─────────────────────────────────────────────────────── */

.dsp-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  /* Nothing behind the dialog may scroll while it is open: a wheel or swipe that
     no inner scroller consumes stops here instead of chaining to the harness
     columns underneath. */
  overscroll-behavior: contain;
}

.dsp-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.4));
  animation: dsp-fade var(--ds-transition-duration, 150ms) var(--ds-ease-in-out, ease);
}

.dsp-panel {
  position: relative;
  display: grid;
  /* Rail width: it carries five short labels and one footer stat, so every pixel
     past that is taken straight out of the tables and the chart beside it. */
  grid-template-columns: 152px minmax(0, 1fr);
  /* The single row is pinned to the panel's own height. With the default
     auto row, a tall section (Settings, a long trade log) grew the row past the
     panel, so .dsp-content was handed a box as tall as its content and the
     overflow:hidden here clipped the rest: the panel had nothing to scroll and
     every wheel tick fell through to the page behind it. */
  grid-template-rows: minmax(0, 1fr);
  width: min(1180px, 94vw);
  height: min(780px, 88vh);
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: max(14px, var(--dsw-corner-shape, 0px));
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent, 0 18px 48px rgba(0, 0, 0, 0.18));
  animation: dsp-rise var(--ds-transition-duration, 150ms) var(--ds-ease-in-out, ease);
}

@keyframes dsp-fade { from { opacity: 0; } }
@keyframes dsp-rise { from { opacity: 0; transform: translateY(8px) scale(0.995); } }

.dsp-side {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* The rail is a grid item too: without this it can grow the row it sits in. */
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px 10px;
  border-right: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}

.dsp-side-title {
  padding: 4px 8px 14px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.dsp-tab {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background var(--ds-transition-duration-fast, 120ms) var(--ds-ease-in-out, ease);
}

.dsp-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsp-tab[aria-current='true'] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsp-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }

.dsp-side-foot {
  margin-top: auto;
  padding: 10px 8px 2px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary);
}

.dsp-body { display: flex; flex-direction: column; min-width: 0; min-height: 0; }

.dsp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.dsp-head-title { font-size: 14px; font-weight: 600; }
.dsp-head-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsp-head-spacer { flex: 1 1 auto; }

/* The one scrollable region of the dialog. min-height:0 plus the pinned grid row
   above is what gives it a bounded height; overscroll-behavior keeps a flick that
   reaches either end from continuing into the harness behind it. */
.dsp-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 18px;
}

/* ── controls ────────────────────────────────────────────────────────────── */

.dsp-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-button-floating-fill, transparent);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--ds-transition-duration-fast, 120ms) var(--ds-ease-in-out, ease);
}

.dsp-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsp-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.dsp-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsp-btn[data-variant='primary'] {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-label-primary-inverted));
}
.dsp-btn[data-variant='primary']:hover { background: var(--dsw-alias-button-primary-hover); }
.dsp-btn[data-variant='ghost'] { border-color: transparent; background: transparent; }
.dsp-btn[data-variant='danger'] { border-color: transparent; background: transparent; color: var(--dsw-alias-state-error-primary); }
.dsp-btn[data-variant='danger']:hover { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsp-btn[data-compact='true'] { height: 24px; padding: 0 8px; font-size: 12px; }

.dsp-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsp-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsp-icon-btn[data-compact='true'] { width: 24px; height: 24px; border-radius: 6px; }

.dsp-field { display: flex; flex-direction: column; gap: 6px; }
.dsp-field-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
/* A field whose label shares its line with controls — the motive row, where the
   quick picks sit immediately after the label. */
.dsp-field-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
.dsp-field-head .dsp-field-label { flex: none; }
.dsp-field-hint { font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-tertiary); }

.dsp-input,
.dsp-select,
.dsp-textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 32px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}

.dsp-input:focus,
.dsp-select:focus,
.dsp-textarea:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}

.dsp-textarea { resize: vertical; min-height: 62px; line-height: 1.5; }
.dsp-input[data-mono='true'] { font-family: var(--ds-font-family-code, ui-monospace, monospace); }
.dsp-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }

/* ── cards and stats ─────────────────────────────────────────────────────── */

.dsp-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 12px;
  margin-bottom: 18px;
}

.dsp-card {
  padding: 14px 15px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}

.dsp-card-label {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
  margin-bottom: 8px;
}

.dsp-card-value {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.dsp-card-sub {
  margin-top: 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary);
}

.dsp-section { margin-bottom: 20px; }

.dsp-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}

.dsp-section-note { font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* ── tables ──────────────────────────────────────────────────────────────── */

/* Wide tables scroll sideways rather than hiding their right-hand columns: the
   cells are nowrap by design, so on a narrow frame the table's min-content width
   exceeds the panel and hidden overflow made those columns unreachable. */
.dsp-table-wrap {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  background: var(--dsw-alias-bg-layer-2);
}

.dsp-table { width: 100%; border-collapse: collapse; font-size: 13px; }

.dsp-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 9px 12px;
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2));
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-weight: 500;
  text-align: right;
  white-space: nowrap;
  cursor: default;
}

.dsp-table th[data-sortable='true'] { cursor: pointer; user-select: none; }
.dsp-table th[data-sortable='true']:hover { color: var(--dsw-alias-label-primary); }
.dsp-table th[data-align='left'], .dsp-table td[data-align='left'] { text-align: left; }

.dsp-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dsp-table tbody tr:last-child td { border-bottom: 0; }
.dsp-table tbody tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }

/* A numeric cell that carries a second line — a date under a price, a ratio under
   an amount. Table cells are right-aligned, so both lines share that edge and the
   row keeps one rhythm. */
.dsp-cell-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  line-height: 1.35;
}

.dsp-cell-sub { font-size: 11.5px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }

.dsp-symbol { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
.dsp-symbol-code { font-weight: 500; }
.dsp-symbol-name { font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }

.dsp-market {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-mask-2, var(--dsw-alias-bg-layer-3));
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
}

.dsp-motive {
  display: inline-block;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-bg-multi-select, var(--dsw-alias-bg-layer-3));
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  white-space: nowrap;
  vertical-align: middle;
}

.dsp-side-tag { font-size: 12px; font-weight: 500; }
.dsp-side-tag[data-side='buy'] { color: var(--dsp-up); }
.dsp-side-tag[data-side='sell'] { color: var(--dsp-down); }

.dsp-up { color: var(--dsp-up); }
.dsp-down { color: var(--dsp-down); }
.dsp-flat { color: var(--dsp-flat); }
.dsp-num-strong { font-weight: 600; }

/* ── bars (breakdowns) ───────────────────────────────────────────────────── */

.dsp-bars { display: flex; flex-direction: column; gap: 9px; }

.dsp-bar-row {
  display: grid;
  grid-template-columns: minmax(88px, 168px) minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  font-size: 12.5px;
}

.dsp-bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); }

.dsp-bar-track {
  position: relative;
  height: 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-mask-2, var(--dsw-alias-bg-layer-3));
  overflow: hidden;
}

.dsp-bar-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; }
.dsp-bar-fill[data-dir='up'] { background: var(--dsp-up); }
.dsp-bar-fill[data-dir='down'] { background: var(--dsp-down); }
.dsp-bar-value { font-variant-numeric: tabular-nums; white-space: nowrap; }

/* ── trade form ──────────────────────────────────────────────────────────── */

.dsp-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 12px;
  padding: 16px;
  margin-bottom: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2);
}

.dsp-form-wide { grid-column: 1 / -1; }
.dsp-form-actions { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; }

.dsp-suggest {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 168px;
  overflow: auto;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
}

.dsp-suggest-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 7px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.dsp-suggest-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsp-suggest-name { color: var(--dsw-alias-label-tertiary); font-size: 12px; }

.dsp-chips { display: flex; flex-wrap: wrap; gap: 6px; }

.dsp-chip {
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsp-chip:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
/* The picked quick pick reads as pressed; a motive the user wrote themselves is
   marked apart from the shipped suggestions. */
.dsp-chip[data-picked] {
  background: var(--dsw-alias-interactive-bg-active);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
}
.dsp-chip[data-history='true'] {
  border-style: dashed;
  color: var(--dsw-alias-label-tertiary);
}

/* ── chart ───────────────────────────────────────────────────────────────── */

.dsp-chart { width: 100%; height: 208px; display: block; overflow: visible; }
.dsp-chart-axis { fill: var(--dsw-alias-label-tertiary); font-size: 10px; }
.dsp-chart-line { fill: none; stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
.dsp-chart-area { opacity: 0.1; }
.dsp-chart-grid { stroke: var(--dsw-alias-border-l1); stroke-width: 1; }
.dsp-chart-cost { fill: none; stroke: var(--dsw-alias-label-tertiary); stroke-width: 1; stroke-dasharray: 4 3; }

.dsp-legend { display: flex; gap: 14px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); margin-top: 6px; }
.dsp-legend-swatch { display: inline-block; width: 9px; height: 2px; margin-right: 5px; vertical-align: middle; border-radius: 2px; }

/* ── states ──────────────────────────────────────────────────────────────── */

.dsp-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 1.8;
}

.dsp-empty strong { display: block; margin-bottom: 6px; color: var(--dsw-alias-label-secondary); font-size: 14px; }

.dsp-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  margin-bottom: 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
}
.dsp-banner[data-tone='error'] { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-secondary, var(--dsw-alias-border-l2)); }
.dsp-banner[data-tone='warn'] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }

.dsp-settings { display: flex; flex-direction: column; gap: 20px; max-width: 620px; }
.dsp-settings-row { display: flex; flex-direction: column; gap: 7px; }
.dsp-settings-inline { display: flex; gap: 8px; align-items: center; }
.dsp-kv { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 6px 14px; font-size: 12.5px; }
.dsp-kv dt { color: var(--dsw-alias-label-tertiary); }
.dsp-kv dd { margin: 0; font-variant-numeric: tabular-nums; word-break: break-all; }

.dsp-spin { animation: dsp-rotate 900ms linear infinite; }
@keyframes dsp-rotate { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .dsp-mask, .dsp-panel { animation: none; }
  .dsp-spin { animation: none; }
}
`
