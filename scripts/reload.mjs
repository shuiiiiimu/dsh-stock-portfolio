/**
 * Point a running `dsh` at this checkout's newest Host bundle.
 *
 * The plugin is installed as a normal profile bundle (`dsh plugin --profile web
 * add <checkout>`) — the plugin manager writes it into `dsh.profile.bundles` and
 * links the checkout into the profile's node_modules, so the package's own
 * `cordis.patch.yml` supplies the `stock-portfolio` row, and that row loads
 * `lib/index.js` by default.
 *
 * Making a Host-side change live needs the mounted row to name a URL the Loader
 * has never imported: Node caches an ES module by resolved URL, so re-applying a
 * patch that names the same file hands the Loader the module it already has.
 * `npm run build` writes a content-addressed copy (`lib/index.dev.<digest>.js`)
 * for exactly that, and this script points the running profile at the newest one.
 *
 * It cannot do that by RENAMING the bundle row. The Loader's patch layer skips a
 * non-insert patch whose `name` differs from the target row's
 * (`vendor/include/src/index.ts` -> `patch: name mismatch ... skipping`), so a
 * profile row reading `- id: stock-portfolio` + `name: <digest path>` is a silent
 * no-op: the row keeps loading `lib/index.js`, and only a `dsh` restart picks up
 * a rebuild. What the Loader does honour is an INSERT, so this script instead:
 *
 *   1. DISABLES the bundle's own row, and
 *   2. INSERTS a second row, under its own id, naming the digest file.
 *
 * Disabling is not an uninstall and not a second mount. The bundle stays selected
 * in `dsh.profile.bundles`, so nothing is removed and the browser half is still
 * discovered (client packages are found per ACTIVE Loader row, and the inserted
 * row names a module inside the same package, so it resolves to the same
 * manifest). The disabled row no longer mounts the published bundle, which is
 * what would otherwise bring the plugin up twice: two stores, two route
 * registrations.
 *
 * Every path is resolved at run time — `$DSH_HOME` (or `~/.dsh`), the profile
 * directory holding the override block, and the relative hop from that profile
 * back to `lib/` — so neither this script nor the patch file has to carry a
 * hard-coded home directory. The inserted row keeps a RELATIVE name, which DSH
 * anchors to the directory of the patch file that wrote it.
 *
 * Usage: `npm run reload` (after `npm run build`), optionally with
 * `DSH_PROFILE=<name>` when more than one profile has the plugin installed.
 *
 * The patch is REPLACED ATOMICALLY (write beside it, then rename) and read back
 * before this script reports success. A patch file is read by the live watcher
 * and by every future `dsh` start, so a write interrupted by a crash or a power
 * loss used to leave a truncated YAML that made the harness refuse to boot — a
 * rename cannot be observed half-done.
 */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-stock-portfolio'
/** Id of the row this package's own `cordis.patch.yml` inserts. */
const ROW_ID = 'stock-portfolio'
/** Id of the row this script inserts to mount the content-addressed dev copy. */
const DEV_ROW_ID = 'stock-portfolio-dev'
/**
 * The inserted row's mount guard, as a Loader `!!js` expression.
 *
 * The inserted row lives in the PROFILE patch, and `dsh.profile.bundles` membership
 * does not govern it: with the bundle switched off in the plugin manager the
 * bundle's own row is gone while this row would keep mounting the plugin, so the
 * switch would look broken — the sidebar's 「股票持仓」 row and its day-P&L badge
 * stay on screen and nothing appears to happen. The guard mounts this row only
 * while the bundle's own row is present AND suppressed, which is exactly the state
 * the block below creates. No matching row (bundle off) => guard false => the
 * plugin comes down whole, Host half and browser half together, because the
 * browser half is discovered per ACTIVE row. A bundle row that is present but
 * ENABLED => guard false as well, so the published row mounts alone instead of
 * twice: the row's own switch in the plugin list rewrites this block's
 * `disabled: true` line to `false` in place (and a hand edit can do the same),
 * which is what a plain disable+insert block would otherwise answer with two
 * live stores and two route registrations.
 *
 * It reads the COMPOSED entry list (`entry.parent.tree.root.data`, assigned before
 * any row of a reconcile is created or removed) and not the live Loader store. The
 * store is filled row by row — ids that already existed first, ids this reconcile
 * introduces last — so on the pass that re-adds the bundle, the bundle's row is
 * created AFTER this one. A store lookup there reads "no bundle row" and disposes
 * the dev row, which is how a switch flipped off-then-on left the plugin down until
 * the next unrelated reload.
 *
 * The expression is re-evaluated on every mount decision (`Entry.disabled` in
 * `vendor/loader/src/config/entry.ts`), and a profile reload re-updates every row
 * of the composed list, so the switch works in both directions without a restart.
 */
const DEV_ROW_GUARD = `!ctx[Symbol.for('cordis.entry')].parent.tree.root.data.some(row => row.id === '${ROW_ID}' && row.disabled)`
/** Opening sentinel of the block this script owns, wherever it wrote it. */
const MARKER = `# --- ${PACKAGE_NAME} dev override ---`
/** Closing sentinel: a rewrite replaces exactly the lines between the two. */
const END_MARKER = `# --- end ${PACKAGE_NAME} dev override ---`

/**
 * Replace one file's contents without ever exposing a partial file.
 *
 * `writeFileSync` truncates and then writes: a reader — or the next boot — that
 * arrives in between sees a half-written file. Writing a sibling and renaming
 * over the target makes the swap atomic on POSIX, which matters here because the
 * target is a file the harness parses before it can start.
 * @param path - the file to replace.
 * @param body - its new contents.
 */
function replaceAtomically(path, body) {
  const staging = `${path}.staging-${String(process.pid)}`
  writeFileSync(staging, body)
  renameSync(staging, path)
}

/**
 * The managed block, without a trailing newline.
 *
 * The prose rides inside the block so a fresh install explains itself where the
 * mechanism lives, and the two sentinels are what keep a rewrite from touching a
 * neighbouring plugin's rows.
 * @param specifier - the relative module specifier of the dev bundle.
 * @returns the block's text.
 */
function overrideBlock(specifier) {
  return [
    MARKER,
    '#',
    '# Managed by `npm run reload` in the dsh-stock-portfolio checkout. Do not',
    '# edit by hand: the next reload replaces everything between the sentinels.',
    '#',
    '# Why the row below is DISABLED and the dev copy is INSERTED, rather than the',
    '# bundle row simply being renamed to name the dev copy: the Loader skips a',
    '# non-insert patch whose `name` differs from the target row name, so a `name:`',
    '# on the bundle row would be ignored and only a dsh restart would pick up a',
    '# rebuild. An insert is not name-checked.',
    '#',
    '# Disabling the bundle row is not an uninstall: the package stays in',
    '# `dsh.profile.bundles` and the browser half is still discovered, but the row',
    '# stops mounting the published bundle. Without that, the plugin would come up',
    '# twice: two stores, two route registrations.',
    '#',
    '# The inserted row carries a mount guard: it stays down unless the bundle row',
    '# is present AND suppressed. That row is the only signal the plugin manager',
    '# owns, so switching the bundle off takes both halves down (nothing is left to',
    '# mount the plugin, and the browser half is discovered per active row) and',
    '# switching it back on restores this row. Without the guard the inserted row',
    '# would keep the plugin alive after the bundle was switched off — a switch that',
    '# visibly does nothing: 「股票持仓」 and its day P&L stay in the sidebar.',
    '#',
    '# The digest is what makes the swap live: Node caches an ES module by resolved',
    '# URL, so only a name the Loader has never imported re-reads the new build.',
    `- id: ${ROW_ID}`,
    '  disabled: true',
    '- insert:',
    `    - id: ${DEV_ROW_ID}`,
    `      name: ${specifier}`,
    `      disabled: !!js "${DEV_ROW_GUARD}"`,
    END_MARKER,
  ].join('\n')
}

/**
 * The top-level rows the managed block owns, as whole lines.
 * @param line - one line of the patch file.
 * @returns whether the line belongs to the block.
 */
function isOwnedRow(line) {
  return line === `- id: ${ROW_ID}` || line === '- insert:'
}

/**
 * Ensure a file's text ends with exactly one newline.
 * @param text - the file's text.
 * @returns the terminated text.
 */
function terminated(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Replace the dev override block's `name:` line, keeping it relative to the
 * patch file.
 *
 * A block written before the closing sentinel existed (or hand-edited) is
 * migrated in place: it owns its rows and their continuations up to the next
 * top-level patch entry that is not one of its own.
 * @param body - the patch file's text.
 * @param specifier - the relative path to write.
 * @returns the new text, or `null` when this file carries no managed block.
 */
function rewrite(body, specifier) {
  const lines = body.split('\n')
  const begin = lines.indexOf(MARKER)
  if (begin === -1) return null
  let end = lines.indexOf(END_MARKER, begin + 1)
  if (end === -1) {
    end = begin + 1
    while (end < lines.length) {
      if (isOwnedRow(lines[end]) || /^\s/u.test(lines[end]) || lines[end].trim() === '') end += 1
      else break
    }
  } else {
    // Include the closing sentinel itself in the replaced range.
    end += 1
  }
  const before = lines.slice(0, begin).join('\n')
  const after = lines.slice(end).join('\n')
  return terminated([before, overrideBlock(specifier), after].filter(part => part !== '').join('\n'))
}

/**
 * Append the dev override block to a profile patch that has none yet.
 *
 * This is the shape a fresh `dsh plugin add` leaves behind: the bundle is
 * selected and supplies its own row, and the profile patch only carries
 * unrelated overrides.
 * @param body - the patch file's text.
 * @param specifier - the relative path to write.
 * @returns the new text.
 */
function appendBlock(body, specifier) {
  const base = body === '' ? '' : `${body.endsWith('\n') ? body : `${body}\n`}\n`
  return terminated(`${base}${overrideBlock(specifier)}`)
}

/**
 * Replace the patch, then read it back.
 *
 * The read-back is the guard that matters: this one file decides whether the
 * harness starts at all, and the two rows below are the difference between one
 * mounted plugin and two — or between a plugin the profile switch can turn off and
 * one it cannot. The script confirms that what is now on disk carries the bundle
 * row disabled (so it does not mount), the inserted dev row, and that row's mount
 * guard.
 * @param path - the patch file.
 * @param body - the new contents.
 * @param specifier - the module specifier that must appear on the inserted row.
 * @throws {Error} when the written file does not carry the complete block.
 */
function writePatch(path, body, specifier) {
  replaceAtomically(path, body)
  const written = readFileSync(path, 'utf8')
  const disabled = written.includes(`- id: ${ROW_ID}\n  disabled: true`)
  const inserted = written.includes(`- id: ${DEV_ROW_ID}`) && written.includes(`name: ${specifier}`)
  const guarded = written.includes(`disabled: !!js "${DEV_ROW_GUARD}"`)
  if (!disabled || !inserted || !guarded) {
    throw new Error(`${path} did not read back with a complete dev override block (${ROW_ID} disabled + ${DEV_ROW_ID} insert + mount guard); restore it from a backup before starting dsh`)
  }
}

/**
 * Resolve the harness home, matching `dsh`'s own default.
 * @returns the absolute DSH home directory.
 */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Find the profile whose manifest lists this bundle.
 *
 * The bundle lives in `package.json`'s `dsh.profile.bundles` (the plugin
 * manager's own record) and the override lives in the same directory's
 * `cordis.patch.yml`, so one search answers both.
 * @param home - the harness home.
 * @returns object with the manifest and patch paths, or `null` when no profile selects it.
 */
function findProfile(home) {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return null
  const wanted = process.env.DSH_PROFILE?.trim()
  for (const name of readdirSync(profiles)) {
    if (wanted !== undefined && wanted !== '' && name !== wanted) continue
    const manifest = join(profiles, name, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    const bundles = parsed?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(PACKAGE_NAME)) {
      return { patch: join(profiles, name, 'cordis.patch.yml') }
    }
  }
  return null
}

/**
 * The newest content-addressed Host bundle, or the canonical one when no dev
 * copy exists yet.
 * @returns the absolute bundle path.
 * @throws {Error} when the chosen bundle is missing or empty — pointing the
 *   profile at a module that is not there is what breaks the next `dsh` start.
 */
function newestBundle() {
  const lib = join(PACKAGE_ROOT, 'lib')
  const copies = readdirSync(lib)
    .filter(name => /^index\.dev\..+\.js$/u.test(name))
    .map(name => ({ name, at: statSync(join(lib, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)
  const bundle = copies.length > 0 ? join(lib, copies[0].name) : join(lib, 'index.js')
  if (!existsSync(bundle) || statSync(bundle).size === 0) {
    throw new Error(`${bundle} is missing or empty; run \`npm run build\` first`)
  }
  return bundle
}

/** Point the profile that selects this bundle at the newest Host build. */
function main() {
  const bundle = newestBundle()
  const profile = findProfile(dshHome())
  if (profile === null) {
    console.error(`[${PACKAGE_NAME}] no profile selects this bundle; install it with \`dsh plugin --profile <name> add ${PACKAGE_ROOT}\``)
    process.exitCode = 1
    return
  }
  // `relative` already yields forward slashes on POSIX; normalise for Windows,
  // where DSH resolves the name as a path either way.
  const specifier = relative(dirname(profile.patch), bundle).split(sep).join('/')
  const body = existsSync(profile.patch) ? readFileSync(profile.patch, 'utf8') : ''
  const next = rewrite(body, specifier) ?? appendBlock(body, specifier)
  writePatch(profile.patch, next, specifier)
  // The watcher re-applies on an mtime change; a rebuild that produced the same
  // digest would otherwise leave the running process on the module it has.
  const now = new Date()
  utimesSync(profile.patch, now, now)
  console.log(`[${PACKAGE_NAME}] ${profile.patch} -> ${specifier}`)
}

export { DEV_ROW_GUARD, DEV_ROW_ID, END_MARKER, MARKER, ROW_ID, appendBlock, overrideBlock, rewrite, writePatch }

// Importable for tests; only `npm run reload` touches a profile.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}
