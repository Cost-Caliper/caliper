// test/run-routes-guards.test.mjs — run-pipeline route wiring in server.mjs against a
// REAL spawned server (node server.mjs on a pid-derived high port). All hermetic:
// replay-mode (committed hello cassette) or guard paths only — zero network, zero keys.
//
// Spawn env is sandboxed:
//   HOME                 → mkdtemp (sessions.mjs disk cache never touches ~/.cache)
//   WFLENS_PROJECTS_ROOT → empty mkdtemp dir (no real machine scanning)
//   WFLENS_SESSION_DIR   → DELETED (observed-runs features off; not under test here)
//   ANTHROPIC_API_KEY / OPENROUTER_API_KEY → DELETED (fail-closed credential guards)
//
// Routes covered:
//   GET  /v1/workflows/:id/editable            — 200 descriptor shape + 404
//   POST /v1/workflows/:id/edit-run            — 400 EDIT_INVALID, 412 MISSING_CREDENTIAL,
//                                                412 CACHE_MISS, 404, and the happy replay
//                                                path (201 → terminal ok + .edited temp file)
//   POST /v1/runs/:runId/apply-optimization    — 201 + previousRunId + proposedRunBody merge
//                                                (governor.cap + run-start SSE), 404, 409
//   POST /v1/runs/:runId/learn                 — 404, 409 no-telemetry, 412 no key
//   RUN_LIMIT eviction                         — >20 stored runs evict the oldest (GET → 404)
//
// Deliberately NOT covered: learn success path (needs a real ANTHROPIC_API_KEY);
// apply-optimization 409 "while the original is still RUNNING" (timing-fragile — the
// hello cassette replay finishes in milliseconds; the same 409 NOT_READY guard is
// instead pinned deterministically via a run whose executeRun promise REJECTED with
// CACHE_MISS, which leaves run.snapshot null forever).
//
// Pinned-from-code notes (not bugs, but behavior this file certifies):
//   - useGate/useRouter only take effect in LIVE mode (runner.mjs steps 6-7 check
//     mode === 'live'); in replay the merged flags still reach executeRun (asserted via
//     the buffered run-start SSE event) but gate stats stay {realCalls:0,...}.
//   - POST /v1/runs pre-checks the cassette (412 CACHE_MISS before creating a run) but
//     POST /v1/runs/:id/apply-optimization does NOT — an unknown cassette override
//     yields 201 and the run then lands at status:'error' code:'CACHE_MISS'.
//
// MUTATION LOG (each proven RED against the temporarily-broken src, then restored GREEN):
//   M1 src/credentials.mjs probeCredentials → { anthropic: true, openrouter: true } →
//      "edit-run — live mode without keys → 412" fails (201 instead of 412) and
//      "learn — … 412 without ANTHROPIC_API_KEY" fails (200 ok instead of 412).
//   M2 server.mjs apply-optimization: drop `...proposed,` from newRunBody →
//      "apply-optimization — merges proposedRunBody" fails: governor.cap is null
//      (expected 0.05) and the run-start SSE event shows useGate:false.
//   M3 server.mjs edit-run step 4: cassette-missing check removed (always proceed) →
//      "edit-run — replay with no cassette → 412 CACHE_MISS" fails (201 instead of 412).
//   M4 server.mjs storeRun: eviction block removed →
//      "RUN_LIMIT — creating 20 more runs evicts the oldest" fails (200 instead of 404).

import './_env.mjs' // FIRST: HOME sandbox (server spawn transitively loads src/sessions.mjs)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = join(__dir, '..')

// pid-derived high port: deterministic within a run; offset differs from the other
// server-spawning suites (server-routes uses 21000+) so parallel files never collide.
const PORT = String(23000 + (process.pid % 20000))
const BASE = `http://localhost:${PORT}`

const HELLO_PROMPT = 'Reply with the single lowercase word: ok'

let root = null            // mkdtemp holding home + empty projects root
let serverProcess = null
const editedFiles = []     // .edited/<id>-r<runId>.workflow.js files to clean up

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function request(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + path, { method, headers }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => {
        let parsed = buf
        try { parsed = JSON.parse(buf) } catch { /* non-JSON — keep raw */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf })
      })
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}
const get = (path) => request('GET', path)
function post(path, data) {
  const body = JSON.stringify(data)
  return request('POST', path, {
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Poll GET /v1/runs/:runId until it leaves 'running' (terminal: ok | error | over-budget).
async function pollRunTerminal(runId, { tries = 100, intervalMs = 100 } = {}) {
  for (let i = 0; i < tries; i++) {
    const res = await get(`/v1/runs/${runId}`)
    if (res.status !== 200) throw new Error(`GET /v1/runs/${runId} → ${res.status}: ${res.raw}`)
    if (res.body.status !== 'running') return res.body
    await sleep(intervalMs)
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`)
}

// Read the buffered SSE stream of a (finished) run just long enough to capture one
// event by type. The channel replays its full buffer synchronously on attach
// (src/sse.mjs), so this is deterministic for completed runs.
function readSseEvent(runId, wantType, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}/v1/runs/${runId}/stream`, (res) => {
      let buf = ''
      res.on('data', (d) => {
        buf += d
        const m = buf.match(new RegExp(`event: ${wantType}\\ndata: (.*)\\n\\n`))
        if (m) {
          req.destroy()
          try { resolve(JSON.parse(m[1])) } catch (e) { reject(e) }
        }
      })
    })
    req.on('error', () => { /* destroyed after match — ignore */ })
    setTimeout(() => { req.destroy(); reject(new Error(`no ${wantType} event within ${timeoutMs}ms`)) }, timeoutMs).unref?.()
  })
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ct-runroutes-'))
  const home = join(root, 'home')
  const projectsRoot = join(root, 'projects')
  mkdirSync(home, { recursive: true })
  mkdirSync(projectsRoot, { recursive: true })

  const env = {
    ...process.env,
    PORT,
    HOME: home,                        // sandbox the sessions.mjs summary disk cache
    USERPROFILE: home,
    WFLENS_PROJECTS_ROOT: projectsRoot,
  }
  delete env.WFLENS_SESSION_DIR        // observed-runs features off (not under test)
  delete env.ANTHROPIC_API_KEY         // fail-closed credential guards
  delete env.OPENROUTER_API_KEY
  serverProcess = spawn(process.execPath, [join(PKG_DIR, 'server.mjs')], { env, stdio: 'ignore' })
  serverProcess.unref?.()

  // Poll /v1/health until OUR sandboxed server answers (no session dir = our spawn,
  // never an unrelated Control Tower that happens to sit on the port). The fail-closed
  // provider probe is asserted in the first test, NOT here — so a broken credential
  // probe reads as a targeted assertion failure, not "server did not start".
  for (let i = 0; i < 40; i++) {
    try {
      const res = await get('/v1/health')
      if (res.body?.ok === true && res.body?.bridge?.sessionDir === null
          && typeof res.body?.workflowCount === 'number') return
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('sandboxed fixture server did not start in time on port ' + PORT)
})

after(() => {
  try { if (serverProcess) serverProcess.kill('SIGTERM') } finally {
    serverProcess = null
    try { for (const f of editedFiles) rmSync(f, { force: true }) } finally {
      if (root) rmSync(root, { recursive: true, force: true })
    }
  }
})

// ── sanity: the sandboxed spawn really has no keys ────────────────────────────
// MUTATION M1 also trips here first: probeCredentials mutated to always-true makes
// providers.anthropic read true → RED with a named message.

test('GET /v1/health — sandboxed spawn is fail-closed (no provider keys)', async () => {
  const res = await get('/v1/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.providers.anthropic, false, 'ANTHROPIC_API_KEY deleted from child env')
  assert.equal(res.body.providers.openrouter, false, 'OPENROUTER_API_KEY deleted from child env')
})

// ── GET /v1/workflows/:id/editable ────────────────────────────────────────────

test('GET /v1/workflows/:id/editable — hello: one editable agent, full descriptor + modelOptions', async () => {
  const res = await get('/v1/workflows/hello/editable')
  assert.equal(res.status, 200)
  assert.equal(res.body.id, 'hello')
  assert.equal(res.body.name, 'fixture-hello')
  assert.deepEqual(res.body.modelOptions, ['haiku', 'sonnet', 'opus', 'fable'], 'MODEL_OPTIONS surfaced')
  assert.ok(typeof res.body.note === 'string' && res.body.note.length > 0, 'splice-editor caveat note present')
  assert.ok(Array.isArray(res.body.agents), 'agents is an array')
  assert.equal(res.body.agents.length, 1, 'hello declares exactly one static agent() call')
  const a = res.body.agents[0]
  assert.equal(a.index, 0)
  assert.equal(a.label, 'greeter')
  assert.equal(a.prompt, HELLO_PROMPT)
  assert.equal(a.promptEditable, true)
  assert.equal(a.model, 'haiku')
  assert.equal(a.modelExplicit, true)
  assert.equal(a.modelEditable, true)
  assert.equal(a.hasOpts, true)
  assert.equal(a.phase, null, 'phase not declared in the opts object')
  assert.equal(a.agentType, null)
})

test('GET /v1/workflows/:id/editable — unknown workflow id → 404 NOT_FOUND', async () => {
  const res = await get('/v1/workflows/no-such-workflow-xyz/editable')
  assert.equal(res.status, 404)
  assert.equal(res.body?.error?.code, 'NOT_FOUND')
})

// ── POST /v1/workflows/:id/edit-run — guards ──────────────────────────────────

test('POST /v1/workflows/:id/edit-run — unknown model in an edit → 400 EDIT_INVALID', async () => {
  const res = await post('/v1/workflows/hello/edit-run', {
    edits: [{ index: 0, model: 'gpt-4' }],
    mode: 'replay',
  })
  assert.equal(res.status, 400, 'invalid model rejected before any run is created')
  assert.equal(res.body?.error?.code, 'EDIT_INVALID')
  assert.match(String(res.body?.error?.message), /invalid model/, 'error names the problem')
})

// MUTATION M1: with probeCredentials mutated to always-true, both cases here return
// 201 (the run is created and only fails later inside executeRun) → RED. (Proven; restored.)
test('POST /v1/workflows/:id/edit-run — live mode without keys → 412 MISSING_CREDENTIAL (fail-closed)', async () => {
  const anth = await post('/v1/workflows/hello/edit-run', { edits: [], mode: 'live' })
  assert.equal(anth.status, 412, 'no ANTHROPIC_API_KEY in the spawn env → fail closed')
  assert.equal(anth.body?.error?.code, 'MISSING_CREDENTIAL')
  assert.match(String(anth.body?.error?.message), /ANTHROPIC_API_KEY/, 'error names the missing env var')

  const or = await post('/v1/workflows/hello/edit-run', { edits: [], mode: 'live', provider: 'openrouter' })
  assert.equal(or.status, 412)
  assert.equal(or.body?.error?.code, 'MISSING_CREDENTIAL')
  assert.match(String(or.body?.error?.message), /OPENROUTER_API_KEY/, 'openrouter provider checks its own key')
})

// MUTATION M3: removing the step-4 cassette-missing check in server.mjs edit-run makes
// the fanout case return 201 (run created, then errors async) → RED. (Proven; restored.)
test('POST /v1/workflows/:id/edit-run — replay with no cassette → 412 CACHE_MISS; unknown workflow → 404', async () => {
  // fanout has NO committed cassette (only hello.cassette.json exists)
  const miss = await post('/v1/workflows/fanout/edit-run', { edits: [], mode: 'replay' })
  assert.equal(miss.status, 412, 'replay without a recorded cassette fails before creating a run')
  assert.equal(miss.body?.error?.code, 'CACHE_MISS')
  assert.match(String(miss.body?.error?.message), /No cassette found/, 'error explains the miss')

  const unknown = await post('/v1/workflows/no-such-workflow-xyz/edit-run', { edits: [], mode: 'replay' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body?.error?.code, 'NOT_FOUND')
})

// ── POST /v1/workflows/:id/edit-run — happy replay path ───────────────────────
// The edit re-states the SAME prompt + model values (the cassette key is
// sha256(prompt + {model,max_tokens,schema}) — see workflow-lens/src/cassette.mjs — so
// the splice changes the SOURCE TEXT (single → double quotes) without changing the key,
// keeping the replay a guaranteed cassette hit).

test('POST /v1/workflows/:id/edit-run — valid edit + replay → 201, terminal ok, .edited temp file written', { timeout: 30000 }, async () => {
  const res = await post('/v1/workflows/hello/edit-run', {
    edits: [{ index: 0, prompt: HELLO_PROMPT, model: 'haiku' }],
    mode: 'replay',
  })
  assert.equal(res.status, 201, 'edit-run starts with 201')
  assert.ok(res.body.runId, 'runId present')
  assert.equal(res.body.streamUrl, `/v1/runs/${res.body.runId}/stream`)
  assert.equal(res.body.edited, true)

  // The edited source was written to .edited/<id>-r<runId>.workflow.js (runWorkflow reads a PATH)
  const editedPath = join(PKG_DIR, '.edited', `hello-r${res.body.runId}.workflow.js`)
  editedFiles.push(editedPath)
  assert.ok(existsSync(editedPath), `.edited temp file written: ${editedPath}`)
  const editedSrc = readFileSync(editedPath, 'utf8')
  assert.ok(editedSrc.includes(JSON.stringify(HELLO_PROMPT)), 'splice replaced the prompt literal (JSON double quotes)')
  assert.ok(editedSrc.includes('"haiku"'), 'splice replaced the model literal')

  // Poll the run to a terminal state (no SSE hang)
  const final = await pollRunTerminal(res.body.runId)
  assert.equal(final.status, 'ok', `edited replay completes: ${JSON.stringify(final.error || null)}`)
  assert.equal(final.telemetry.run.calls, 1, 'exactly one agent call replayed from the cassette')
  assert.ok(final.telemetry.run.costUsd > 0, 'replayed call still meters ledger cost')
})

// ── POST /v1/runs/:runId/apply-optimization ───────────────────────────────────

let baselineRunId = null   // completed replay run reused by apply-optimization + learn tests
let noSnapshotRunId = null // run whose executeRun REJECTED (snapshot stays null forever)

// MUTATION M2: dropping `...proposed,` from newRunBody in server.mjs apply-optimization
// makes governor.cap come back null (expected 0.05) and the run-start SSE event show
// useGate:false → RED. (Proven; restored.)
test('POST /v1/runs/:runId/apply-optimization — 201 new run, previousRunId set, proposedRunBody merged', { timeout: 30000 }, async () => {
  // Original run: plain replay of hello (no cap, no gate)
  const orig = await post('/v1/runs', { workflowId: 'hello', mode: 'replay' })
  assert.equal(orig.status, 201)
  baselineRunId = orig.body.runId
  const origFinal = await pollRunTerminal(baselineRunId)
  assert.equal(origFinal.status, 'ok')
  assert.equal(origFinal.governor.cap, null, 'baseline run has no cap')

  // Apply an optimization carrying capUsd + useGate
  const applied = await post(`/v1/runs/${baselineRunId}/apply-optimization`, {
    proposedRunBody: { capUsd: 0.05, useGate: true },
  })
  assert.equal(applied.status, 201, 'apply-optimization starts a new run')
  assert.ok(applied.body.runId, 'new runId present')
  assert.notEqual(applied.body.runId, baselineRunId, 'a NEW run, not the original')
  assert.equal(applied.body.previousRunId, baselineRunId, 'previousRunId links back to the original')
  assert.equal(applied.body.streamUrl, `/v1/runs/${applied.body.runId}/stream`)

  // The merged capUsd actually took effect: the governor was built with cap 0.05
  // (pinned from runner.mjs step 8 → governor.stats().cap in the final snapshot).
  const newFinal = await pollRunTerminal(applied.body.runId)
  assert.equal(newFinal.status, 'ok', 'optimized replay completes (cap far above replay cost)')
  assert.equal(newFinal.governor.cap, 0.05, 'merged capUsd reached createGovernor')

  // The merged useGate + capUsd + inherited mode reached executeRun: the buffered
  // run-start SSE event carries them verbatim. (Pinned from code: useGate only
  // INSTANTIATES a gate in live mode — runner.mjs step 7 — so in replay the flag is
  // visible in run-start while gate stats stay at their zero defaults.)
  const runStart = await readSseEvent(applied.body.runId, 'run-start')
  assert.equal(runStart.useGate, true, 'merged useGate passed through to executeRun')
  assert.equal(runStart.capUsd, 0.05)
  assert.equal(runStart.mode, 'replay', 'mode inherited from the original run')
  assert.equal(runStart.workflowId, 'hello')
  assert.equal(newFinal.gate.realCalls, 0, 'gate never instantiated in replay mode (live-only)')
})

test('POST /v1/runs/:runId/apply-optimization — unknown run → 404; snapshot-less run → 409 NOT_READY', { timeout: 30000 }, async () => {
  const missing = await post('/v1/runs/999999/apply-optimization', { proposedRunBody: {} })
  assert.equal(missing.status, 404)
  assert.equal(missing.body?.error?.code, 'NOT_FOUND')

  // Build a run whose snapshot stays null FOREVER (deterministic stand-in for the
  // timing-fragile "still running" 409): apply-optimization does NOT pre-check the
  // cassette for replay mode, so an unknown cassette override yields 201 and the
  // executeRun promise then REJECTS with CACHE_MISS — the .catch never sets snapshot.
  const doomed = await post(`/v1/runs/${baselineRunId}/apply-optimization`, {
    proposedRunBody: { cassette: 'no-such-cassette-xyz' },
  })
  assert.equal(doomed.status, 201, 'apply-optimization does not pre-check the cassette (pinned asymmetry vs POST /v1/runs)')
  noSnapshotRunId = doomed.body.runId
  const doomedFinal = await pollRunTerminal(noSnapshotRunId)
  assert.equal(doomedFinal.status, 'error')
  assert.equal(doomedFinal.error.code, 'CACHE_MISS', 'the miss surfaces on the run record')

  // That errored run has snapshot === null → the NOT_READY guard fires
  const notReady = await post(`/v1/runs/${noSnapshotRunId}/apply-optimization`, { proposedRunBody: {} })
  assert.equal(notReady.status, 409)
  assert.equal(notReady.body?.error?.code, 'NOT_READY')
})

// ── POST /v1/runs/:runId/learn — guards only (success path needs a real key) ──

// MUTATION M1 (same mutation as the edit-run 412 test): probeCredentials always-true
// turns the 412 case into 200 {ok:true} → RED. (Proven; restored.)
test('POST /v1/runs/:runId/learn — 404 unknown run; 409 no-telemetry; 412 without ANTHROPIC_API_KEY', async () => {
  const missing = await post('/v1/runs/999999/learn', {})
  assert.equal(missing.status, 404)
  assert.equal(missing.body?.error?.code, 'NOT_FOUND')

  // Run with no snapshot/telemetry (the CACHE_MISS-rejected run above) → 409
  assert.ok(noSnapshotRunId, 'prior test created the snapshot-less run')
  const notReady = await post(`/v1/runs/${noSnapshotRunId}/learn`, {})
  assert.equal(notReady.status, 409)
  assert.equal(notReady.body?.error?.code, 'NOT_READY')

  // Completed replay run + no ANTHROPIC_API_KEY in the spawn env → fail-closed 412
  assert.ok(baselineRunId, 'prior test created the completed baseline run')
  const noKey = await post(`/v1/runs/${baselineRunId}/learn`, {})
  assert.equal(noKey.status, 412, 'learn fails closed without a key (haiku distillation is a live call)')
  assert.equal(noKey.body?.error?.code, 'MISSING_CREDENTIAL')
  assert.match(String(noKey.body?.error?.message), /ANTHROPIC_API_KEY/)
})

// ── RUN_LIMIT eviction (LAST — it evicts every run the earlier tests created) ──

// MUTATION M4: removing the eviction block in server.mjs storeRun keeps the marker
// run forever → GET returns 200 → RED. (Proven; restored.)
test('RUN_LIMIT — storing 20 more runs evicts the oldest (GET → 404)', { timeout: 60000 }, async () => {
  const marker = await post('/v1/runs', { workflowId: 'hello', mode: 'replay' })
  assert.equal(marker.status, 201)
  const markerId = marker.body.runId
  assert.equal((await get(`/v1/runs/${markerId}`)).status, 200, 'marker run visible right after creation')

  // RUN_LIMIT is 20 (pinned from server.mjs) — 20 more stores push the marker out
  // regardless of how many runs earlier tests left in the map.
  let lastId = null
  for (let i = 0; i < 20; i++) {
    const r = await post('/v1/runs', { workflowId: 'hello', mode: 'replay' })
    assert.equal(r.status, 201, `filler run ${i + 1} created`)
    lastId = r.body.runId
  }

  const evicted = await get(`/v1/runs/${markerId}`)
  assert.equal(evicted.status, 404, 'oldest run evicted once the map exceeds RUN_LIMIT')
  assert.equal(evicted.body?.error?.code, 'NOT_FOUND')
  const newest = await get(`/v1/runs/${lastId}`)
  assert.equal(newest.status, 200, 'newest run still addressable')
})
