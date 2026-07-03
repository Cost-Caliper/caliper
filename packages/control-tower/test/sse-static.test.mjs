// test/sse-static.test.mjs — unit tests for src/sse.mjs (SSE channel: buffer
// replay, live tail, dead-client eviction, closeAll, keep-alive) and
// src/static.mjs (static file server: MIME map, ETag/304, traversal guard),
// the latter exercised through a real http.createServer with raw requests.
//
// Neither module touches sessions.mjs, so no _env.mjs sandbox is needed.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChannel } from '../src/sse.mjs'
import { serveStatic } from '../src/static.mjs'

// ---------------------------------------------------------------------------
// SSE channel
// ---------------------------------------------------------------------------

// Minimal fake ServerResponse — the res object is a true process boundary.
function fakeRes() {
  return {
    headers: {},
    writes: [],
    ended: false,
    listeners: {},
    setHeader(k, v) { this.headers[k] = v },
    flushHeaders() { this.flushed = true },
    write(chunk) { this.writes.push(chunk) },
    end() { this.ended = true },
    on(ev, fn) { this.listeners[ev] = fn },
  }
}

// createChannel() starts a real (unref'd) 15s keep-alive interval; capture it
// with a stubbed setInterval so tests stay synchronous and deterministic.
function makeChannel() {
  const realSetInterval = globalThis.setInterval
  let tick = null
  let intervalMs = null
  const fakeTimer = { unrefed: false, unref() { this.unrefed = true } }
  globalThis.setInterval = (fn, ms) => { tick = fn; intervalMs = ms; return fakeTimer }
  try {
    const ch = createChannel()
    return { ch, tick, intervalMs, fakeTimer }
  } finally {
    globalThis.setInterval = realSetInterval
  }
}

// MUTATION-PROVED: commenting out `buffer.push(payload)` in emit() (sse.mjs:15)
// fails this test: "late joiner got full buffer replay in order".
test('sse: late joiner receives the full buffered event stream, in wire format', () => {
  const { ch } = makeChannel()
  try {
    ch.emit('a', { n: 1 })
    ch.emit('b', { n: 2 })
    ch.emit('c', { s: 'x' })
    assert.equal(ch.bufferSize(), 3, 'bufferSize counts buffered entries')

    const late = fakeRes()
    ch.attach(late)
    // Exact SSE wire shape: event line + JSON data line + blank line.
    assert.deepEqual(late.writes, [
      'event: a\ndata: {"n":1}\n\n',
      'event: b\ndata: {"n":2}\n\n',
      'event: c\ndata: {"s":"x"}\n\n',
    ], 'late joiner got full buffer replay in order')
    assert.equal(late.headers['Content-Type'], 'text/event-stream')
    assert.equal(late.headers['X-Accel-Buffering'], 'no')
    assert.ok(late.flushed, 'headers flushed on attach')
  } finally {
    ch.closeAll()
  }
})

test('sse: attached client tails live events emitted after attach', () => {
  const { ch } = makeChannel()
  try {
    const client = fakeRes()
    ch.attach(client)
    assert.deepEqual(client.writes, [], 'nothing buffered before attach')
    ch.emit('tick', { i: 0 })
    ch.emit('tick', { i: 1 })
    assert.deepEqual(client.writes, [
      'event: tick\ndata: {"i":0}\n\n',
      'event: tick\ndata: {"i":1}\n\n',
    ], 'live events reach attached client')
  } finally {
    ch.closeAll()
  }
})

// MUTATION-PROVED: changing `catch { clients.delete(res) }` to `catch {}` in
// emit() (sse.mjs:17) fails this test: "dead client evicted: write not retried".
test('sse: a client whose write throws is evicted; later emits skip it and do not throw', () => {
  const { ch } = makeChannel()
  try {
    let calls = 0
    const dead = fakeRes()
    dead.write = () => { calls++; throw new Error('EPIPE') }
    const alive = fakeRes()
    ch.attach(dead)
    ch.attach(alive)

    ch.emit('a', 1)             // dead.write throws -> evicted
    assert.equal(calls, 1)
    assert.doesNotThrow(() => ch.emit('b', 2))
    assert.equal(calls, 1, 'dead client evicted: write not retried')
    assert.equal(alive.writes.length, 2, 'healthy client unaffected by eviction')
  } finally {
    ch.closeAll()
  }
})

// MUTATION-PROVED: removing the `try { res.end() } catch {}` loop from
// closeAll() (sse.mjs:58-60) fails this test: "closeAll ends client 0/1".
test('sse: closeAll ends every attached client; buffer entries survive', () => {
  const { ch } = makeChannel()
  const a = fakeRes()
  const b = fakeRes()
  ch.attach(a)
  ch.attach(b)
  ch.emit('e', {})
  ch.closeAll()
  assert.equal(a.ended, true, 'closeAll ends client 0')
  assert.equal(b.ended, true, 'closeAll ends client 1')
  // Pinning actual semantics: closeAll clears clients but NOT the buffer.
  assert.equal(ch.bufferSize(), 1)
  // Emitting after closeAll must not throw (no clients left).
  assert.doesNotThrow(() => ch.emit('late', {}))
})

// MUTATION-PROVED: removing the `emitRaw(': keep-alive\n\n')` call inside the
// interval (sse.mjs:46) fails this test: "keep-alive comment reaches client".
test('sse: keep-alive interval is 15s, unref\'d, and emits an SSE comment (invoked synchronously via stubbed timer)', () => {
  const { ch, tick, intervalMs, fakeTimer } = makeChannel()
  try {
    assert.equal(intervalMs, 15_000)
    assert.equal(fakeTimer.unrefed, true, 'keep-alive timer is unref\'d so it cannot hold the process open')
    const client = fakeRes()
    ch.attach(client)
    tick()                       // fire the interval callback by hand — no waiting
    assert.deepEqual(client.writes, [': keep-alive\n\n'], 'keep-alive comment reaches client')
    assert.equal(ch.bufferSize(), 1, 'keep-alive raw payloads are buffered too (pinned semantics)')
  } finally {
    ch.closeAll()
  }
})

// ---------------------------------------------------------------------------
// static file server — through a real http server + raw socket-level paths
// ---------------------------------------------------------------------------

const __dir = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC = join(__dir, '..', 'public')

async function withServer(fn) {
  const server = http.createServer((req, res) => {
    if (!serveStatic(req, res)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  try {
    return await fn(server.address().port)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

// http.request sends `path` verbatim (unlike fetch/URL, which normalize '..'),
// so traversal probes actually reach serveStatic un-normalized.
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('static: "/" serves public/index.html as text/html with correct body', async () => {
  await withServer(async (port) => {
    const res = await rawGet(port, '/')
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(res.body, readFileSync(join(PUBLIC, 'index.html'), 'utf8'))
    assert.equal(res.headers['cache-control'], 'no-cache', 'html is no-cache for dev iteration')
  })
})

// MUTATION-PROVED (font branch): changing `const isFont = ...` to `const isFont
// = false` (static.mjs:66) fails this test: "font gets immutable long cache".
test('static: MIME map — .js, .css, .png, and .woff2 (font gets long-cache header)', async () => {
  await withServer(async (port) => {
    const js = await rawGet(port, '/app.js')
    assert.equal(js.status, 200)
    assert.equal(js.headers['content-type'], 'application/javascript; charset=utf-8')

    const css = await rawGet(port, '/app.css')
    assert.equal(css.status, 200)
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')

    const png = await rawGet(port, '/icon-dark-32x32.png')
    assert.equal(png.status, 200)
    assert.equal(png.headers['content-type'], 'image/png')

    const font = await rawGet(port, '/fonts/Geist-Variable.woff2')
    assert.equal(font.status, 200)
    assert.equal(font.headers['content-type'], 'font/woff2')
    assert.equal(font.headers['cache-control'], 'public, max-age=31536000, immutable',
      'font gets immutable long cache')
  })
})

// MUTATION-PROVED: changing the 304 comparison (static.mjs:57) to
// `req.headers['if-none-match'] === tag + 'x'` fails this test:
// "matching If-None-Match yields 304".
test('static: ETag flow — 200 carries ETag, If-None-Match round-trip yields empty 304', async () => {
  await withServer(async (port) => {
    const first = await rawGet(port, '/index.html')
    assert.equal(first.status, 200)
    const tag = first.headers['etag']
    assert.match(tag, /^"[0-9a-f]{16}"$/, 'ETag is a quoted 16-hex-char hash')

    const second = await rawGet(port, '/index.html', { 'if-none-match': tag })
    assert.equal(second.status, 304, 'matching If-None-Match yields 304')
    assert.equal(second.body, '', '304 has empty body')

    const stale = await rawGet(port, '/index.html', { 'if-none-match': '"deadbeefdeadbeef"' })
    assert.equal(stale.status, 200, 'non-matching ETag serves full content')
  })
})

// MUTATION-PROVED (compound): the two traversal guards in static.mjs are each
// individually sufficient (join() normalizes '..', so after the strip the
// startsWith(PUBLIC) check is unreachable, and vice versa). Removing EITHER
// alone stays green; removing BOTH — `.replace(/\.\./g, '')` (static.mjs:40)
// AND the `!filePath.startsWith(PUBLIC)` check (static.mjs:44-46) — fails this
// test: "raw '/../server.mjs' must not leak" (leaked HTTP 200 with file body).
test('static: path traversal probes never return files outside public/', async () => {
  await withServer(async (port) => {
    const probes = [
      '/../server.mjs',            // plain parent traversal (sent raw, un-normalized)
      '/../../package.json',       // deeper traversal to a file that certainly exists
      '/..%2f..%2fserver.mjs',     // percent-encoded slash form
      '/%2e%2e/%2e%2e/server.mjs', // percent-encoded dots form
      '/....//server.mjs',         // doubled-dots form (strip could recreate '..')
      '/....//....//package.json', // doubled-dots, deeper
      '/..\\server.mjs',           // backslash traversal attempt
    ]
    for (const probe of probes) {
      const res = await rawGet(port, probe)
      assert.equal(res.status, 404, `raw '${probe}' must not leak (got ${res.status})`)
      assert.ok(!res.body.includes('serveStatic') && !res.body.includes('"scripts"'),
        `raw '${probe}' body must not contain file contents outside public/`)
    }
  })
})

test('static: unknown path and directory path both 404', async () => {
  await withServer(async (port) => {
    const missing = await rawGet(port, '/no-such-file.js')
    assert.equal(missing.status, 404)
    const dir = await rawGet(port, '/fonts')  // exists but is a directory -> not served
    assert.equal(dir.status, 404)
    const query = await rawGet(port, '/app.js?v=1')  // query string stripped before lookup
    assert.equal(query.status, 200)
  })
})
