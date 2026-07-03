// test/server-routes.test.mjs — end-to-end coverage of the session/observability
// routes against a REAL spawned server (node server.mjs on a pid-derived high port).
//
// The spawn env is fully sandboxed:
//   HOME                 → mkdtemp (the sessions.mjs summary disk cache never touches ~/.cache)
//   WFLENS_PROJECTS_ROOT → synthetic projects root built here (2 projects, 3 uuid sessions,
//                          one with a subagent-fallback transcript using the REAL wire shapes
//                          documented in test/fallbacks.test.mjs)
//   WFLENS_SESSION_DIR   → the alpha project's rich session dir
//   ANTHROPIC_API_KEY / OPENROUTER_API_KEY → DELETED (fail-closed checks)
//
// Routes covered: /v1/home, /v1/aggregate (drive-to-done + restart), /v1/projects,
// /v1/project/select, /v1/sessions, /v1/session/active, /v1/session/select (traversal),
// /v1/sessions/all, /v1/about, POST /v1/observe validation matrix + /v1/observed,
// /v1/observed/scripts, /v1/observed/:runId (traversal), /v1/observed/:runId/script,
// /v1/subagents (+404), static files (MIME, ETag/304, traversal), OPTIONS preflight + Host guard.
//
// Deliberately NOT covered here (see slice notes): POST /v1/self-update (spawns git),
// GET /v1/version (live outbound fetch — not hermetic), POST /v1/runs/:id/learn beyond
// what server.test.mjs already covers, edit-run happy paths.
//
// MUTATION LOG (each proven RED against the temporarily-broken src, then restored GREEN):
//   M1 src/sessions.mjs:15  SESSION_ID_RE loosened to /^.+$/ →
//      "POST /v1/session/select — traversal ids are rejected" fails: '../evil' returns 200
//      and SESS escapes the project dir (the planted <projectsRoot>/evil.jsonl gets summarized).
//   M2 server.mjs:831-834   validEvs whitelist check removed →
//      "POST /v1/observe — validation matrix" fails: ev:'bogus-event' returns 200 ok:true.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))

// pid-derived high port: deterministic within a run, collision-free across parallel CI shards.
const PORT = String(21000 + (process.pid % 20000))
const BASE = `http://localhost:${PORT}`

// ── fixture wire shapes ───────────────────────────────────────────────────────
// uLine/aLine mirror test/sessions.test.mjs; entry() mirrors test/fallbacks.test.mjs
// (bare refusal / fallback-block switch / sticky turn — real transcript signatures).
const uLine = (ts, text) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const aLine = (ts, model = 'claude-opus-4-8', cwd = '/repo', text = 'ok') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, cwd, gitBranch: 'main', message: { role: 'assistant', model, usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text }] } })

const U0 = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
function entry(over) {
  return JSON.stringify({
    type: 'assistant', timestamp: over.ts, requestId: over.req, uuid: over.uuid || over.req,
    message: {
      model: over.model, stop_reason: over.stop || 'end_turn',
      ...(over.stopDetails ? { stop_details: over.stopDetails } : {}),
      content: over.content || [{ type: 'text', text: over.text || 'ok' }],
      usage: over.usage,
    },
  })
}

const UUID_A = '11111111-2222-3333-4444-555555555555' // alpha: rich (subagent w/ fallbacks)
const UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' // alpha: plain
const UUID_C = '99999999-8888-7777-6666-555555555555' // beta: plain (haiku)
const UUID_D = '12121212-3434-5656-7878-909090909090' // beta: added later (restart test)
const ALPHA_SLUG = '-Users-x-develop-alpha'
const BETA_SLUG = '-Users-x-develop-beta'
const SUB_ID = 'ab12cd34'

let root = null            // mkdtemp holding everything (home + projects root)
let projectsRoot = null
let alphaDir = null
let betaDir = null
let sessA = null           // WFLENS_SESSION_DIR
let serverProcess = null

function buildFixtures() {
  root = mkdtempSync(join(tmpdir(), 'ct-routes-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  projectsRoot = join(root, 'projects')
  alphaDir = join(projectsRoot, ALPHA_SLUG)
  betaDir = join(projectsRoot, BETA_SLUG)
  mkdirSync(alphaDir, { recursive: true })
  mkdirSync(betaDir, { recursive: true })

  // Session A (alpha, rich): main transcript + a subagent transcript carrying the three
  // real fallback signatures (refusal / switch+streamed dupe / sticky).
  writeFileSync(join(alphaDir, `${UUID_A}.jsonl`), [
    uLine('2026-06-01T00:00:00.000Z', 'build the alpha thing'),
    aLine('2026-06-01T00:00:05.000Z'),
    aLine('2026-06-01T00:10:00.000Z'),
  ].join('\n') + '\n')
  sessA = join(alphaDir, UUID_A)
  mkdirSync(join(sessA, 'subagents'), { recursive: true })
  writeFileSync(join(sessA, 'subagents', `agent-${SUB_ID}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', description: 'fallback sub', toolUseId: 'tX' }))
  writeFileSync(join(sessA, 'subagents', `agent-${SUB_ID}.jsonl`), [
    uLine('2026-06-01T00:01:00.000Z', 'do the sub thing'),
    entry({ ts: '2026-06-01T00:01:10.000Z', req: 'req_norm', model: 'claude-fable-5', text: 'working', usage: { ...U0, input_tokens: 1000, output_tokens: 100 } }),
    // bare refusal (category captured for the aggregate rollup)
    entry({
      ts: '2026-06-01T00:01:20.000Z', req: 'req_refusal', model: 'claude-fable-5', stop: 'refusal',
      stopDetails: { type: 'refusal', category: 'cyber', explanation: null, fallback_has_prefill_claim: true },
      content: [{ type: 'thinking', thinking: 'hmm' }],
      usage: { ...U0, input_tokens: 685, output_tokens: 357 },
    }),
    // fallback SWITCH + its streamed dupe row (same requestId — must count once)
    entry({
      ts: '2026-06-01T00:01:30.000Z', req: 'req_switch', model: 'claude-opus-4-8',
      content: [
        { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } },
        { type: 'text', text: 'continuing on opus' },
      ],
      usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
    entry({
      ts: '2026-06-01T00:01:31.000Z', req: 'req_switch', model: 'claude-opus-4-8', text: 'streamed dupe',
      usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
    // sticky turn (fallback_message iterations, no block)
    entry({
      ts: '2026-06-01T00:01:40.000Z', req: 'req_sticky', model: 'claude-opus-4-8', text: 'still opus',
      usage: { ...U0, input_tokens: 3000, output_tokens: 300, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
  ].join('\n') + '\n')

  // Session B (alpha, plain)
  writeFileSync(join(alphaDir, `${UUID_B}.jsonl`), [
    uLine('2026-06-02T00:00:00.000Z', 'quick question about x'),
    aLine('2026-06-02T00:00:03.000Z', 'claude-sonnet-4-6'),
  ].join('\n') + '\n')

  // Session C (beta, plain, haiku, different repo cwd)
  writeFileSync(join(betaDir, `${UUID_C}.jsonl`), [
    uLine('2026-06-03T00:00:00.000Z', 'beta work'),
    aLine('2026-06-03T00:00:03.000Z', 'claude-haiku-4-5', '/repo2'),
  ].join('\n') + '\n')

  // Traversal bait OUTSIDE any project dir: a valid transcript reachable as id '../evil'
  // iff the SESSION_ID_RE guard is loosened. Never counted (only dirs are projects).
  writeFileSync(join(projectsRoot, 'evil.jsonl'), [
    uLine('2026-06-04T00:00:00.000Z', 'you should never see me'),
    aLine('2026-06-04T00:00:03.000Z'),
  ].join('\n') + '\n')

  // Deterministic mtime ordering: A newest, then B, then C (all "live"-fresh).
  const now = Date.now() / 1000
  utimesSync(join(alphaDir, `${UUID_A}.jsonl`), now, now)
  utimesSync(join(alphaDir, `${UUID_B}.jsonl`), now - 10, now - 10)
  utimesSync(join(betaDir, `${UUID_C}.jsonl`), now - 20, now - 20)

  return { home }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function request(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + path, { method, headers }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => {
        let parsed = buf
        try { parsed = JSON.parse(buf) } catch { /* non-JSON (static/html) — keep raw */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf })
      })
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}
const get = (path, opts) => request('GET', path, opts)
function post(path, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data)
  return request('POST', path, {
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

before(async () => {
  const { home } = buildFixtures()
  const env = {
    ...process.env,
    PORT,
    HOME: home,                       // sandbox the summary disk cache
    WFLENS_PROJECTS_ROOT: projectsRoot,
    WFLENS_SESSION_DIR: sessA,
  }
  delete env.ANTHROPIC_API_KEY        // fail-closed provider probes
  delete env.OPENROUTER_API_KEY
  serverProcess = spawn(process.execPath, [join(__dir, '..', 'server.mjs')], { env, stdio: 'ignore' })
  serverProcess.unref?.()
  // Poll /v1/health until OUR server answers (bridge.sessionDir must match the fixture).
  for (let i = 0; i < 40; i++) {
    try {
      const res = await get('/v1/health')
      if (res.body?.ok === true && res.body?.bridge?.sessionDir === sessA) return
    } catch { /* not up yet */ }
    await sleep(250)
  }
  throw new Error('fixture server did not start in time on port ' + PORT)
})

after(() => {
  try { if (serverProcess) serverProcess.kill('SIGTERM') } finally {
    serverProcess = null
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

// ── sanity: sandboxed spawn is fail-closed and points at the fixture ─────────

test('GET /v1/health — sandboxed spawn: providers fail-closed, bridge points at fixture', async () => {
  const res = await get('/v1/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.providers.anthropic, false, 'ANTHROPIC_API_KEY deleted from child env')
  assert.equal(res.body.providers.openrouter, false, 'OPENROUTER_API_KEY deleted from child env')
  assert.equal(res.body.bridge.sessionDir, sessA)
  assert.equal(res.body.bridge.sessionId, UUID_A)
  assert.equal(res.body.bridge.observeEnabled, true)
})

// ── /v1/home ──────────────────────────────────────────────────────────────────

test('GET /v1/home — projects/recents/live/folderTotals come from the fixture root', async () => {
  const res = await get('/v1/home')
  assert.equal(res.status, 200)
  const slugs = res.body.projects.map((p) => p.slug)
  assert.ok(slugs.includes(ALPHA_SLUG) && slugs.includes(BETA_SLUG), 'both fixture projects listed')
  assert.equal(res.body.activeProjectSlug, ALPHA_SLUG)
  assert.equal(res.body.activeSessionId, UUID_A)
  // recents merged across folders, newest-first by mtime (A, B, C)
  assert.equal(res.body.recents.length, 3)
  assert.equal(res.body.recents[0].id, UUID_A)
  assert.equal(res.body.recents[0].projectSlug, ALPHA_SLUG)
  assert.equal(res.body.recents[0].title, 'build the alpha thing')
  // fixture files were touched seconds ago → they count as live (code compares vs now)
  assert.ok(res.body.live.length >= 1, 'freshly-touched sessions register as live')
  const ft = res.body.folderTotals.find((f) => f.slug === ALPHA_SLUG)
  assert.ok(ft, 'alpha folder rollup present')
  assert.equal(ft.sessions, 2)
  assert.ok(ft.costUsd > 0, 'alpha spend rolled up')
  assert.equal(typeof ft.coverage, 'number')
})

// ── /v1/projects ─────────────────────────────────────────────────────────────

test('GET /v1/projects — enumerates fixture projects with counts + active slug', async () => {
  const res = await get('/v1/projects')
  assert.equal(res.status, 200)
  assert.equal(res.body.projectsRoot, projectsRoot)
  assert.equal(res.body.activeProjectSlug, ALPHA_SLUG)
  const alpha = res.body.projects.find((p) => p.slug === ALPHA_SLUG)
  const beta = res.body.projects.find((p) => p.slug === BETA_SLUG)
  assert.ok(alpha && beta)
  assert.equal(alpha.sessionCount, 2)
  assert.equal(beta.sessionCount, 1)
  assert.equal(alpha.cwd, '/repo')   // recovered from the newest transcript
  assert.equal(beta.cwd, '/repo2')
  assert.equal(res.body.projects[0].slug, ALPHA_SLUG, 'newest-activity-first')
})

// ── /v1/sessions (+ limit clamp) ─────────────────────────────────────────────

test('GET /v1/sessions — lists the active project sessions; limit=1 caps the page', async () => {
  const res = await get('/v1/sessions')
  assert.equal(res.status, 200)
  assert.equal(res.body.totalSessions, 2)
  assert.equal(res.body.sessions.length, 2)
  assert.equal(res.body.activeSessionId, UUID_A)
  assert.equal(res.body.sessions[0].id, UUID_A, 'newest-first')
  const rich = res.body.sessions.find((s) => s.id === UUID_A)
  assert.equal(rich.subagents, 1)
  assert.ok(rich.fallbacks, 'rich session carries the subagent fallback rollup')
  assert.equal(rich.fallbacks.sub.switches, 1)
  assert.equal(rich.fallbacks.sub.refusals, 1)

  const capped = await get('/v1/sessions?limit=1')
  assert.equal(capped.body.sessions.length, 1, 'limit caps summarized sessions')
  assert.equal(capped.body.totalSessions, 2, 'total still reports beyond the cap')
  // out-of-range limits are clamped server-side, never an error
  const huge = await get('/v1/sessions?limit=99999')
  assert.equal(huge.status, 200)
  assert.equal(huge.body.sessions.length, 2)
})

// ── /v1/session/active ───────────────────────────────────────────────────────

test('GET /v1/session/active — identity + summary of the active session', async () => {
  const res = await get('/v1/session/active')
  assert.equal(res.status, 200)
  assert.equal(res.body.sessionId, UUID_A)
  assert.equal(res.body.projectDir, alphaDir)
  assert.ok(res.body.session, 'summary attached')
  assert.equal(res.body.session.title, 'build the alpha thing')
})

// ── /v1/sessions/all (+ limit clamp, projectSlug attached) ───────────────────

test('GET /v1/sessions/all — machine-wide list with projectSlug; limit clamps', async () => {
  const res = await get('/v1/sessions/all')
  assert.equal(res.status, 200)
  assert.equal(res.body.total, 3, 'evil.jsonl at the root is NOT a session')
  assert.equal(res.body.sessions.length, 3)
  for (const s of res.body.sessions) assert.ok(typeof s.projectSlug === 'string', 'projectSlug attached')
  assert.equal(res.body.sessions[0].id, UUID_A, 'newest-first across projects')
  const beta = res.body.sessions.find((s) => s.id === UUID_C)
  assert.equal(beta.projectSlug, BETA_SLUG)

  const capped = await get('/v1/sessions/all?limit=1')
  assert.equal(capped.body.sessions.length, 1)
  assert.equal(capped.body.total, 3)
  const zero = await get('/v1/sessions/all?limit=0') // clamps to >=1, never errors
  assert.equal(zero.status, 200)
  assert.ok(zero.body.sessions.length >= 1)
})

// ── /v1/about ────────────────────────────────────────────────────────────────

test('GET /v1/about — honesty caveats present as non-empty strings', async () => {
  const res = await get('/v1/about')
  assert.equal(res.status, 200)
  for (const k of ['timingCaveat', 'costCaveat', 'liveCaveat', 'replayCaveat', 'groundingCaveat', 'observedCostCaveat', 'observedTimingCaveat', 'beaconCaveat']) {
    assert.ok(typeof res.body[k] === 'string' && res.body[k].length > 0, `${k} present`)
  }
  assert.ok(res.body.costCaveat.includes('not a live billing API'), 'cost caveat keeps the honesty stance')
})

// ── /v1/subagents ────────────────────────────────────────────────────────────

test('GET /v1/subagents — forest from the fixture session; bad id → 404', async () => {
  const res = await get('/v1/subagents')
  assert.equal(res.status, 200)
  assert.equal(res.body.sessionId, UUID_A)
  assert.equal(res.body.root.agentId, '__MAIN_SESSION__')
  assert.equal(res.body.rollup.totalSubagents, 1)
  assert.equal(res.body.root.children[0].agentId, SUB_ID)
  assert.ok(res.body.root.children[0].costUsd > 0)

  const detail = await get(`/v1/subagents/${SUB_ID}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.body.agentId, SUB_ID)

  const missing = await get('/v1/subagents/ffffffff')
  assert.equal(missing.status, 404, 'unknown hex id → 404')
  const traversal = await get('/v1/subagents/..%2F..%2Fetc%2Fpasswd')
  assert.equal(traversal.status, 404, 'non-hex (traversal) id → 404')
})

// ── /v1/observed family ──────────────────────────────────────────────────────

test('GET /v1/observed/scripts — [] when the session has no scripts dir', async () => {
  const res = await get('/v1/observed/scripts')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, [])
})

test('GET /v1/observed/:runId — traversal ids are 404, never file contents', async () => {
  const res = await get('/v1/observed/..%2F..%2Fetc%2Fpasswd')
  assert.equal(res.status, 404)
  assert.equal(res.body?.error?.code, 'NOT_FOUND')
  assert.ok(!res.raw.includes('root:'), 'no /etc/passwd contents leaked')
})

test('GET /v1/observed/:runId/script — bogus run id → 404', async () => {
  const res = await get('/v1/observed/nope123/script')
  assert.equal(res.status, 404)
  assert.equal(res.body?.error?.code, 'NOT_FOUND')
})

// ── POST /v1/observe validation matrix ───────────────────────────────────────
// MUTATION M2: removing the validEvs whitelist in server.mjs turns the
// ev:'bogus-event' case into a 200 → this test goes RED. (Proven; restored.)

test('POST /v1/observe — validation matrix, then the beacon shows in /v1/observed', async () => {
  // non-JSON body → 400
  const bad = await post('/v1/observe', 'this is not json{')
  assert.equal(bad.status, 400, 'non-JSON body rejected')
  assert.equal(bad.body?.error?.code, 'BAD_REQUEST')
  // missing ev → 400
  const noEv = await post('/v1/observe', { runId: 'testrun01' })
  assert.equal(noEv.status, 400, 'ev is required')
  // missing BOTH correlation keys → 400
  const noKeys = await post('/v1/observe', { ev: 'run-start' })
  assert.equal(noKeys.status, 400, 'runId or instrumentationId required')
  // ev outside the whitelist → 400
  const badEv = await post('/v1/observe', { ev: 'bogus-event', runId: 'testrun01' })
  assert.equal(badEv.status, 400, 'ev must be run-start|phase|run-end')
  assert.match(String(badEv.body?.error?.message), /run-start/, 'error names the allowed evs')
  // valid run-start → ok:true
  const ok = await post('/v1/observe', { ev: 'run-start', runId: 'testrun01', instrumentationId: 'inst01', name: 'demo-run' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.runId, 'testrun01')

  // The beacons-only run appears as a synthetic 'running' row (no wf_*.json on disk yet).
  const observed = await get('/v1/observed')
  assert.equal(observed.status, 200)
  const row = observed.body.find((r) => r.runId === 'testrun01')
  assert.ok(row, 'beacons-only run listed')
  assert.equal(row.status, 'running')
  assert.equal(row.name, 'demo-run')
  assert.equal(row.source, 'observed-native')
})

// ── POST /v1/session/select ──────────────────────────────────────────────────
// MUTATION M1: loosening SESSION_ID_RE in src/sessions.mjs to /^.+$/ makes the
// '../evil' case return 200 (the planted <projectsRoot>/evil.jsonl summarizes and
// SESS escapes the project dir) → this test goes RED. (Proven; restored.)

test('POST /v1/session/select — valid uuid switches; traversal ids are rejected', async () => {
  const ok = await post('/v1/session/select', { id: UUID_B })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.sessionId, UUID_B)
  assert.equal(ok.body.sessionDir, join(alphaDir, UUID_B))
  const active = await get('/v1/session/active')
  assert.equal(active.body.sessionId, UUID_B, 'select mutates the active session')

  const traversal = await post('/v1/session/select', { id: '../../etc/passwd' })
  assert.equal(traversal.status, 404, 'path traversal id rejected')
  const bait = await post('/v1/session/select', { id: '../evil' })
  assert.equal(bait.status, 404, 'id escaping the project dir rejected even when the file exists')
  const after1 = await get('/v1/session/active')
  assert.equal(after1.body.sessionId, UUID_B, 'rejected selects do not move SESS')

  // restore for later tests
  const back = await post('/v1/session/select', { id: UUID_A })
  assert.equal(back.status, 200)
})

// ── POST /v1/project/select ──────────────────────────────────────────────────

test('POST /v1/project/select — valid slug switches project+session; unknown slug 404', async () => {
  const ok = await post('/v1/project/select', { slug: BETA_SLUG })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.projectDir, betaDir)
  assert.equal(ok.body.activeSessionId, UUID_C, 'points at the newest session in the new project')
  const sessions = await get('/v1/sessions')
  assert.equal(sessions.body.totalSessions, 1, '/v1/sessions now browses beta')
  assert.equal(sessions.body.sessions[0].id, UUID_C)

  const unknown = await post('/v1/project/select', { slug: 'no-such-project' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body?.error?.code, 'NOT_FOUND')

  // restore: back to alpha, active session back to UUID_A (newest by mtime)
  const back = await post('/v1/project/select', { slug: ALPHA_SLUG })
  assert.equal(back.status, 200)
  assert.equal(back.body.activeSessionId, UUID_A)
})

// ── static files ─────────────────────────────────────────────────────────────

test('static — / serves index.html; /app.js serves js; If-None-Match → 304', async () => {
  const home = await get('/')
  assert.equal(home.status, 200)
  assert.match(String(home.headers['content-type']), /text\/html/)
  assert.match(home.raw.toLowerCase(), /<html|<!doctype/, 'looks like the app shell')

  const js = await get('/app.js')
  assert.equal(js.status, 200)
  assert.match(String(js.headers['content-type']), /application\/javascript/)
  const tag = js.headers.etag
  assert.ok(tag, 'ETag present')
  const cached = await get('/app.js', { headers: { 'If-None-Match': tag } })
  assert.equal(cached.status, 304, 'conditional GET honored')
  assert.equal(cached.raw, '', '304 carries no body')
})

test('static — traversal paths never serve server source', async () => {
  for (const path of ['/..%2f..%2fserver.mjs', '/....//server.mjs']) {
    const res = await get(path)
    assert.notEqual(res.status, 200, `${path} must not be served`)
    assert.ok(!res.raw.includes('http.createServer'), `${path} must not leak server.mjs source`)
  }
})

// ── OPTIONS preflight + Host guard ───────────────────────────────────────────

test('OPTIONS — 204 for loopback Host; 403 when Host is not loopback', async () => {
  const ok = await request('OPTIONS', '/v1/observe')
  assert.equal(ok.status, 204, 'loopback preflight allowed')
  const evil = await request('OPTIONS', '/v1/observe', { headers: { Host: 'evil.com' } })
  assert.equal(evil.status, 403, 'DNS-rebinding Host rejected even for OPTIONS')
  const evilGet = await get('/v1/health', { headers: { Host: 'evil.com' } })
  assert.equal(evilGet.status, 403)
  assert.equal(evilGet.body?.error?.code, 'FORBIDDEN')
})

// ── /v1/aggregate — LAST: the restart case adds a session to the fixture root ─

test('GET /v1/aggregate — drives to done; totals/byDay/byRepo/byTier/fallbacks; restart rescans', { timeout: 30000 }, async () => {
  let agg = await get('/v1/aggregate?restart=1&budgetMs=4000')
  assert.equal(agg.status, 200)
  for (let i = 0; i < 50 && !agg.body.done; i++) { await sleep(100); agg = await get('/v1/aggregate?budgetMs=4000') }
  assert.equal(agg.body.done, true, 'scan completes')
  assert.equal(agg.body.progress.totalSessions, 3)
  assert.equal(agg.body.totals.sessions, 3)
  assert.equal(agg.body.totals.folders, 2)
  assert.ok(agg.body.totals.costUsd > 0)
  assert.ok(agg.body.totals.tokens.out > 0)
  // fallbacks rolled up from the subagent transcript (switch dupe row counted once)
  const fb = agg.body.totals.fallbacks
  assert.equal(fb.refusals, 1, 'one refusal machine-wide')
  assert.equal(fb.switches, 1, 'one switch (streamed dupe not double-counted)')
  assert.equal(fb.sticky, 1)
  assert.equal(fb.subTotal, 2, 'switch+refusal happened inside a subagent')
  assert.equal(fb.mainTotal, 0)
  assert.equal(fb.sessionsAffected, 1)
  assert.equal(fb.categories.cyber, 1, 'refusal category propagated')
  // charts
  assert.ok(agg.body.byDay.length >= 2, 'one bucket per active day')
  assert.ok(agg.body.byDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)))
  const repo = agg.body.byRepo.find((r) => r.repo === 'repo')
  assert.ok(repo, 'byRepo groups on transcript cwd')
  assert.equal(repo.sessions, 2, 'both /repo sessions grouped')
  assert.ok(repo.fallbacks >= 2, 'repo bucket flags its fallbacks')
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    assert.ok(agg.body.byTier.some((t) => t.tier === tier && t.costUsd > 0), `byTier has ${tier}`)
  }
  // a nonsense budgetMs is clamped/defaulted server-side — never an error
  const clamped = await get('/v1/aggregate?budgetMs=99999999')
  assert.equal(clamped.status, 200)
  assert.equal(clamped.body.done, true)

  // WITHOUT restart the finished scan is cached: a new session is not picked up…
  writeFileSync(join(betaDir, `${UUID_D}.jsonl`), [
    uLine('2026-06-05T00:00:00.000Z', 'late arrival'),
    aLine('2026-06-05T00:00:03.000Z', 'claude-haiku-4-5', '/repo2'),
  ].join('\n') + '\n')
  const stale = await get('/v1/aggregate')
  assert.equal(stale.body.done, true)
  assert.equal(stale.body.totals.sessions, 3, 'completed scan is served as-is')
  // …until restart=1 resets the scan state and re-enumerates
  let fresh = await get('/v1/aggregate?restart=1&budgetMs=4000')
  for (let i = 0; i < 50 && !fresh.body.done; i++) { await sleep(100); fresh = await get('/v1/aggregate?budgetMs=4000') }
  assert.equal(fresh.body.done, true)
  assert.equal(fresh.body.totals.sessions, 4, 'restart param rescans and finds the new session')
})
