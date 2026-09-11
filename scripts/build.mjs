/**
 * Build script for dsh-stock-portfolio.
 *
 * Two artifacts, both written to `lib/`:
 *
 *   lib/index.js   — the Host half, ESM for Node. `@deepseek-ai/*` and Node
 *                    builtins stay external: the Host runs from a real DSH
 *                    install where those resolve, and the published cordis
 *                    package must be the same instance the harness uses.
 *
 *   lib/client.js  — the browser half, a closure-factory CJS artifact in the
 *                    exact shape dsh-client-modules serves: the file calls
 *                    `window.__ModuleLoader__.load({ id, factory })` and
 *                    resolves its externals through the injected `require`
 *                    (the shell's frozen platform module table). Anything not
 *                    on that table is inlined, because a `require()` the table
 *                    cannot answer is a guaranteed runtime throw.
 *
 * `--watch` rebuilds on change for use next to `pnpm run dev:web`.
 */
import { build, context } from 'esbuild'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_NAME = 'dsh-stock-portfolio'

/**
 * The shell's frozen platform module table (`packages/client/web/src/platform.ts`
 * -> `PLATFORM_MODULES`). A client bundle may `require` exactly these; every
 * other bare specifier is inlined. Drift here is a runtime throw, not a build
 * error, so this list is the one thing to re-check against a DSH upgrade.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Everything the Host half resolves at runtime instead of inlining. */
const HOST_EXTERNALS = ['@deepseek-ai/*']

/**
 * The wrapper dsh-client-modules requires around a bundled client artifact.
 *
 * The shipped preset emits `intro` as a separate rolldown option; esbuild has no
 * equivalent, so the CJS prelude rides the end of the banner — it must land
 * INSIDE the factory, before the bundle body.
 */
const CLIENT_WRAPPER = {
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {\n`
    + 'var module = { exports: {} }; var exports = module.exports;',
  footer: 'return module.exports; } });',
}

/** @type {import('esbuild').BuildOptions} */
const hostConfig = {
  entryPoints: [resolve(ROOT, 'src/index.ts')],
  outfile: resolve(ROOT, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external: HOST_EXTERNALS,
  // The Host half is ESM loaded by the Cordis loader; it owns no JSX.
  jsx: 'automatic',
}

/** @type {import('esbuild').BuildOptions} */
const clientConfig = {
  entryPoints: [resolve(ROOT, 'src/client/index.tsx')],
  outfile: resolve(ROOT, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  external: CLIENT_EXTERNALS,
  jsx: 'automatic',
  banner: { js: CLIENT_WRAPPER.banner },
  footer: { js: CLIENT_WRAPPER.footer },
  // A CJS browser bundle cannot carry `import.meta`; the two libraries that
  // would emit it choose their production branch through these defines.
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env': '{"MODE":"production"}',
  },
  // Injected styles are part of the bundle, not a side file: the factory is
  // the only place a plugin may touch the document.
  loader: { '.css': 'text' },
}

mkdirSync(resolve(ROOT, 'lib'), { recursive: true })

if (process.argv.includes('--watch')) {
  const contexts = await Promise.all([context(hostConfig), context(clientConfig)])
  await Promise.all(contexts.map(async (ctx) => { await ctx.watch() }))
  console.log('[dsh-stock-portfolio] watching src/ -> lib/')
} else {
  await Promise.all([build(hostConfig), build(clientConfig)])
  writeDevHostCopy()
  console.log('[dsh-stock-portfolio] built lib/index.js and lib/client.js')
}

/**
 * Mirror the Host bundle to a second filename.
 *
 * Node's ESM cache is keyed by resolved URL, so re-importing `lib/index.js`
 * after a rebuild hands the loader the module it already has. A profile row that
 * points at this copy can therefore be re-pointed at a *new* name to pick up a
 * rebuild without restarting `dsh` — the loop `pnpm run build` names it
 * `index.dev.N.js` and the row follows. Nothing in the shipped package uses it;
 * the canonical entry is always `lib/index.js`.
 */
function writeDevHostCopy() {
  // Content-derived, so a rebuild that changed nothing keeps the same name (and
  // the profile row that points at it keeps working), while a real change yields
  // a name the Loader has never cached.
  const digest = createHash('sha256').update(readFileSync(resolve(ROOT, 'lib/index.js'))).digest('hex').slice(0, 10)
  const name = `index.dev.${digest}.js`
  for (const entry of readdirSync(resolve(ROOT, 'lib'))) {
    // Only the newest copy is ever referenced; the rest would just accumulate.
    if (/^index\.dev\..*\.js(\.map)?$/u.test(entry) && entry !== name && entry !== `${name}.map`) {
      rmSync(resolve(ROOT, 'lib', entry), { force: true })
    }
  }
  copyFileSync(resolve(ROOT, 'lib/index.js'), resolve(ROOT, 'lib', name))
  copyFileSync(resolve(ROOT, 'lib/index.js.map'), resolve(ROOT, 'lib', `${name}.map`))
  console.log(`[dsh-stock-portfolio] dev host copy: lib/${name}`)
}
