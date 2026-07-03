// test/server.test.mjs — node --test: exercises the Control Tower API endpoints.
//
// Tests:
//   - GET /v1/health returns {ok:true, providers:{...}, workflowCount, cassetteCount}
//   - GET /v1/workflows returns array of workflows with id/name/lintOk/etc.
//   - GET /v1/workflows/:id returns full detail with graphSvg + estimate
//   - GET /v1/cassettes returns array of cassettes
//   - POST /v1/runs with no key + mode:live -> 412 MISSING_CREDENTIAL
//   - POST /v1/runs with mode:replay streams a 'done' event
//
// We start the server on a random port, run requests, then tear it down.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))

// ── Minimal server startup (import + listen on random port) ──────────────────

// We can't easily import server.mjs as a library (it starts immediately),
// so we test against the JSON API directly using HTTP requests to the live server.
// For CI with no key we test the fail-closed path; for replay we need a cassette.

// Pick a high, unlikely-to-collide port for the self-started server. We avoid the
// app default (8787) so an unrelated local service on that port can't masquerade as
// the Control Tower and make every route 404 — the failure mode that gave false reds.
const SELF_PORT = process.env.PORT || String(20000 + Math.floor(Math.random() * 20000))
let BASE = `http://localhost:${SELF_PORT}`
let serverProcess = null

// A response only counts as "our server" if /v1/health returns the Control Tower shape.
function isControlTower(body) {
  return body && body.ok === true && typeof body.workflowCount === 'number' && typeof body.cassetteCount === 'number'
}

// Helper: HTTP GET -> JSON
async function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) })
        } catch {
          resolve({ status: res.statusCode, body })
        }
      })
    }).on('error', reject)
  })
}

// Helper: HTTP POST -> JSON
async function post(path, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data)
    const req = http.request(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf) })
        } catch {
          resolve({ status: res.statusCode, body: buf })
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Helper: check if server is up
async function waitForServer(retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await get('/v1/health')
      if (isControlTower(res.body)) return true
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('Server did not start in time')
}

before(async () => {
  // If a Control Tower is already answering on BASE, reuse it. Otherwise start our own
  // on the dedicated SELF_PORT so the suite is deterministic and never asserts against
  // an unrelated service that happens to occupy the port.
  try {
    const res = await get('/v1/health')
    if (isControlTower(res.body)) {
      console.log('[test] reusing Control Tower at', BASE)
      return
    }
  } catch { /* nothing there — start our own */ }

  console.log('[test] starting Control Tower on', BASE)
  serverProcess = spawn(process.execPath, [join(__dir, '..', 'server.mjs')], {
    env: { ...process.env, PORT: SELF_PORT },
    stdio: 'ignore',
  })
  serverProcess.unref?.()
  await waitForServer(30)
})

after(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
})

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /v1/health — returns expected shape', async (t) => {
  let res
  try {
    res = await get('/v1/health')
  } catch {
    // Server not running in this test context — report as skipped, not green
    t.skip('server not reachable')
    return
  }
  assert.equal(res.status, 200, 'status 200')
  assert.equal(res.body.ok, true, 'ok:true')
  assert.ok(typeof res.body.node === 'string', 'node version string')
  assert.ok(typeof res.body.providers === 'object', 'providers object')
  assert.ok('anthropic' in res.body.providers, 'anthropic key in providers')
  assert.ok('openrouter' in res.body.providers, 'openrouter key in providers')
  assert.ok(typeof res.body.workflowCount === 'number', 'workflowCount is a number')
  assert.ok(res.body.workflowCount >= 0, 'workflowCount >= 0')
  assert.ok(typeof res.body.cassetteCount === 'number', 'cassetteCount is a number')
})

test('GET /v1/workflows — returns array with known fields', async (t) => {
  let res
  try { res = await get('/v1/workflows') } catch { t.skip('server not reachable'); return }
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body), 'body is array')
  for (const w of res.body) {
    assert.ok(typeof w.id === 'string', 'workflow has id')
    assert.ok(typeof w.name === 'string', 'workflow has name')
    assert.ok(typeof w.lintOk === 'boolean', 'workflow has lintOk')
    assert.ok(Array.isArray(w.lintFindings), 'workflow has lintFindings')
    assert.ok(typeof w.agentCount === 'number', 'workflow has agentCount')
  }
})

test('GET /v1/workflows/:id — returns graphSvg + estimate', async (t) => {
  let listRes
  try { listRes = await get('/v1/workflows') } catch { t.skip('server not reachable'); return }
  if (!listRes.body?.length) { t.skip('no workflows loaded on this server'); return }
  const id = listRes.body[0].id
  const res = await get(`/v1/workflows/${encodeURIComponent(id)}`)
  assert.equal(res.status, 200)
  assert.ok(typeof res.body.graphSvg === 'string', 'graphSvg is string')
  assert.ok(res.body.graphSvg.includes('<svg'), 'graphSvg contains svg element')
  assert.ok(res.body.estimate !== undefined, 'estimate field present')
  assert.ok(typeof res.body.src === 'string', 'src is string')
  assert.ok(res.body.lint, 'lint field present')
})

test('GET /v1/workflows/:id — 404 for unknown id', async (t) => {
  let res
  try { res = await get('/v1/workflows/nonexistent-workflow-xyz') } catch { t.skip('server not reachable'); return }
  assert.equal(res.status, 404)
  assert.ok(res.body.error, 'error field present')
})

test('GET /v1/cassettes — returns array', async (t) => {
  let res
  try { res = await get('/v1/cassettes') } catch { t.skip('server not reachable'); return }
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body), 'body is array')
  // We expect at least the hello cassette recorded in the build step
  for (const c of res.body) {
    assert.ok(typeof c.id === 'string', 'cassette has id')
    assert.ok(typeof c.calls === 'number', 'cassette has calls count')
  }
})

test('POST /v1/runs — fail-closed: no key + live mode -> 412', async (t) => {
  let healthRes
  try { healthRes = await get('/v1/health') } catch { t.skip('server not reachable'); return }

  // Only run this test when no Anthropic key is present (CI environment)
  if (healthRes.body?.providers?.anthropic) {
    // Key is present — test that POST /v1/runs works (returns a runId, not 412)
    const listRes = await get('/v1/workflows')
    if (!listRes.body?.length) { t.skip('no workflows loaded on this server'); return }
    const id = listRes.body[0].id
    const res = await post('/v1/runs', { workflowId: id, mode: 'live' })
    // With a key, it should either start (201) or fail with a different error — not 412
    assert.notEqual(res.status, 412, 'should not be MISSING_CREDENTIAL when key is set')
    return
  }

  // No key — verify fail-closed
  const listRes = await get('/v1/workflows')
  if (!listRes.body?.length) { t.skip('no workflows loaded on this server'); return }
  const id = listRes.body[0].id
  const res = await post('/v1/runs', { workflowId: id, mode: 'live' })
  assert.equal(res.status, 412, '412 when no key and live mode')
  assert.ok(res.body?.error?.code === 'MISSING_CREDENTIAL', 'MISSING_CREDENTIAL error code')
})

test('POST /v1/runs — replay with hello cassette streams done', { timeout: 20000 }, async (t) => {
  let cassettesRes
  try { cassettesRes = await get('/v1/cassettes') } catch { t.skip('server not reachable'); return }
  if (!cassettesRes.body?.length) {
    t.skip('no cassettes available')
    return
  }
  const cassette = cassettesRes.body.find(c => c.id === 'hello') || cassettesRes.body[0]
  if (!cassette) { t.skip('no cassette resolved'); return }

  // Find the matching workflow
  const listRes = await get('/v1/workflows')
  if (!listRes.body?.length) { t.skip('no workflows loaded on this server'); return }
  const workflowId = cassette.id === 'hello' ? 'hello' : listRes.body[0].id

  const runRes = await post('/v1/runs', {
    workflowId,
    mode: 'replay',
    cassette: cassette.id,
  })
  assert.equal(runRes.status, 201, 'replay run starts with 201')
  assert.ok(runRes.body.runId, 'runId present')
  assert.ok(runRes.body.streamUrl, 'streamUrl present')

  const runId = runRes.body.runId

  // Poll the run snapshot until done (simpler than SSE parse and avoids connection leak)
  let finalSnap = null
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200))
    const snapRes = await get(`/v1/runs/${runId}`)
    if (snapRes.body.status === 'done' || snapRes.body.status === 'ok') {
      finalSnap = snapRes.body
      break
    }
    if (snapRes.body.status === 'error') {
      throw new Error(`Replay run errored: ${JSON.stringify(snapRes.body.error)}`)
    }
  }

  assert.ok(finalSnap, 'run reached done status within polling window')
  assert.ok(finalSnap.telemetry?.run?.calls >= 0, 'telemetry has call count')
})

// ── Local-only request guard ──────────────────────────────────────────────────

// Raw GET with arbitrary headers (fetch forbids overriding Host).
async function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + path, { method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }) }
        catch { resolve({ status: res.statusCode, body }) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

test('guard — non-localhost Host header is rejected (DNS rebinding)', async () => {
  const res = await rawGet('/v1/health', { Host: 'evil.example.com' })
  assert.equal(res.status, 403, 'status 403')
  assert.equal(res.body?.error?.code, 'FORBIDDEN')
})

test('guard — cross-origin Origin header is rejected', async () => {
  const res = await rawGet('/v1/health', { Origin: 'https://evil.example.com' })
  assert.equal(res.status, 403, 'status 403')
  assert.equal(res.body?.error?.code, 'FORBIDDEN')
})

test('guard — Origin "null" (sandboxed iframe / file://) is rejected', async () => {
  const res = await rawGet('/v1/health', { Origin: 'null' })
  assert.equal(res.status, 403, 'status 403')
})

test('guard — localhost Origin is allowed', async () => {
  const res = await rawGet('/v1/health', { Origin: `http://localhost:${SELF_PORT}` })
  assert.equal(res.status, 200, 'status 200')
  assert.equal(res.body.ok, true)
})

test('guard — observed runId traversal attempt returns 404, not file contents', async () => {
  // ..%2f decodes to ../ in the route param; parseRunJson must reject it.
  const res = await rawGet('/v1/observed/x%2f..%2f..%2fsettings')
  assert.ok(res.status === 404 || res.status === 503, `404/503, got ${res.status}`)
})
