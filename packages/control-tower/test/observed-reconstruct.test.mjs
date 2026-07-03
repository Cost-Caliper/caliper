// test/observed-reconstruct.test.mjs — hermetic coverage for the observed-run
// reconstruction pipeline (src/observer.mjs parseRunJson/reconstructRun/summaryFromRun)
// and its HTTP surface (GET /v1/observed, GET /v1/observed/:runId happy path,
// GET /v1/observed/scripts + /:runId/script, SSE over the wire with buffered replay).
//
// Until now these paths only had env-gated coverage (real-transcript fixtures are
// excluded for privacy). This file builds a fully SYNTHETIC session dir that mirrors
// the real harness layout the code reads:
//   SESS/workflows/wf_<runId>.json                    — run record (fields pinned from
//                                                       parseRunJson/reconstructRun reads)
//   SESS/workflows/scripts/<name>-wf_<runId>.js       — links workflow name ↔ runId
//   SESS/subagents/workflows/wf_<runId>/journal.jsonl — agent start/result journal
//   SESS/subagents/workflows/wf_<runId>/agent-<id>.jsonl — per-agent transcripts
// Transcript lines copy the REAL wire shapes documented in test/fallbacks.test.mjs
// (entry()/uLine helpers; streamed-dupe rows share a requestId and must count once).
//
// The server tests spawn a REAL `node server.mjs` on a pid-derived port with a fully
// sandboxed env (HOME → mkdtemp, WFLENS_SESSION_DIR → the synthetic dir, API keys
// deleted), same pattern as test/server-routes.test.mjs.
//
// MUTATION LOG (each proven RED against temporarily-broken src, then restored GREEN):
//   M1 src/observer.mjs:634  beacon merge keying `b.runId === runId` → `!==` →
//      "reconstructRun: beacon merge …" fails ("matching runId beacon +
//      instrumentationId beacon; dupe object counted once"). The wire test alone
//      would NOT catch this (its beacon carries both keys and re-attaches via the
//      instrumentationId index) — that is exactly why the unit test pins identity.
//   M2 src/observer.mjs:636-641 instrumentationId lookup keyed to 'bogus' instead of
//      the meta-trace id → "reconstructRun: beacon merge …" AND "beacons posted over
//      the wire …" both fail (id-keyed beacon vanishes; wire count 1≠2).
//   M3 src/observer.mjs:85   scripts-name regex `/^(.+?)-wf_[0-9a-f-]+\.js$/` broken
//      (`-wfX_`) → "parseRunJson: workflowName resolves via the scripts-dir filename
//      regex" fails (name falls back to the whole basename) and the server list test
//      fails (row.name !== 'probe-flow').
//   M4 server.mjs:857 scripts-route regex broken the same way →
//      "GET /v1/observed/scripts + /:runId/script" fails (entry.name/runId become
//      the raw basename / null).

import './_env.mjs' // FIRST: spawning server.mjs transitively loads src/sessions.mjs

import { strict as assert } from 'node:assert'
import { test, before, after } from 'node:test'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseRunJson, reconstructRun, summaryFromRun } from '../src/observer.mjs'

const __dir = dirname(fileURLToPath(import.meta.url))

// offset differs from server-routes.test.mjs so parallel `node --test` shards
// never race for the same port even with adjacent pids.
const PORT = String(21000 + ((process.pid + 7777) % 20000))
const BASE = `http://localhost:${PORT}`

// ── fixture constants ─────────────────────────────────────────────────────────
const RUN1 = 'ab12cd34-9f0'   // rich run: 2 agents w/ transcripts, script, meta trace
const RUN2 = 'beef0002-aa1'   // degraded run: agent entry with NO transcript, no subagents dir
const INSTRUMENTATION_ID = 'inst-42'
const START = Date.parse('2026-06-10T00:00:00.000Z') // wf startTime (epoch ms, as the harness writes)
const SCRIPT_SOURCE = 'export const meta = { name: "probe-flow" }\nconst r = await agent("work")\nreturn r\n'

// ── transcript wire shapes (copied from test/fallbacks.test.mjs / server-routes) ──
const U0 = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
function entry(over) {
  return JSON.stringify({
    type: 'assistant', timestamp: over.ts, requestId: over.req, uuid: over.uuid || over.req,
    ...(over.cwd ? { cwd: over.cwd } : {}), ...(over.gitBranch ? { gitBranch: over.gitBranch } : {}),
    message: {
      model: over.model, stop_reason: over.stop || 'end_turn',
      content: over.content || [{ type: 'text', text: over.text || 'ok' }],
      usage: over.usage,
    },
  })
}
const uLine = (ts, text) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })
const toolResultLine = (ts, toolUseId, text) =>
  JSON.stringify({
    type: 'user', timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] },
  })

// ── expected numbers (hand-computed from shim.PRICE; see assertions) ──────────
// aga1 (haiku, in=$1/M out=$5/M): in=1005, out=105, cache_create=639 (5m ×1.25), cache_read=18321 (×0.10)
//   cost = (1005·1 + 639·1.25 + 18321·0.10 + 105·5)/1e6 = 0.00416085
// agb2 (sonnet, in=$3/M out=$15/M): in=2100, out=250 (streamed dupe row counts ONCE)
//   cost = (2100·3 + 250·15)/1e6 = 0.01005
const COST_A = 0.00416085
const COST_B = 0.01005

let root = null      // mkdtemp holding everything (sandbox home + session dir + projects root)
let sess = null      // the synthetic session dir (WFLENS_SESSION_DIR)
let serverProcess = null

function buildFixtures() {
  root = mkdtempSync(join(tmpdir(), 'ct-observed-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const projectsRoot = join(root, 'projects') // empty — keeps the spawned server hermetic
  mkdirSync(projectsRoot, { recursive: true })
  sess = join(root, 'session')

  // workflows/wf_<RUN1>.json — every field pinned from parseRunJson's reads.
  // workflowName/summary are deliberately OMITTED so name resolution exercises
  // the scripts-dir filename regex (observer.mjs:85).
  mkdirSync(join(sess, 'workflows', 'scripts'), { recursive: true })
  writeFileSync(join(sess, 'workflows', `wf_${RUN1}.json`), JSON.stringify({
    status: 'completed',
    defaultModel: 'claude-sonnet-4-6',
    agentCount: 2,
    totalTokens: 4321,
    totalToolCalls: 3,
    durationMs: 60000,
    startTime: START,
    timestamp: '2026-06-10T00:02:00.000Z',
    scriptPath: '/saved/probe-flow-wf_' + RUN1 + '.js',
    script: SCRIPT_SOURCE,
    result: 'done',
    phases: [{ title: 'phase-1' }],
    logs: [
      'plain harness log line',
      `WFLENS_TRACE {"kind":"meta","ev":"instrumented","instrumentationId":"${INSTRUMENTATION_ID}","name":"probe-flow"}`,
      'TRACE {"kind":"agent","label":"work"}',
      'TRACE this is workflow prose, not JSON — parser must fail closed',
    ],
    workflowProgress: [
      { type: 'workflow_phase', title: 'phase-1' },
      { type: 'workflow_agent', agentId: 'aga1', index: 1, label: 'decide', model: 'claude-haiku-4-5-20251001', phaseTitle: 'phase-1', startedAt: START + 1000, durationMs: 5000 },
      { type: 'workflow_agent', agentId: 'agb2', index: 2, label: 'work', model: 'claude-sonnet-4-6', phaseTitle: 'phase-1', startedAt: START + 2000, durationMs: 8000 },
    ],
  }))
  writeFileSync(join(sess, 'workflows', 'scripts', `probe-flow-wf_${RUN1}.js`), SCRIPT_SOURCE)

  // Degraded run: agent entry with no transcript on disk, no subagents dir, no script.
  writeFileSync(join(sess, 'workflows', `wf_${RUN2}.json`), JSON.stringify({
    workflowName: 'bare-run',
    status: 'running',
    timestamp: '2026-06-01T00:00:00.000Z',
    logs: [],
    workflowProgress: [
      { type: 'workflow_agent', agentId: 'nope1', index: 1, label: 'ghost', model: 'claude-haiku-4-5', durationMs: 1234 },
    ],
  }))

  // Unparseable run record — reconstruction must skip it, never throw.
  writeFileSync(join(sess, 'workflows', 'wf_baddd.json'), '{oops')

  // subagents/workflows/wf_<RUN1>/ — journal + 2 agent transcripts.
  const agentDir = join(sess, 'subagents', 'workflows', `wf_${RUN1}`)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'journal.jsonl'), [
    JSON.stringify({ type: 'started', agentId: 'aga1', at: '2026-06-10T00:00:01.000Z' }),
    JSON.stringify({ type: 'result', agentId: 'aga1', result: 'decision: proceed' }),
    JSON.stringify({ type: 'started', agentId: 'agb2', at: '2026-06-10T00:00:10.000Z' }),
    JSON.stringify({ type: 'result', agentId: 'agb2', result: 'done result' }),
  ].join('\n') + '\n')

  // aga1 (haiku decision agent): prompt → assistant(tool_use) → tool_result → assistant.
  // Assistant timestamps span 00:00:02 → 00:00:06 ⇒ transcript wall-clock ms = 4000
  // (overrides the workflowProgress durationMs of 5000).
  writeFileSync(join(agentDir, 'agent-aga1.jsonl'), [
    uLine('2026-06-10T00:00:01.000Z', 'decide the thing'),
    entry({
      ts: '2026-06-10T00:00:02.000Z', req: 'ra1', model: 'claude-haiku-4-5-20251001',
      cwd: '/repo/probe', gitBranch: 'main',
      content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
      usage: { ...U0, input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 639, cache_read_input_tokens: 18321 },
    }),
    toolResultLine('2026-06-10T00:00:04.000Z', 'tu1', 'file1\nfile2'),
    entry({
      ts: '2026-06-10T00:00:06.000Z', req: 'ra2', model: 'claude-haiku-4-5-20251001',
      text: 'decision: proceed',
      usage: { ...U0, input_tokens: 1000, output_tokens: 100 },
    }),
  ].join('\n') + '\n')

  // agb2 (sonnet work agent): includes a streamed DUPE row (same requestId rb1) whose
  // usage must count once — the real signature documented in test/fallbacks.test.mjs.
  writeFileSync(join(agentDir, 'agent-agb2.jsonl'), [
    uLine('2026-06-10T00:00:10.000Z', 'do the work'),
    entry({
      ts: '2026-06-10T00:00:12.000Z', req: 'rb1', model: 'claude-sonnet-4-6', text: 'working',
      usage: { ...U0, input_tokens: 2000, output_tokens: 200 },
    }),
    entry({
      ts: '2026-06-10T00:00:12.500Z', req: 'rb1', model: 'claude-sonnet-4-6', text: 'streamed dupe',
      usage: { ...U0, input_tokens: 2000, output_tokens: 200 },
    }),
    entry({
      ts: '2026-06-10T00:00:20.000Z', req: 'rb2', model: 'claude-sonnet-4-6', text: 'done result',
      usage: { ...U0, input_tokens: 100, output_tokens: 50 },
    }),
  ].join('\n') + '\n')

  return { home, projectsRoot }
}

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
const get = (path, opts) => request('GET', path, opts)
function post(path, data) {
  const body = JSON.stringify(data)
  return request('POST', path, {
    body,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Timeout-bounded SSE reader: opens GET <path>, resolves `ready` with the live
// response (headers available), accumulates the body, and lets tests await a
// predicate over the accumulated buffer WITHOUT ever hanging (every wait times out).
function sseClient(path) {
  let buf = ''
  const waiters = []
  const client = { req: null, get buf() { return buf } }
  client.ready = new Promise((resolve, reject) => {
    client.req = http.get(BASE + path, (res) => {
      res.setEncoding('utf8')
      res.on('data', (d) => {
        buf += d
        for (const w of [...waiters]) {
          if (w.pred(buf)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(buf) }
        }
      })
      resolve(res)
    })
    client.req.on('error', reject)
  })
  client.waitFor = (pred, label, timeoutMs = 5000) => new Promise((resolve, reject) => {
    if (pred(buf)) return resolve(buf)
    const w = {
      pred,
      resolve: (b) => { clearTimeout(timer); resolve(b) },
    }
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) waiters.splice(i, 1)
      reject(new Error(`SSE timeout waiting for ${label}; buffer tail: ${JSON.stringify(buf.slice(-400))}`))
    }, timeoutMs)
    waiters.push(w)
  })
  client.close = () => { try { client.req.destroy() } catch { /* already gone */ } }
  return client
}

before(async () => {
  const { home, projectsRoot } = buildFixtures()
  const env = {
    ...process.env,
    PORT,
    HOME: home,                       // sandbox the sessions.mjs summary disk cache
    USERPROFILE: home,
    WFLENS_PROJECTS_ROOT: projectsRoot,
    WFLENS_SESSION_DIR: sess,
  }
  delete env.ANTHROPIC_API_KEY        // fail-closed: zero network, zero keys
  delete env.OPENROUTER_API_KEY
  serverProcess = spawn(process.execPath, [join(__dir, '..', 'server.mjs')], { env, stdio: 'ignore' })
  serverProcess.unref?.()
  for (let i = 0; i < 40; i++) {
    try {
      const res = await get('/v1/health')
      if (res.body?.ok === true && res.body?.bridge?.sessionDir === sess) return
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

// ═══ (a) parseRunJson on the synthetic wf record ══════════════════════════════

test('parseRunJson: synthetic wf record → every promised structure field', () => {
  const run = parseRunJson(RUN1, sess)
  assert.ok(run, 'parseRunJson returns a result for the synthetic record')
  assert.equal(run.runId, RUN1)
  assert.equal(run.status, 'completed')
  assert.equal(run.defaultModel, 'claude-sonnet-4-6')
  assert.equal(run.agentCount, 2)
  assert.equal(run.totalTokens, 4321)
  assert.equal(run.totalToolCalls, 3)
  assert.equal(run.durationMs, 60000)
  assert.equal(run.startTime, START)
  assert.equal(run.timestamp, '2026-06-10T00:02:00.000Z')
  assert.equal(run.scriptPath, '/saved/probe-flow-wf_' + RUN1 + '.js')
  assert.equal(run.result, 'done')
  assert.deepEqual(run.phases, [{ title: 'phase-1' }])
  assert.equal(run.workflowProgress.length, 3)
  assert.equal(run.logs.length, 4, 'raw logs passed through untouched')
  // trace parsing: WFLENS_TRACE + TRACE JSON lines parse; TRACE prose fails closed
  assert.equal(run.traceRecords.length, 2, 'exactly the two parseable trace lines')
  assert.deepEqual(run.traceRecords[0], { kind: 'meta', ev: 'instrumented', instrumentationId: INSTRUMENTATION_ID, name: 'probe-flow' })
  assert.deepEqual(run.traceRecords[1], { kind: 'agent', label: 'work' })
  // absent/degenerate inputs fail closed, never throw
  assert.equal(parseRunJson('../../x', sess), null, 'traversal runId rejected')
  assert.equal(parseRunJson('feed99', sess), null, 'missing run file → null')
  assert.equal(parseRunJson('baddd', sess), null, 'unparseable run JSON → null')
})

// MUTATION M3 (proven): broke the scripts-name regex at src/observer.mjs:85
// (`-wf_` → `-wfX_`) → workflowName fell back to the whole basename
// 'probe-flow-wf_ab12cd34-9f0' → RED ("name extracted by the scripts-dir regex").
// Restored → GREEN.
test('parseRunJson: workflowName resolves via the scripts-dir filename regex', () => {
  const run = parseRunJson(RUN1, sess)
  assert.equal(run.workflowName, 'probe-flow', 'name extracted by the scripts-dir regex (record has no workflowName)')
  // explicit workflowName wins without consulting the scripts dir
  assert.equal(parseRunJson(RUN2, sess).workflowName, 'bare-run')
})

// ═══ (b) reconstructRun merges run json + transcripts + beacons ═══════════════

test('reconstructRun: merges run json + subagent transcripts into per-agent calls with cache-aware cost', () => {
  const run = reconstructRun(RUN1, sess)
  assert.ok(run, 'reconstructRun returns a result')
  assert.equal(run.source, 'observed-native')
  assert.equal(run.status, 'completed')
  assert.equal(run.meta.name, 'probe-flow')
  assert.equal(run.meta.defaultModel, 'claude-sonnet-4-6')
  assert.equal(run.telemetry.calls.length, 2, '2 agent calls from workflowProgress')

  const [a, b] = run.telemetry.calls
  // aga1 — haiku decision agent
  assert.equal(a.id, 1)
  assert.equal(a.label, 'decide')
  assert.equal(a.agentId, 'aga1')
  assert.equal(a.tier, 'haiku')
  assert.equal(a.model, 'claude-haiku-4-5-20251001', 'model comes from the transcript')
  assert.equal(a.inTok, 1005)
  assert.equal(a.outTok, 105)
  assert.equal(a.cacheCreationTok, 639)
  assert.equal(a.cacheReadTok, 18321)
  assert.ok(Math.abs(a.costUsd - COST_A) < 1e-7, `haiku cache-aware cost ~${COST_A}, got ${a.costUsd}`)
  assert.equal(a.ms, 4000, 'wall-clock from transcript assistant timestamps beats durationMs')
  assert.equal(a.startMs, 1000, 'startedAt − run startTime')
  assert.equal(a.endMs, 5000)
  assert.equal(a.task, 'decide the thing')
  assert.equal(a.output, 'decision: proceed')
  assert.equal(a.toolCalls, 1)
  assert.deepEqual(a.tools, ['Bash'])
  assert.equal(a.turns, 2)
  // segment timeline: prompt→assistant (inference), →tool_result (tool), →assistant (inference)
  assert.equal(a.segments.length, 3)
  assert.deepEqual(a.segments.map((s) => s.kind), ['inference', 'tool', 'inference'])
  assert.deepEqual(a.segments[1].tools, ['Bash'])
  assert.equal(a.segments[1].detail.calls[0].name, 'Bash')
  assert.equal(a.inferenceMs, 3000)
  assert.equal(a.toolMs, 2000)

  // agb2 — sonnet work agent; the streamed dupe row (same requestId) counts ONCE
  assert.equal(b.agentId, 'agb2')
  assert.equal(b.tier, 'sonnet')
  assert.equal(b.inTok, 2100, 'streamed dupe row not double-counted')
  assert.equal(b.outTok, 250)
  assert.ok(Math.abs(b.costUsd - COST_B) < 1e-7, `sonnet cost ~${COST_B}, got ${b.costUsd}`)
  assert.equal(b.ms, 8000)
  assert.equal(b.startMs, 2000)
  assert.equal(b.endMs, 10000)

  // cwd/gitBranch recovered from the transcripts
  assert.equal(run.cwd, '/repo/probe')
  assert.equal(run.gitBranch, 'main')
})

test('reconstructRun: run rollup + perPhase aggregation', () => {
  const run = reconstructRun(RUN1, sess)
  const r = run.telemetry.run
  assert.equal(r.calls, 2)
  assert.equal(r.inTok, 3105)
  assert.equal(r.outTok, 355)
  assert.ok(Math.abs(r.costUsd - (COST_A + COST_B)) < 1e-5, `run cost ~${COST_A + COST_B}, got ${r.costUsd}`)
  assert.equal(r.sumMs, 12000)
  assert.equal(r.wallMs, 9000, 'maxEnd(10000) − minStart(1000)')
  assert.equal(r.concurrencySavingMs, 3000)
  assert.equal(r.speedup, 1.33, '12000/9000 to 2dp')

  assert.equal(run.telemetry.perPhase.length, 1, 'both agents share phase-1')
  const p = run.telemetry.perPhase[0]
  assert.equal(p.phase, 'phase-1')
  assert.equal(p.calls, 2)
  assert.equal(p.inTok, 3105)
  assert.equal(p.outTok, 355)
  assert.equal(p.sumMs, 12000)
  assert.equal(p.wallMs, 9000)
})

test('reconstructRun: no beacons → still reconstructs; instrumentationId read from the meta trace', () => {
  const run = reconstructRun(RUN1, sess) // no beacon args at all
  assert.ok(run, 'reconstruction does not require beacons')
  assert.deepEqual(run.beacons, [], 'beacons default to []')
  assert.equal(run.meta.instrumentationId, INSTRUMENTATION_ID, 'meta trace line surfaces the id')
  assert.equal(run.telemetry.calls.length, 2, 'agents still present')
})

// MUTATION M1 (proven): inverted the runId keying at src/observer.mjs:634
// (`b.runId === runId` → `!==`) → the matching beacon was dropped and the 'ffff'
// beacon attached instead → RED ("matching runId beacon + instrumentationId
// beacon; dupe object counted once"). Restored → GREEN.
// MUTATION M2 (proven): keyed the instrumentationId lookup at src/observer.mjs:637
// to 'bogus' instead of the meta-trace id → the instrumentationId-keyed beacon
// vanished → RED ("instrumentationId-keyed beacon merged after the runId ones").
// Restored → GREEN.
test('reconstructRun: beacon merge — runId-keyed + instrumentationId-keyed, identity-deduped, non-matching excluded', () => {
  const bRun = { runId: RUN1, ev: 'run-start', ts: 1 }
  const bOther = { runId: 'ffff', ev: 'run-start', ts: 2 }
  const bInst = { instrumentationId: INSTRUMENTATION_ID, ev: 'phase', phase: 'build', ts: 3 }
  const byId = new Map([[INSTRUMENTATION_ID, [bInst, bRun]]]) // bRun present in BOTH indexes
  const run = reconstructRun(RUN1, sess, [bRun, bOther], byId)
  assert.equal(run.beacons.length, 2, 'matching runId beacon + instrumentationId beacon; dupe object counted once')
  assert.equal(run.beacons[0], bRun, 'matching runId beacon attaches first')
  assert.equal(run.beacons[1], bInst, 'instrumentationId-keyed beacon merged after the runId ones')
  assert.ok(!run.beacons.includes(bOther), 'a beacon for another run never attaches')

  // plain-object index (the documented alternative to Map) also works
  const objRun = reconstructRun(RUN1, sess, [], { [INSTRUMENTATION_ID]: [bInst] })
  assert.deepEqual(objRun.beacons, [bInst], 'plain-object beaconsByInstrumentationId honored')

  // a run WITHOUT a meta trace ignores instrumentationId-keyed beacons entirely
  const bare = reconstructRun(RUN2, sess, [], byId)
  assert.equal(bare.meta.instrumentationId, null)
  assert.deepEqual(bare.beacons, [], 'no meta trace → id-keyed beacons cannot attach')
})

test('reconstructRun: degraded run — agent entry with no transcript, no subagents dir', () => {
  const run = reconstructRun(RUN2, sess)
  assert.ok(run, 'reconstructs without any transcript artifacts')
  assert.equal(run.status, 'running')
  assert.equal(run.meta.name, 'bare-run')
  assert.equal(run.telemetry.calls.length, 1)
  const c = run.telemetry.calls[0]
  assert.equal(c.agentId, 'nope1')
  assert.equal(c.model, 'claude-haiku-4-5', 'falls back to the workflowProgress model')
  assert.equal(c.inTok, 0)
  assert.equal(c.outTok, 0)
  assert.equal(c.costUsd, 0)
  assert.equal(c.ms, 1234, 'falls back to workflowProgress durationMs')
  assert.equal(c.task, null)
  assert.equal(c.output, null)
  assert.deepEqual(c.segments, [])
  assert.equal(run.cwd, null)
  assert.equal(run.agentCount, 1, 'agentCount falls back to the progress-entry count')
})

test('summaryFromRun: list-row fields for both runs', () => {
  const s1 = summaryFromRun(reconstructRun(RUN1, sess))
  assert.equal(s1.runId, RUN1)
  assert.equal(s1.name, 'probe-flow')
  assert.equal(s1.status, 'completed')
  assert.equal(s1.source, 'observed-native')
  assert.equal(s1.agentCount, 2)
  assert.equal(s1.totalTokens, 4321)
  assert.ok(Math.abs(s1.costUsd - (COST_A + COST_B)) < 1e-5)
  assert.equal(s1.durationMs, 60000)
  assert.equal(s1.startedAt, '2026-06-10T00:00:00.000Z', 'epoch-ms startTime rendered as ISO')
  assert.equal(s1.timestamp, '2026-06-10T00:02:00.000Z')
  assert.equal(s1.cwd, '/repo/probe')
  assert.equal(s1.gitBranch, 'main')
  assert.equal(s1.scriptPath, '/saved/probe-flow-wf_' + RUN1 + '.js')

  const s2 = summaryFromRun(reconstructRun(RUN2, sess))
  assert.equal(s2.name, 'bare-run')
  assert.equal(s2.costUsd, 0)
  assert.equal(s2.startedAt, null, 'no startTime → null, not Invalid Date')
  assert.equal(summaryFromRun(null), null)
})

// ═══ (c) spawned server: /v1/observed family happy paths ══════════════════════

test('GET /v1/observed — lists both synthetic runs, newest-first, with reconstructed summaries', async () => {
  const res = await get('/v1/observed')
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.body))
  const ids = res.body.map((r) => r.runId)
  assert.deepEqual(ids, [RUN1, RUN2], 'newest-first by timestamp; unparseable wf_baddd skipped')
  const row = res.body[0]
  assert.equal(row.name, 'probe-flow', 'name resolved via the scripts-dir regex over the wire')
  assert.equal(row.status, 'completed')
  assert.equal(row.source, 'observed-native')
  assert.equal(row.agentCount, 2)
  assert.ok(row.costUsd > 0, 'reconstructed cost surfaces in the list')
})

test('GET /v1/observed/:runId — happy path returns the full reconstruction', async () => {
  const res = await get(`/v1/observed/${RUN1}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.runId, RUN1)
  assert.equal(res.body.source, 'observed-native')
  assert.equal(res.body.meta.name, 'probe-flow')
  assert.equal(res.body.meta.instrumentationId, INSTRUMENTATION_ID)
  assert.equal(res.body.telemetry.calls.length, 2, 'agents present over the wire')
  const models = res.body.telemetry.calls.map((c) => c.tier).sort()
  assert.deepEqual(models, ['haiku', 'sonnet'])
  assert.ok(res.body.telemetry.run.costUsd > 0)
  assert.deepEqual(res.body.beacons, [], 'no beacons posted yet')
  assert.equal(res.body.traceRecords.length, 2)
})

// MUTATION M4 (proven): broke the scripts-route regex in server.mjs
// (GET /v1/observed/scripts, `-wf_` → `-wfX_`) → entry.name became the raw
// basename and entry.runId null → RED ("scripts entry parsed"). Restored → GREEN.
test('GET /v1/observed/scripts + /:runId/script — serve the synthetic scripts entry', async () => {
  const list = await get('/v1/observed/scripts')
  assert.equal(list.status, 200)
  assert.equal(list.body.length, 1)
  const entry0 = list.body[0]
  assert.equal(entry0.file, `probe-flow-wf_${RUN1}.js`)
  assert.equal(entry0.name, 'probe-flow', 'scripts entry parsed by the <name>-wf_<id>.js regex')
  assert.equal(entry0.runId, RUN1)
  assert.equal(entry0.path, join(sess, 'workflows', 'scripts', `probe-flow-wf_${RUN1}.js`))

  const script = await get(`/v1/observed/${RUN1}/script`)
  assert.equal(script.status, 200)
  assert.equal(script.body.source, SCRIPT_SOURCE, 'exact executed source served back')
  assert.equal(script.body.path, '/saved/probe-flow-wf_' + RUN1 + '.js')

  const missing = await get(`/v1/observed/${RUN2}/script`)
  assert.equal(missing.status, 200, 'run record exists → script route answers')
  assert.equal(missing.body.source, null, 'no embedded script → source null, not an error')
})

// ═══ (d) SSE over the wire ════════════════════════════════════════════════════

test('GET /v1/observed/stream — responds with SSE headers on a real socket', async () => {
  const client = sseClient('/v1/observed/stream')
  try {
    const res = await client.ready
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /^text\/event-stream/)
    assert.equal(res.headers['cache-control'], 'no-cache')
    assert.equal(res.headers['x-accel-buffering'], 'no')
  } finally { client.close() }
})

test('SSE — live listener receives a posted beacon; a NEW connection replays it from the buffer', async () => {
  const marker = 'sse-probe-live'
  const live = sseClient('/v1/observed/stream')
  try {
    await live.ready
    // POST a beacon while the stream is open (runId deliberately NOT RUN1 so the
    // beacon-attachment test below stays independent of this event)
    const ok = await post('/v1/observe', { ev: 'run-start', runId: 'facade01', name: marker })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.ok, true)
    const buf = await live.waitFor((b) => b.includes(marker), 'live beacon event')
    assert.ok(buf.includes('event: beacon'), 'wire frame carries the beacon event type')
    assert.ok(buf.includes(`"name":"${marker}"`), 'payload is the posted beacon JSON')
  } finally { live.close() }

  // buffered replay: a brand-new connection gets the already-emitted event
  const late = sseClient('/v1/observed/stream')
  try {
    await late.ready
    const replay = await late.waitFor((b) => b.includes(marker), 'buffered replay of the beacon')
    assert.ok(replay.includes('event: beacon'), 'replayed frame keeps the event type')
  } finally { late.close() }
})

test('beacons posted over the wire attach to GET /v1/observed/:runId (runId + instrumentationId keyed, deduped)', async () => {
  // this beacon carries BOTH correlation keys → lands in both server indexes;
  // reconstruction must attach it ONCE (identity dedup)
  const both = await post('/v1/observe', { ev: 'run-start', runId: RUN1, instrumentationId: INSTRUMENTATION_ID, name: 'probe-flow' })
  assert.equal(both.status, 200)
  // this one has NO runId — it can only reach the run via the meta-trace instrumentationId
  const instOnly = await post('/v1/observe', { ev: 'phase', instrumentationId: INSTRUMENTATION_ID, phase: 'build' })
  assert.equal(instOnly.status, 200)

  const res = await get(`/v1/observed/${RUN1}`)
  assert.equal(res.status, 200)
  assert.equal(res.body.beacons.length, 2, 'run-start once (deduped across indexes) + instrumentationId-only phase beacon')
  const evs = res.body.beacons.map((b) => b.ev).sort()
  assert.deepEqual(evs, ['phase', 'run-start'])
  const phaseBeacon = res.body.beacons.find((b) => b.ev === 'phase')
  assert.equal(phaseBeacon.phase, 'build')
  assert.ok(!('runId' in phaseBeacon) || !phaseBeacon.runId, 'phase beacon correlated by instrumentationId alone')
})
