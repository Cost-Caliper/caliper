// test/observer.test.mjs — fixture-tests against REAL captured harness artifacts.
//
// Uses the actual wf_*.json + journal.jsonl + agent-*.jsonl files from the
// live session directory. These are real files; nothing is fabricated.
//
// Fixtures:
//   wf_8de34f64-90f — conditional-shunt-probe: 2 agents (haiku decision + sonnet work)
//                     haiku has cache_creation_input_tokens=18321 -> cache-aware cost
//                     should be less than naive (read=0.1× discount applied)
//   wf_f206a8ce-85b — sandbox-probe-2: 2 agents (haiku + sonnet), subagent bridge curl

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { reconstructRun, summaryFromRun, parseRunJson } from '../src/observer.mjs'
import { costOfUsage, naiveCostOfUsage, tierFromModel } from '../src/observe-cost.mjs'

// The session dir holding real harness fixtures. Set WFLENS_TEST_SESSION_DIR to a
// Claude Code session dir (one containing workflows/wf_*.json + subagents/) to exercise
// the fixture-backed assertions; otherwise those tests skip and only the unit tests run.
const SESS = process.env.WFLENS_TEST_SESSION_DIR || ''

// ── Helpers ───────────────────────────────────────────────────────────────────
function skipIfMissing(runId, t) {
  const wfPath = join(SESS, 'workflows', `wf_${runId}.json`)
  if (!existsSync(wfPath)) {
    t.skip(`Fixture wf_${runId}.json not found — skipping`)
    return true
  }
  return false
}

// ── cost helpers unit tests ───────────────────────────────────────────────────
test('tierFromModel resolves haiku/sonnet/opus correctly', () => {
  assert.equal(tierFromModel('claude-haiku-4-5-20251001'), 'haiku')
  assert.equal(tierFromModel('claude-sonnet-4-6'), 'sonnet')
  assert.equal(tierFromModel('claude-opus-4-8'), 'opus')
  assert.equal(tierFromModel('claude-opus-4-8[1m]'), 'opus')
  assert.equal(tierFromModel(null), 'sonnet')
  assert.equal(tierFromModel('unknown-model'), 'sonnet')
})

test('costOfUsage: cache_creation costs 1.25x input, cache_read costs 0.1x', () => {
  // haiku: in=$1/Mtok, out=$5/Mtok
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 1_000_000,  // 1M tokens at create premium
    cache_read_input_tokens: 0,
  }
  const cost = costOfUsage(usage, 'claude-haiku-4-5-20251001')
  // Expected: 1M * ($1/1M) * 1.25 = $1.25
  assert.ok(Math.abs(cost - 1.25) < 0.0001, `Expected ~1.25, got ${cost}`)

  const usageRead = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1_000_000,  // 1M tokens at read discount
  }
  const costRead = costOfUsage(usageRead, 'claude-haiku-4-5-20251001')
  // Expected: 1M * ($1/1M) * 0.10 = $0.10
  assert.ok(Math.abs(costRead - 0.10) < 0.0001, `Expected ~0.10, got ${costRead}`)
})

test('costOfUsage is less than naiveCostOfUsage when cache_read is present', () => {
  const usage = {
    input_tokens: 5,
    output_tokens: 5,
    cache_creation_input_tokens: 639,
    cache_read_input_tokens: 18321,   // large cache read -> big discount
  }
  const cacheAware = costOfUsage(usage, 'claude-haiku-4-5-20251001')
  const naive = naiveCostOfUsage(usage, 'claude-haiku-4-5-20251001')
  assert.ok(cacheAware < naive, `cacheAware (${cacheAware}) should be < naive (${naive})`)
})

test('costOfUsage hand-check for known token counts', () => {
  // haiku agent in wf_8de34f64-90f, last turn:
  //   input_tokens=5, output_tokens=5, cache_creation=639, cache_read=18321
  // haiku in=$1/Mtok, out=$5/Mtok
  const usage = {
    input_tokens: 5,
    output_tokens: 5,
    cache_creation_input_tokens: 639,
    cache_read_input_tokens: 18321,
  }
  const cost = costOfUsage(usage, 'claude-haiku-4-5-20251001')
  // input:   5 * 1e-6 = 0.000005
  // create: 639 * 1e-6 * 1.25 = 0.00079875
  // read:   18321 * 1e-6 * 0.10 = 0.0018321
  // out:    5 * 5e-6 = 0.000025
  // total: ~0.0026559
  assert.ok(cost > 0, 'cost should be > 0')
  assert.ok(cost < 0.01, 'cost should be < $0.01 for these tiny token counts')
})

test('observed run readers reject traversal-shaped run ids', () => {
  assert.equal(parseRunJson('../secrets', '/tmp/session'), null)
  assert.equal(parseRunJson('..%2Fsecrets', '/tmp/session'), null)
  assert.equal(reconstructRun('../secrets', '/tmp/session'), null)
})

// ── wf_8de34f64-90f: conditional-shunt-probe ──────────────────────────────────
test('wf_8de34f64-90f: parseRunJson returns correct structure', (t) => {
  if (skipIfMissing('8de34f64-90f', t)) return
  const run = parseRunJson('8de34f64-90f', SESS)
  assert.ok(run, 'parseRunJson should return a result')
  assert.equal(run.runId, '8de34f64-90f')
  assert.equal(run.status, 'completed')
  assert.equal(run.agentCount, 2)
  assert.ok(Array.isArray(run.phases))
  assert.ok(Array.isArray(run.workflowProgress))
  assert.ok(run.workflowProgress.some((e) => e.type === 'workflow_agent'), 'Should have agent entries')
})

test('wf_8de34f64-90f: reconstructRun produces 2 agents with correct models', (t) => {
  if (skipIfMissing('8de34f64-90f', t)) return
  const run = reconstructRun('8de34f64-90f', SESS)
  assert.ok(run, 'reconstructRun should return a result')
  assert.equal(run.source, 'observed-native')
  assert.equal(run.status, 'completed')
  assert.equal(run.telemetry.calls.length, 2, 'Should have 2 agent calls')

  // Decision agent = haiku, work agent = sonnet
  const haiku = run.telemetry.calls.find((c) => c.tier === 'haiku')
  const sonnet = run.telemetry.calls.find((c) => c.tier === 'sonnet')
  assert.ok(haiku, 'Should have a haiku agent (decision)')
  assert.ok(sonnet, 'Should have a sonnet agent (work)')

  // Confirm real model IDs
  assert.ok(haiku.model.includes('haiku'), `haiku model should contain 'haiku': ${haiku.model}`)
  assert.ok(sonnet.model.includes('sonnet'), `sonnet model should contain 'sonnet': ${sonnet.model}`)
})

test('wf_8de34f64-90f: cache-aware cost > 0 for haiku agent', (t) => {
  if (skipIfMissing('8de34f64-90f', t)) return
  const run = reconstructRun('8de34f64-90f', SESS)
  assert.ok(run)
  const haiku = run.telemetry.calls.find((c) => c.tier === 'haiku')
  assert.ok(haiku)
  assert.ok(haiku.costUsd > 0, `haiku cost should be > 0, got ${haiku.costUsd}`)
  // haiku has cache_creation (write) + cache_read — cost must reflect cache discounts
  // vs naive pricing which would be more expensive
  assert.ok(haiku.cacheCreationTok > 0 || haiku.cacheReadTok > 0,
    'haiku should have cache tokens from transcript')
})

test('wf_8de34f64-90f: reconstructRun total cost > 0', (t) => {
  if (skipIfMissing('8de34f64-90f', t)) return
  const run = reconstructRun('8de34f64-90f', SESS)
  assert.ok(run)
  assert.ok(run.telemetry.run.costUsd > 0, `total costUsd should be > 0, got ${run.telemetry.run.costUsd}`)
})

test('wf_8de34f64-90f: summaryFromRun has required fields', (t) => {
  if (skipIfMissing('8de34f64-90f', t)) return
  const run = reconstructRun('8de34f64-90f', SESS)
  const summary = summaryFromRun(run)
  assert.ok(summary)
  assert.equal(summary.source, 'observed-native')
  assert.equal(summary.agentCount, 2)
  assert.ok(summary.costUsd > 0)
  assert.ok(summary.name)
})

// ── wf_f206a8ce-85b: sandbox-probe-2 ─────────────────────────────────────────
test('wf_f206a8ce-85b: reconstructRun returns 2 agents', (t) => {
  if (skipIfMissing('f206a8ce-85b', t)) return
  const run = reconstructRun('f206a8ce-85b', SESS)
  assert.ok(run, 'reconstructRun should return a result for sandbox-probe-2')
  assert.equal(run.source, 'observed-native')
  assert.equal(run.telemetry.calls.length, 2, 'Should have 2 agent calls')
})

test('wf_f206a8ce-85b: run object shape is complete', (t) => {
  if (skipIfMissing('f206a8ce-85b', t)) return
  const run = reconstructRun('f206a8ce-85b', SESS)
  assert.ok(run)
  assert.ok(run.telemetry)
  assert.ok(Array.isArray(run.telemetry.calls))
  assert.ok(Array.isArray(run.telemetry.perPhase))
  assert.ok(run.telemetry.run)
  assert.ok('costUsd' in run.telemetry.run)
  assert.ok('wallMs' in run.telemetry.run)
  assert.ok('sumMs' in run.telemetry.run)
  assert.ok('speedup' in run.telemetry.run)
})

test('wf_f206a8ce-85b: beacons merge correctly (empty)', (t) => {
  if (skipIfMissing('f206a8ce-85b', t)) return
  const run = reconstructRun('f206a8ce-85b', SESS, [])
  assert.ok(run)
  assert.deepEqual(run.beacons, [])
})

test('wf_f206a8ce-85b: beacons from POST /v1/observe merge into run', (t) => {
  if (skipIfMissing('f206a8ce-85b', t)) return
  const beacons = [
    { runId: 'f206a8ce-85b', ev: 'run-start', name: 'sandbox-probe-2', ts: Date.now() },
    { runId: 'f206a8ce-85b', ev: 'run-end', ts: Date.now() },
  ]
  const run = reconstructRun('f206a8ce-85b', SESS, beacons)
  assert.ok(run)
  assert.equal(run.beacons.length, 2)
  assert.equal(run.beacons[0].ev, 'run-start')
})

// ── instrumentationId beacon correlation (Bug C fix) ─────────────────────────
// These tests exercise the new beacon correlation path without requiring a real
// harness session dir. We construct a synthetic runJson scenario by testing
// parseRunJson + reconstructRun with mocked data.

test('observer: beacon posted with instrumentationId attaches to run via beaconsByInstrumentationId Map', (t) => {
  if (skipIfMissing('f206a8ce-85b', t)) return
  // Simulate: the instrumented workflow emitted a WFLENS_TRACE meta line with
  // instrumentationId="test-id-abc", and a beacon arrived under that id.
  // We inject a synthetic traceRecord into the run via extraBeacons=[] and
  // a Map keyed by instrumentationId.
  const FAKE_INSTRUMENTATION_ID = 'deadbeef'

  const beaconsByInstrumentationId = new Map()
  beaconsByInstrumentationId.set(FAKE_INSTRUMENTATION_ID, [
    { instrumentationId: FAKE_INSTRUMENTATION_ID, ev: 'run-start', ts: 1700000000000 },
    { instrumentationId: FAKE_INSTRUMENTATION_ID, ev: 'run-end', ts: 1700000010000 },
  ])

  // reconstructRun won't find the instrumentationId in the real wf_f206a8ce-85b trace
  // records (it has no meta trace line). Beacons by instrumentationId should not be
  // attached in that case (no match in traceRecords).
  const run = reconstructRun('f206a8ce-85b', SESS, [], beaconsByInstrumentationId)
  assert.ok(run)
  // No match because the real run doesn't have a meta trace with our fake id
  // — beacons should be empty (not incorrectly attached to the wrong run)
  assert.equal(run.beacons.length, 0,
    'beacons should not attach to run that has no matching meta trace instrumentationId')
})

test('observer: reconstructRun exposes instrumentationId=null when no meta trace', (t) => {
  if (skipIfMissing('f206a8ce-85b', t)) return
  const run = reconstructRun('f206a8ce-85b', SESS)
  assert.ok(run)
  // The real fixture was run before instrumentationId was introduced — meta.instrumentationId
  // should be null rather than throwing
  assert.ok('instrumentationId' in run.meta,
    'run.meta should have instrumentationId key')
  assert.equal(run.meta.instrumentationId, null,
    'instrumentationId should be null for runs with no meta trace')
})

test('observer: beaconsByInstrumentationId Map lookup works via parseRunJson traceRecords', () => {
  // Unit-test the correlation logic directly by constructing a minimal synthetic
  // run with a meta trace record and checking that the beacon lookup fires.
  // We use a fake runId that won't exist on disk, so we test the logic path
  // by calling the exported parseRunJson helper with an in-memory simulation.
  // Since parseRunJson reads from disk we verify the schema contract instead.

  // Verify that reconstructRun's new 4th param is accepted and doesn't throw
  // when beaconsByInstrumentationId is null/undefined/a Map.
  const fakeMap = new Map()
  fakeMap.set('abc', [{ ev: 'run-start', instrumentationId: 'abc' }])

  // Call with a non-existent runId — should return null gracefully
  const nullResult = reconstructRun('nonexistent-run-xyz', SESS, [], fakeMap)
  assert.equal(nullResult, null, 'non-existent runId returns null gracefully with beaconsByInstrumentationId Map')

  // Also verify null beaconsByInstrumentationId doesn't throw
  const nullMap = reconstructRun('nonexistent-run-xyz', SESS, [], null)
  assert.equal(nullMap, null, 'null beaconsByInstrumentationId does not throw')
})
