/**
 * The plugin mark's render test.
 *
 * The mark exists in two forms and they must stay recognisably the same logo:
 * the full-colour `logo.svg` declared through the manifest's `icon` (the Plugin
 * manager draws it) and the themed glyph `icons.tsx` renders in the sidebar,
 * where a fixed blue would ignore the light/dark theme its neighbours follow.
 *
 * A regression here is silent — an SVG that still draws SOMETHING looks fine in
 * isolation — so the assertions below pin the arrangement (three overlapping
 * circles, a rising four-point trend line, an arrow head at its tip) and the
 * theming rule (`currentColor` only, no hard-coded paint) that makes the sidebar
 * seat belong to the harness.
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { test } from 'node:test'

import { build } from 'esbuild'
import * as jsxRuntime from 'react/jsx-runtime'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const ROOT = new URL('../', import.meta.url)

/**
 * Bundle the glyph the way the client bundle does, then evaluate it against the
 * platform module table — the same shape `client-render.test.mjs` uses, because
 * a `data:` URL cannot resolve the bare `react/jsx-runtime` import on its own.
 * @returns the module's exports.
 */
async function loadIcon() {
  const built = await build({
    entryPoints: [new URL('src/client/icons.tsx', ROOT).pathname],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    write: false,
  })
  const code = built.outputFiles[0].text
  const module = { exports: {} }
  const require_ = (specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`icon test: require("${specifier}") missed the module table`)
  }
  // eslint-disable-next-line no-new-func -- the input is the artifact this repo just bundled.
  new Function('module', 'exports', 'require', code)(module, module.exports, require_)
  return module.exports
}

test('the sidebar glyph is the logo: three overlapping circles under a rising trend line', async () => {
  const { IconPortfolioOutline16 } = await loadIcon()
  const markup = renderToStaticMarkup(React.createElement(IconPortfolioOutline16, { size: 18 }))

  // Three coins, overlapping, in the artwork's arrangement: two above, one below
  // and centred on the gap between them.
  const circles = [...markup.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/gu)]
  const outlines = circles.filter(match => Number(match[3]) > 2)
  assert.equal(outlines.length, 3, `expected three coin outlines, got ${String(outlines.length)}`)
  const [left, right, bottom] = outlines.map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
  assert.equal(left.y, right.y, 'the two upper coins sit on one line')
  assert.ok(left.x < right.x, 'the upper coins are left and right of each other')
  assert.ok(bottom.y > left.y, 'the third coin sits below the pair')
  assert.equal(bottom.x, (left.x + right.x) / 2, 'the lower coin is centred between them')

  // Two dots per upper coin plus the two ends of the trend line: the four
  // vertices the line turns at.
  const dots = circles.filter(match => Number(match[3]) <= 2)
  assert.equal(dots.length, 4, `expected four trend points, got ${String(dots.length)}`)

  // The trend line rises: its last vertex is the rightmost and the highest.
  const points = dots.map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
  const tip = points.reduce((best, point) => (point.x > best.x ? point : best))
  assert.equal(tip.y, Math.min(...points.map(point => point.y)), 'the rightmost point is also the highest')

  // Themed, not painted: the sidebar sits beside harness glyphs that inherit
  // `currentColor`, and a literal fill/stroke would break in one of the themes.
  assert.match(markup, /stroke="currentColor"/u)
  assert.match(markup, /fill="currentColor"/u)
  const hex = markup.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []
  assert.deepEqual(hex, [], `the glyph must not carry literal colours, found ${hex.join(', ')}`)

  assert.match(markup, /width="18" height="18"/u)
})

test('the manifest icon is the artwork the Plugin manager reads', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'))
  assert.equal(manifest.icon, './logo.svg', 'the manifest declares the package-root artwork')

  // `readPluginMeta` inlines this file as a data URI, and it accepts a manifest-
  // relative SVG inside the package of at most 256 KiB. Anything else is dropped
  // with a diagnostic rather than shown.
  assert.ok(manifest.files.includes('logo.svg'), 'the artwork ships with the package')
  const logo = readFileSync(new URL('logo.svg', ROOT), 'utf8')
  assert.ok(statSync(new URL('logo.svg', ROOT)).size < 256 * 1024, 'the artwork stays under the icon size limit')
  assert.match(logo, /<svg[^>]*viewBox="0 0 120 120"/u)
  assert.equal((logo.match(/<circle/gu) ?? []).length, 7, 'the artwork keeps its three coins and four trend points')

  // The same arrangement as the glyph: the artwork's coins are the three large
  // circles, so a future redraw of one form cannot quietly drop the other.
  const radii = [...logo.matchAll(/<circle[^>]*r="([\d.]+)"/gu)].map(match => Number(match[1]))
  assert.equal(radii.filter(radius => radius === 28).length, 3, 'the artwork keeps three coin outlines')
  assert.equal(radii.filter(radius => radius === 3.5).length, 4, 'the artwork keeps four trend points')
})
