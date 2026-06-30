// src/static.mjs — tiny self-contained static file server.
// No CDN, no network fetch. Serves files from public/ with mime map + ETag.
// The ETag is derived from file size + mtime for a reliable cache bust.

import { readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dir = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC = join(__dir, '..', 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.ttf':   'font/ttf',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
}

function etag(st) {
  return '"' + createHash('md5').update(String(st.size) + String(st.mtimeMs)).digest('hex').slice(0, 16) + '"'
}

// Serve a static file from public/. Returns true if handled, false if 404/not-public.
export function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0]
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html'

  // Prevent path traversal
  const safePath = urlPath.replace(/\.\./g, '').replace(/\/+/g, '/')
  const filePath = join(PUBLIC, safePath)

  // Must be under PUBLIC
  if (!filePath.startsWith(PUBLIC)) {
    return false
  }

  if (!existsSync(filePath)) return false

  let st
  try { st = statSync(filePath) } catch { return false }
  if (!st.isFile()) return false

  const ext = extname(filePath).toLowerCase()
  const mime = MIME[ext] || 'application/octet-stream'
  const tag = etag(st)

  if (req.headers['if-none-match'] === tag) {
    res.writeHead(304)
    res.end()
    return true
  }

  const content = readFileSync(filePath)

  // Fonts get a long cache; HTML/JS/CSS short for dev iteration
  const isFont = ext === '.woff2' || ext === '.woff' || ext === '.ttf'
  const cacheControl = isFont ? 'public, max-age=31536000, immutable' : 'no-cache'

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': content.length,
    'ETag': tag,
    'Cache-Control': cacheControl,
  })
  res.end(content)
  return true
}
