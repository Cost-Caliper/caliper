// scripts/copy-fonts.mjs — postinstall: copy the two Geist variable woff2 files
// from node_modules/geist into public/fonts/ so the server can self-host them
// with NO CDN dependency at serve time.
//
// If the geist package is absent (CI without devDeps, etc.) this script logs a
// warning and exits 0 — the server will fall back to system fonts gracefully.

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
