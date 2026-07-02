// scripts/copy-fonts.mjs — manual font refresh (npm run fonts): copy the two
// Geist variable woff2 files from node_modules/geist into public/fonts/.
// The woff2 files are COMMITTED, so installs need no geist dependency and no
// install scripts; run `npm i --no-save geist && npm run fonts` only to bump
// the font version. If geist is absent this logs a warning and exits 0.

import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const root = join(__dir, '..')
const outDir = join(root, 'public', 'fonts')

const FONTS = [
  {
    src: join(root, 'node_modules', 'geist', 'dist', 'fonts', 'geist-sans', 'Geist-Variable.woff2'),
    dst: join(outDir, 'Geist-Variable.woff2'),
    label: 'Geist Sans variable',
  },
  {
    src: join(root, 'node_modules', 'geist', 'dist', 'fonts', 'geist-mono', 'GeistMono-Variable.woff2'),
    dst: join(outDir, 'GeistMono-Variable.woff2'),
    label: 'Geist Mono variable',
  },
]

mkdirSync(outDir, { recursive: true })

let allOk = true
for (const { src, dst, label } of FONTS) {
  if (!existsSync(src)) {
    console.warn(`[copy-fonts] WARNING: ${label} not found at ${src} — server will use system font fallback`)
    allOk = false
    continue
  }
  copyFileSync(src, dst)
  console.log(`[copy-fonts] copied ${label} -> public/fonts/`)
}

if (allOk) {
  console.log('[copy-fonts] fonts ready — server will self-host, no CDN needed')
}
