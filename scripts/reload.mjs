/**
 * Point a running `dsh` at this checkout's newest Host bundle.
 *
 * Node caches an ES module by resolved URL, so re-applying a profile patch that
 * names the same file hands the Loader the module it already has. `npm run
 * build` therefore also writes a content-addressed copy (`lib/index.dev.<digest>.js`),
 * and this script rewrites the profile row to name the newest one and touches the
 * patch file so the live watcher re-applies it.
 *
 * Every path is resolved at run time — `$DSH_HOME` (or `~/.dsh`), the profile
 * directory found by looking at which patch mentions this plugin, and the
 * relative hop from that profile back to `lib/` — so neither this script nor the
 * patch file has to carry a hard-coded home directory. The row keeps a RELATIVE
 * name, which DSH itself anchors to the patch file's directory.
 *
 * Usage: `npm run reload` (after `npm run build`), optionally with
 * `DSH_PROFILE=<name>` when more than one profile mounts the plugin.
 */
import { existsSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-stock-portfolio'
const ROW_ID = 'stock-portfolio'

/**
 * Resolve the harness home, matching `dsh`'s own default.
 * @returns the absolute DSH home directory.
 */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * Find the profile patches that mount this plugin.
 * @param home - the harness home.
 * @returns absolute patch-file paths, in profile-name order.
 */
function patchFiles(home) {
  const profiles = join(home, 'profiles')
  if (!existsSync(profiles)) return []
  const wanted = process.env.DSH_PROFILE?.trim()
  return readdirSync(profiles)
    .filter(name => wanted === undefined || wanted === '' || name === wanted)
    .map(name => join(profiles, name, 'cordis.patch.yml'))
    .filter(file => existsSync(file) && readFileSync(file, 'utf8').includes(ROW_ID))
}

/**
 * The newest content-addressed Host bundle, or the canonical one when no dev
 * copy exists yet.
 * @returns the absolute bundle path.
 */
function newestBundle() {
  const lib = join(PACKAGE_ROOT, 'lib')
  const copies = readdirSync(lib)
    .filter(name => /^index\.dev\..+\.js$/u.test(name))
    .map(name => ({ name, at: statSync(join(lib, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)
  return copies.length > 0 ? join(lib, copies[0].name) : join(lib, 'index.js')
}

/**
 * Rewrite the plugin row's `name:` line, keeping it relative to the patch file.
 * @param body - the patch file's text.
 * @param specifier - the relative path to write.
 * @returns the new text, or `null` when the row is not in the expected shape.
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

const bundle = newestBundle()
const files = patchFiles(dshHome())
if (files.length === 0) {
  console.error(`[${PACKAGE_NAME}] no profile patch mounts ${ROW_ID}; pass DSH_PROFILE=<name> or install it with \`dsh plugin add\``)
  process.exitCode = 1
} else {
  for (const file of files) {
    // `relative` already yields forward slashes on POSIX; normalise for Windows,
    // where DSH resolves the name as a path either way.
    const specifier = relative(dirname(file), bundle).split(sep).join('/')
    const body = readFileSync(file, 'utf8')
    const next = rewrite(body, specifier)
    if (next === null) {
      console.error(`[${PACKAGE_NAME}] ${file} has no \`- id: ${ROW_ID}\` row followed by a name; leaving it alone`)
      process.exitCode = 1
      continue
    }
    writeFileSync(file, next)
    // The watcher re-applies on an mtime change; a rebuild that produced the same
    // digest would otherwise leave the running process on the module it has.
    const now = new Date()
    utimesSync(file, now, now)
    console.log(`[${PACKAGE_NAME}] ${file} -> ${specifier}`)
  }
}
