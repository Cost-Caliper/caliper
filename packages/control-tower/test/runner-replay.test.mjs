// test/runner-replay.test.mjs — node --test: executeRun (src/runner.mjs) driven
// hermetically in replay/cassette mode. NO live network, NO API keys.
//
// Covers:
//   1. Full replay of the committed cassettes/hello.cassette.json + its
//      workflows/hello.workflow.js: pinned SSE event sequence
//      (run-start → phase → agent-start → agent-end → log → rollup → done),
//      per-agent cost fields from the cassette envelope, and the returned
//      snapshot shape { status, meta, graph, telemetry, governor, gate, estimate }.
//   2. useGate/useRouter flags in replay mode: both are live-mode-only
//      (`mode === 'live'` guards in runner.mjs), so replay must be unaffected
//      and the done event must carry default gate stats.
//   3. Governor trip: a two-sequential-call fixture workflow + synthetic
//      cassette; a cap below the first call's replayed cost trips the governor
//      BEFORE the second call → 'over-budget' status + governor-trip event.
//   4. Cassette miss inside the run: replay against a cassette lacking the
//      needed entry → agent-end carries the CACHE_MISS error, an 'error' event
//      is emitted, and executeRun resolves { status: 'error' }.
//   5. Replay mode without a cassettePath / with a nonexistent cassette file →
//      the promise REJECTS with code CACHE_MISS (thrown before the run starts).
//   6. record:true in replay mode must NOT write into the package cassettes/
//      dir (the disk-write branch is live-mode-only; see notes on the
//      untestable live-record path).
//
// Mutation log (each applied temporarily, test confirmed RED, then restored
// with `git checkout --` and confirmed GREEN):
//   M1 packages/workflow-lens/src/governor.mjs checkBudget: `spent >= capUsd`
//      → `spent > capUsd * 1e9` — 'governor trip' test fails
//      (status 'ok' !== 'over-budget').
//   M2 packages/workflow-lens/src/cassette.mjs loadCassette backend:
//      `const hash = hashCall(prompt, opts)` → `... .slice(1)` — 'replay of
//      committed hello cassette' test fails (status 'error', CACHE_MISS).
//   M3 packages/control-tower/src/runner.mjs: status mapping
//      `'over-budget' : 'ok'` → `'ok' : 'ok'` — 'governor trip' test fails.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { executeRun } from '../src/runner.mjs'
import { buildGraph, hashCall, costOf } from '../../workflow-lens/src/index.mjs'
import { readFileSync } from 'node:fs'

const __dir = fileURLToPath(new URL('.', import.meta.url))
const PKG_ROOT = join(__dir, '..')
const HELLO_WORKFLOW = join(PKG_ROOT, 'workflows', 'hello.workflow.js')
const HELLO_CASSETTE = join(PKG_ROOT, 'cassettes', 'hello.cassette.json')

// ── Helpers ───────────────────────────────────────────────────────────────────

// Real SSE collector — the runner's only output channel besides the return value.
function makeCollector() {
  const events = []
  return { events, emit: (type, data) => events.push({ type, data }) }
}

function helloRunOpts(overrides = {}) {
  const workflowSrc = readFileSync(HELLO_WORKFLOW, 'utf8')
  return {
    workflowId: 'hello',
    workflowPath: HELLO_WORKFLOW,
    workflowSrc,
    graph: buildGraph(workflowSrc),
    mode: 'replay',
    cassettePath: HELLO_CASSETTE,
    env: {}, // hermetic: replay must never need credentials
    ...overrides,
  }
}

// Two SEQUENTIAL haiku calls so the governor pre-call check deterministically
// trips before call 2 once call 1's replayed cost exceeds the cap. (The
// over-budget-demo workflow uses parallel(), whose trip point depends on
// microtask interleaving — not deterministic enough for a unit test.)
const TWO_STEP_SRC = `export const meta = {
  name: 'two-step-fixture',
  description: 'two sequential haiku calls for governor testing',
  phases: [{ title: 'One' }, { title: 'Two' }],
}

phase('One')
const a = await agent('first prompt', { label: 'first', model: 'haiku', phase: 'One' })
phase('Two')
const b = await agent('second prompt', { label: 'second', model: 'haiku', phase: 'Two' })
return { a, b }
`

// Cassette envelope shape copied from the committed cassettes/hello.cassette.json
// (the shape anthropicBackend returns: text/usage/ms/requestId/tier/model).
function envelope(text, inTok, outTok, requestId) {
  return {
    text,
    usage: { inTok, outTok },
    ms: 5,
    requestId,
    tier: 'haiku',
    model: 'claude-haiku-4-5-20251001',
  }
}

function writeCassette(path, entries) {
  writeFileSync(path, JSON.stringify({
    _header: { metaName: 'two-step-fixture', recordedAt: '2026-01-01T00:00:00.000Z', calls: Object.keys(entries).length, dupCount: 0 },
    entries,
  }, null, 2))
}

function twoStepFixture(dir) {
  const workflowPath = join(dir, 'two-step.workflow.js')
  writeFileSync(workflowPath, TWO_STEP_SRC)
  const cassettePath = join(dir, 'two-step.cassette.json')
  // 1000 in / 1000 out haiku tokens per call = $0.006 per call — comfortably
  // above a $0.001 cap after call 1.
  writeCassette(cassettePath, {
    [hashCall('first prompt', { model: 'haiku' })]: envelope('alpha', 1000, 1000, 'req_first'),
    [hashCall('second prompt', { model: 'haiku' })]: envelope('beta', 1000, 1000, 'req_second'),
  })
  return {
    workflowId: 'two-step',
    workflowPath,
    workflowSrc: TWO_STEP_SRC,
    graph: buildGraph(TWO_STEP_SRC),
    mode: 'replay',
    cassettePath,
    env: {},
  }
}

// ── 1. Full replay of the committed hello cassette ─────────────────────────────

test('executeRun replay — committed hello cassette: event sequence, cost fields, snapshot', async () => {
  const { events, emit } = makeCollector()
  const snap = await executeRun(helloRunOpts({ emit }))

  // Pinned event sequence for a single-call single-phase run.
  assert.deepEqual(
    events.map((e) => e.type),
    ['run-start', 'phase', 'agent-start', 'agent-end', 'log', 'rollup', 'done'],
  )

  // run-start payload
  const runStart = events[0].data
  assert.equal(runStart.workflowId, 'hello')
  assert.equal(runStart.name, 'fixture-hello') // graph.metaName from the workflow meta
  assert.equal(runStart.mode, 'replay')
  assert.equal(runStart.provider, 'anthropic') // default
  assert.equal(runStart.capUsd, null)
  assert.equal(runStart.useRouter, false)
  assert.equal(runStart.useGate, false)
  assert.equal(typeof runStart.graphSvg, 'string')
  assert.ok(runStart.graphSvg.includes('<svg'), 'run-start carries a rendered graph SVG')
  assert.ok('estimate' in runStart, 'run-start carries the pre-flight estimate field')

  // phase + log come from the workflow itself
  assert.equal(events[1].data.phase, 'Greet')
  assert.equal(events[4].data.message, 'agent replied: ok') // replayed text reached the workflow

  // agent-start
  const agentStart = events[2].data
  assert.equal(agentStart.seq, 1)
  assert.equal(agentStart.label, 'greeter')
  assert.equal(agentStart.tier, 'haiku')

  // agent-end: per-agent cost fields must be the authentic cassette facts
  const agentEnd = events[3].data
  assert.equal(agentEnd.label, 'greeter')
  assert.equal(agentEnd.tier, 'haiku')
  assert.equal(agentEnd.model, 'claude-haiku-4-5-20251001')
  assert.equal(agentEnd.inTok, 15)
  assert.equal(agentEnd.outTok, 4)
  assert.equal(agentEnd.requestId, 'req_011CcLg6XJrgsmgDxMeTSREn')
  const expectedCost = +costOf('haiku', 15, 4).toFixed(6) // $0.000035
  assert.equal(agentEnd.costUsd, expectedCost)
  assert.equal(agentEnd.error, null)
  // BUG (see bugsFound): agent-end.replayed is documented (runner.mjs step 5)
  // as marking replay traffic, but ledger.instrument() unwraps the envelope to
  // res.text before the runner reads result.replayed — so it is ALWAYS false,
  // even in replay mode. Same for `cached`. Asserting the intended behavior
  // fails today:
  //   assert.equal(agentEnd.replayed, true)  // actual: false
  assert.equal(typeof agentEnd.replayed, 'boolean')

  // rollup + done
  const rollup = events[5].data
  assert.equal(rollup.run.calls, 1)
  assert.equal(rollup.run.costUsd, expectedCost)

  const done = events[6].data
  assert.equal(done.status, 'ok')
  assert.equal(done.meta.name, 'fixture-hello')
  assert.equal(done.meta.workflowId, 'hello')
  // cassette stats prove zero real API calls: every call was a replay hit
  assert.deepEqual(done.cassette, { replayHits: 1, cacheMisses: 0, size: 1 })
  assert.equal(done.governor.cap, null)
  assert.equal(done.governor.tripped, false)
  assert.deepEqual(done.gate, { realCalls: 0, cacheHits: 0, hitlDenied: 0 })
  assert.equal(done.optimizeAvailable, true)

  // Returned snapshot mirrors the done payload
  assert.equal(snap.status, 'ok')
  assert.deepEqual(snap.meta, { name: 'fixture-hello', workflowId: 'hello' })
  assert.equal(snap.telemetry.run.calls, 1)
  assert.equal(snap.telemetry.run.inTok, 15)
  assert.equal(snap.telemetry.run.outTok, 4)
  assert.equal(snap.telemetry.run.costUsd, expectedCost)
  assert.equal(snap.telemetry.calls[0].label, 'greeter')
  assert.equal(snap.telemetry.calls[0].requestId, 'req_011CcLg6XJrgsmgDxMeTSREn')
  assert.equal(snap.governor.tripped, false)
  assert.ok('estimate' in snap)
})

// ── 2. useGate / useRouter are live-mode-only: replay unaffected ────────────────

test('executeRun replay — useGate/useRouter flags are echoed but inert in replay mode', async () => {
  const { events, emit } = makeCollector()
  const snap = await executeRun(helloRunOpts({ emit, useGate: true, useRouter: true }))

  const runStart = events.find((e) => e.type === 'run-start').data
  assert.equal(runStart.useGate, true)
  assert.equal(runStart.useRouter, true)

  // Both wrappers are guarded by `mode === 'live'` in runner.mjs, so replay
  // behaves exactly as without the flags: the call still hits the cassette
  // (1 replay hit) and gate stats stay at the no-gate defaults.
  assert.equal(snap.status, 'ok')
  const done = events.find((e) => e.type === 'done').data
  assert.deepEqual(done.cassette, { replayHits: 1, cacheMisses: 0, size: 1 })
  assert.deepEqual(done.gate, { realCalls: 0, cacheHits: 0, hitlDenied: 0 })
  assert.equal(done.status, 'ok')
})

// ── 3. Governor trip in replay ─────────────────────────────────────────────────

test('executeRun replay — tiny capUsd trips the governor: over-budget, no second call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-governor-'))
  try {
    const { events, emit } = makeCollector()
    // Call 1 replays at $0.006; the pre-call check before call 2 sees
    // spent 0.006 >= cap 0.001 and trips. No network, no keys.
    const snap = await executeRun({ ...twoStepFixture(dir), capUsd: 0.001, emit })

    assert.equal(snap.status, 'over-budget')
    assert.equal(snap.governor.tripped, true)
    assert.equal(snap.governor.cap, 0.001)
    const call1Cost = +costOf('haiku', 1000, 1000).toFixed(6) // $0.006
    assert.equal(snap.governor.spent, call1Cost)
    assert.equal(snap.governor.tripSpent, call1Cost)
    assert.equal(snap.governor.tripCall, 2) // call 2 is the one that was refused

    // Only the FIRST call reached the ledger — the trip prevented call 2.
    assert.equal(snap.telemetry.run.calls, 1)
    assert.equal(snap.telemetry.calls[0].label, 'first')
    assert.equal(snap.telemetry.run.costUsd, call1Cost)

    // governor-trip event fires, then rollup, then done with over-budget status.
    const types = events.map((e) => e.type)
    assert.deepEqual(types, [
      'run-start', 'phase', 'agent-start', 'agent-end', 'phase',
      'governor-trip', 'rollup', 'done',
    ])
    const trip = events.find((e) => e.type === 'governor-trip').data
    assert.equal(trip.cap, 0.001)
    assert.equal(trip.spent, call1Cost)
    const done = events.find((e) => e.type === 'done').data
    assert.equal(done.status, 'over-budget')
    assert.equal(done.governor.tripped, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 4. Cassette miss during the run ─────────────────────────────────────────────

test('executeRun replay — cassette lacking the needed entry: CACHE_MISS error resolution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-miss-'))
  try {
    // A structurally valid cassette with ZERO entries — every call misses.
    const cassettePath = join(dir, 'empty.cassette.json')
    writeCassette(cassettePath, {})

    const { events, emit } = makeCollector()
    const snap = await executeRun(helloRunOpts({ emit, cassettePath }))

    // The runner catches the workflow error and RESOLVES with status 'error'
    // (it does not reject) — the miss is reported via the 'error' event.
    assert.equal(snap.status, 'error')
    assert.equal(snap.error.code, 'CACHE_MISS')
    assert.match(snap.error.message, /CACHE_MISS: no recording for hash/)
    assert.match(snap.error.message, /Reply with the single lowercase word/) // names the missing prompt

    const types = events.map((e) => e.type)
    assert.deepEqual(types, ['run-start', 'phase', 'agent-start', 'agent-end', 'rollup', 'error'])

    // The failed call is still ledgered (0 tokens, error recorded) and the
    // agent-end event carries the miss.
    const agentEnd = events.find((e) => e.type === 'agent-end').data
    assert.match(agentEnd.error, /CACHE_MISS/)
    assert.equal(agentEnd.inTok, 0)
    assert.equal(agentEnd.costUsd, 0)

    const errEvent = events.find((e) => e.type === 'error').data
    assert.equal(errEvent.code, 'CACHE_MISS')
    assert.match(errEvent.message, /no recording for hash/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('executeRun replay — no cassettePath: rejects with CACHE_MISS before running', async () => {
  const { emit } = makeCollector()
  await assert.rejects(
    executeRun(helloRunOpts({ emit, cassettePath: null })),
    (e) => e.code === 'CACHE_MISS' && /no cassette path provided/.test(e.message),
  )
})

test('executeRun replay — nonexistent cassette file: rejects with CACHE_MISS naming the path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-nofile-'))
  try {
    const missing = join(dir, 'does-not-exist.cassette.json')
    const { emit } = makeCollector()
    await assert.rejects(
      executeRun(helloRunOpts({ emit, cassettePath: missing })),
      (e) => e.code === 'CACHE_MISS' && e.message.includes(missing),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 5. record flag in replay: no disk write into the package cassettes/ ────────
//
// The record disk-write path (runner.mjs step 13) is HARDCODED to
// <package>/cassettes/<workflowId>-recorded.cassette.json and only fires for
// mode === 'live' with a real recorder backend — which requires a live API key
// and network. That branch is untestable hermetically (see notes); here we pin
// the guard: record:true in REPLAY mode must leave cassettes/ untouched.

test('executeRun replay — record:true does not write into package cassettes/', async () => {
  const cassettesDir = join(PKG_ROOT, 'cassettes')
  const before = readdirSync(cassettesDir).sort()
  const { events, emit } = makeCollector()
  const workflowId = 'hello-record-guard'
  const snap = await executeRun(helloRunOpts({ emit, record: true, workflowId }))

  assert.equal(snap.status, 'ok')
  const runStart = events.find((e) => e.type === 'run-start').data
  assert.equal(runStart.record, true) // flag is echoed…
  const after = readdirSync(cassettesDir).sort()
  assert.deepEqual(after, before, '…but replay mode must not write a cassette')
  assert.ok(!after.includes(`${workflowId}-recorded.cassette.json`))
})
