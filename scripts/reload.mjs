/**
 * Point a running `dsh` at this checkout's newest Host bundle.
 *
 * The plugin is installed as a normal profile bundle (`dsh plugin --profile web
 * add <checkout>`) — the plugin manager writes it into `dsh.profile.bundles` and
 * links the checkout into the profile's node_modules, so the package's own
 * `cordis.patch.yml` supplies the `stock-portfolio` row and the row loads
 * `lib/index.js` by default. This script adds the DEV OVERRIDE on top of that
 * row: a profile patch row with the same id whose `name` names the
 * content-addressed `lib/index.dev.<digest>.js`.
 *
 * The digest is why the override exists. Node caches an ES module by resolved
 * URL, so re-applying a patch that names the same file hands the Loader the
 * module it already has; a rebuild writes a NEW digest, which is a URL the Loader
 * has never imported. That is what makes a Host-side change live without
 * restarting `dsh`, on top of the manager-installed bundle rather than instead
 * of it. Without the override the mounted row keeps the package entry
 * `lib/index.js`, and a Host-side change then needs a `dsh` restart.
 *
 * Every path is resolved at run time — `$DSH_HOME` (or `~/.dsh`), the profile
 * directory holding the override row, and the relative hop from that profile
 * back to `lib/` — so neither this script nor the patch file has to carry a
 * hard-coded home directory. The row keeps a RELATIVE name, which DSH itself
 * anchors to the patch file's directory.
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
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-stock-portfolio'
const ROW_ID = 'stock-portfolio'
/** Comment line marking this checkout's dev override, wherever this script wrote it. */
const MARKER = `# --- ${PACKAGE_NAME} dev override ---`

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
 * Replace the patch, then read it back.
 *
 * The read-back is the guard that matters: this one file decides whether the
 * harness starts at all, so the script confirms that what is now on disk still
 * carries the row it just rewrote before it reports success.
 * @param path - the patch file.
 * @param body - the new contents.
 * @param specifier - the module specifier that must appear on the row.
 * @throws {Error} when the written file does not carry the row and its name.
 */
function writePatch(path, body, specifier) {
  replaceAtomically(path, body)
  const written = readFileSync(path, 'utf8')
  if (!written.includes(`- id: ${ROW_ID}`) || !written.includes(`name: ${specifier}`)) {
    throw new Error(`${path} did not read back with the ${ROW_ID} row; restore it from a backup before starting dsh`)
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

/**
 * Rewrite the dev override row's `name:` line, keeping it relative to the patch
 * file.
 * @param body - the patch file's text.
 * @param specifier - the relative path to write.
 * @returns the new text, or `null` when the override row is not in the expected shape.
 */
function rewrite(body, specifier) {
  const lines = body.split('\n')
  const idAt = lines.findIndex(line => line.trim() === `- id: ${ROW_ID}`)
  if (idAt === -1) return null
  const nameAt = lines.findIndex((line, index) => index > idAt && /^\s*name:/u.test(line))
  if (nameAt === -1) return null
  const indent = /^\s*/u.exec(lines[nameAt])[0]
  lines[nameAt] = `${indent}name: ${specifier}`
  return lines.join('\n')
}

/**
 * Append the dev override row to a profile patch that has none yet.
 *
 * This is the shape a fresh `dsh plugin add` leaves behind: the bundle is
 * selected and supplies its own row, and the profile patch only carries
 * unrelated overrides.
 * @param body - the patch file's text.
 * @param specifier - the relative path to write.
 * @returns the new text.
 */
function appendOverride(body, specifier) {
  const separator = body.endsWith('\n') ? '' : '\n'
  return `${body}${separator}\n${MARKER}\n- id: ${ROW_ID}\n  name: ${specifier}\n`
}

const bundle = newestBundle()
const profile = findProfile(dshHome())
if (profile === null) {
  console.error(`[${PACKAGE_NAME}] no profile selects this bundle; install it with \`dsh plugin --profile <name> add ${PACKAGE_ROOT}\``)
  process.exitCode = 1
} else {
  // `relative` already yields forward slashes on POSIX; normalise for Windows,
  // where DSH resolves the name as a path either way.
  const specifier = relative(dirname(profile.patch), bundle).split(sep).join('/')
  const body = existsSync(profile.patch) ? readFileSync(profile.patch, 'utf8') : ''
  const marked = body.includes(MARKER)
  const next = marked ? rewrite(body, specifier) : appendOverride(body, specifier)
  if (next === null) {
    console.error(`[${PACKAGE_NAME}] ${profile.patch} has the dev override marker but no \`- id: ${ROW_ID}\` row followed by a name; leaving it alone`)
    process.exitCode = 1
  } else {
    writePatch(profile.patch, next, specifier)
    // The watcher re-applies on an mtime change; a rebuild that produced the same
    // digest would otherwise leave the running process on the module it has.
    const now = new Date()
    utimesSync(profile.patch, now, now)
    console.log(`[${PACKAGE_NAME}] ${profile.patch} -> ${specifier}`)
  }
}
