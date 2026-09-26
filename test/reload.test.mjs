/**
 * The dev-override block `npm run reload` writes into a profile patch.
 *
 * This block is the difference between a live Host reload and a silent no-op, so
 * the shape is pinned here rather than trusted to the prose in the script header.
 * The original shape — a profile row `- id: stock-portfolio` with a `name:`
 * naming `lib/index.dev.<digest>.js` — never took effect at all: the Loader skips
 * a non-insert patch whose `name` differs from the target row's
 * (`vendor/include/src/index.ts` -> `patch: name mismatch ... skipping`), so the
 * running profile kept loading `lib/index.js` and only a restart picked up a
 * rebuild. The block therefore has to disable the bundle row and INSERT the dev
 * copy as its own row, and both halves are asserted below: disabling alone would
 * leave no row at all, inserting alone would mount the plugin twice.
 *
 * `rewrite` also has to survive the file it was actually written into: the
 * managed block sits in the middle of a profile patch full of other plugins'
 * rows, so a rewrite that reaches past it would corrupt a neighbour.
 *
 * The inserted row additionally carries a mount guard (`!!js`), asserted below:
 * profile-patch rows are not governed by `dsh.profile.bundles`, so without the
 * guard the plugin manager's switch would report the bundle off while the sidebar
 * row and its day-P&L badge stayed on screen.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEV_ROW_GUARD, DEV_ROW_ID, END_MARKER, MARKER, ROW_ID, appendBlock, overrideBlock, rewrite, writePatch,
} from '../scripts/reload.mjs'

/** A digest-shaped specifier, as `npm run reload` computes it. */
const SPEC = '../../../codespaces/dsh-stock-portfolio/lib/index.dev.7d9fc8230e.js'
/** The next build's digest — a name the Loader has never imported. */
const SPEC_NEXT = '../../../codespaces/dsh-stock-portfolio/lib/index.dev.a1b2c3d4e5.js'

/**
 * A profile patch in the shape the broken mechanism left behind: the managed
 * block in the middle, with unrelated overrides on both sides.
 */
const LEGACY = [
  '# Your patch layer for this dsh profile, applied after every bundle layer.',
  '',
  MARKER,
  `- id: ${ROW_ID}`,
  `  name: ${SPEC}`,
  '- id: ui-settings-general',
  '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
  '  config:',
  '    welcomeNoticeVersion: 2026-08-13.1',
  '',
].join('\n')

/** The bundle row's own line, with the indented line that follows it. */
function rowBody(body) {
  const lines = body.split('\n')
  const at = lines.indexOf(`- id: ${ROW_ID}`)
  assert.notEqual(at, -1, `the bundle row is missing from:\n${body}`)
  return lines[at + 1]
}

test('the generated block disables the bundle row and inserts the dev copy', () => {
  const block = overrideBlock(SPEC)
  assert.ok(block.startsWith(MARKER), 'the block opens with the sentinel the rewrite looks for')
  assert.ok(block.endsWith(END_MARKER), 'the block closes with the sentinel that bounds a rewrite')
  // The two halves of the fix, in the only shape the Loader honours.
  assert.equal(rowBody(block), '  disabled: true', 'the bundle row must carry no name: a patch cannot rename it')
  assert.ok(block.includes(`- insert:\n    - id: ${DEV_ROW_ID}\n      name: ${SPEC}`), block)
  assert.equal(block.split('- insert:').length - 1, 1, 'exactly one insert: a second row would double-mount the plugin')
})

test('the inserted row carries the guard that follows the bundle switch', () => {
  const block = overrideBlock(SPEC)
  // The guard is what makes the plugin manager's switch authoritative: without it
  // the inserted row keeps the plugin (and its sidebar row) alive after the bundle
  // is switched off, because profile-patch rows are not governed by `dsh.profile.bundles`.
  assert.ok(
    block.includes(`      disabled: !!js "${DEV_ROW_GUARD}"`),
    `the dev row must carry its mount guard, got:\n${block}`,
  )
  assert.ok(DEV_ROW_GUARD.includes(`row.id === '${ROW_ID}'`), 'the guard keys on the bundle row id')
  assert.ok(DEV_ROW_GUARD.startsWith('!'), 'the guard disables the dev row while the bundle row is missing')
  assert.ok(DEV_ROW_GUARD.includes('row.disabled'), 'the guard also stands down while the bundle row is enabled')
  // The composed list, never the live store: on the pass that re-adds the bundle,
  // a store lookup reads "no bundle row" and disposes the dev row for good.
  assert.ok(DEV_ROW_GUARD.includes('root.data'), 'the guard reads the composed entry list')
  assert.ok(!DEV_ROW_GUARD.includes('entries()'), 'a live-store lookup races the row this pass introduces')
  assert.ok(!DEV_ROW_GUARD.includes('"'), 'a double quote would break the !!js YAML scalar')
  assert.equal(block.split('!!js').length - 1, 1, 'exactly one expression in the block')
})

test('a legacy rename row is migrated in place, leaving neighbours alone', () => {
  const next = rewrite(LEGACY, SPEC_NEXT)
  assert.notEqual(next, null)
  // The bug: a `name:` on the bundle row is skipped by the Loader, so it must be gone.
  assert.ok(!next.includes(`- id: ${ROW_ID}\n  name:`), 'the no-op rename row survived the rewrite')
  assert.equal(rowBody(next), '  disabled: true')
  assert.ok(next.includes(`- insert:\n    - id: ${DEV_ROW_ID}\n      name: ${SPEC_NEXT}`), next)
  assert.ok(next.includes(`      disabled: !!js "${DEV_ROW_GUARD}"`), 'a migrated block grows the mount guard too')
  assert.ok(next.endsWith('\n'), 'a YAML file ends with a newline')
  // Both neighbours, before and after the block, survive verbatim.
  assert.ok(next.includes('# Your patch layer for this dsh profile, applied after every bundle layer.'))
  assert.ok(next.includes('- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-08-13.1'))
})

test('a rewrite only swaps the digest, and is stable', () => {
  const once = rewrite(LEGACY, SPEC)
  const twice = rewrite(once, SPEC_NEXT)
  assert.ok(once.includes(SPEC))
  assert.ok(!twice.includes(SPEC), 'the old digest must not survive')
  assert.ok(twice.includes(SPEC_NEXT))
  assert.equal(twice.split('- insert:').length - 1, 1)
  assert.equal(rewrite(twice, SPEC_NEXT), twice, 'rewriting the same digest is a no-op')
})

test('a patch with no managed block appends one instead', () => {
  assert.equal(rewrite('# nothing of ours here\n', SPEC), null)
  const fresh = appendBlock('', SPEC)
  assert.ok(fresh.startsWith(MARKER), 'an empty patch gets the block first, with no leading blank line')
  assert.equal(rowBody(fresh), '  disabled: true')
  const after = appendBlock('- id: agent-default-model\n  config:\n    model: deepseek-flash\n', SPEC)
  assert.ok(after.startsWith('- id: agent-default-model'), 'the existing rows stay first')
  assert.ok(after.includes(`\n\n${MARKER}\n`), 'the block is separated from them by one blank line')
  assert.ok(after.includes(`      name: ${SPEC}`))
})

test('the read-back guard refuses a block that would mount the plugin twice or not at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reload-'))
  const patch = join(dir, 'cordis.patch.yml')
  // Inserted row present, bundle row NOT disabled: the Loader would mount both.
  const doubleMount = [`${MARKER}`, `- id: ${ROW_ID}`, '- insert:', `    - id: ${DEV_ROW_ID}`, `      name: ${SPEC}`, END_MARKER, ''].join('\n')
  assert.throws(() => { writePatch(patch, doubleMount, SPEC) }, /did not read back with a complete dev override block/)
  // The right two rows but no mount guard: the switch would stop working again.
  const unguarded = [
    MARKER, `- id: ${ROW_ID}`, '  disabled: true', '- insert:', `    - id: ${DEV_ROW_ID}`, `      name: ${SPEC}`, END_MARKER, '',
  ].join('\n')
  assert.throws(() => { writePatch(patch, unguarded, SPEC) }, /did not read back with a complete dev override block/)
  // Correct shape: the guard passes and the file is on disk.
  writePatch(patch, overrideBlock(SPEC) + '\n', SPEC)
  assert.equal(readFileSync(patch, 'utf8'), overrideBlock(SPEC) + '\n')
})
