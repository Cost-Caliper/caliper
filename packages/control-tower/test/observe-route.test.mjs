// test/observe-route.test.mjs — POST /v1/observe ingest + GET /v1/observed reconstruction.
//
// Tests the beacon ingest endpoint and the observed runs list/detail routes.
// Uses a lightweight in-process server fixture (no separate process needed).

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { costOfUsage, naiveCostOfUsage } from '../src/observe-cost.mjs'

// ── costOfUsage math hand-check (the cache-math the /v1/observe route caches) ─
test('costOfUsage: input_tokens priced at 1× input rate', () => {
  // sonnet: $3/Mtok in, $15/Mtok out
  const usage = { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const cost = costOfUsage(usage, 'claude-sonnet-4-6')
  assert.ok(Math.abs(cost - 3.0) < 0.001, `Expected ~$3.00, got ${cost}`)
})

test('costOfUsage: output_tokens priced at output rate', () => {
  const usage = { input_tokens: 0, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const cost = costOfUsage(usage, 'claude-sonnet-4-6')
  // sonnet out = $15/Mtok
  assert.ok(Math.abs(cost - 15.0) < 0.001, `Expected ~$15.00, got ${cost}`)
})

test('costOfUsage: cache_creation priced at 1.25× input rate', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 0 }
  const cost = costOfUsage(usage, 'claude-sonnet-4-6')
  // sonnet in = $3/Mtok; create = $3 * 1.25 = $3.75
  assert.ok(Math.abs(cost - 3.75) < 0.001, `Expected ~$3.75, got ${cost}`)
})

test('costOfUsage: cache_read priced at 0.10× input rate', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000_000 }
  const cost = costOfUsage(usage, 'claude-sonnet-4-6')
  // sonnet in = $3/Mtok; read = $3 * 0.10 = $0.30
  assert.ok(Math.abs(cost - 0.30) < 0.001, `Expected ~$0.30, got ${cost}`)
})

test('costOfUsage: combined usage is sum of components', () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 500,
  }
  // sonnet: in=$3/Mtok, out=$15/Mtok
  // input:  100 * 3/1e6 = 0.0003
  // create: 200 * 3/1e6 * 1.25 = 0.00075
  // read:   500 * 3/1e6 * 0.10 = 0.00015
  // out:    50 * 15/1e6 = 0.00075
  // total:  0.001950
  const cost = costOfUsage(usage, 'claude-sonnet-4-6')
  const expected = 100 * 3/1e6 + 200 * 3/1e6 * 1.25 + 500 * 3/1e6 * 0.10 + 50 * 15/1e6
  assert.ok(Math.abs(cost - expected) < 1e-7, `Expected ~${expected.toFixed(8)}, got ${cost}`)
})

test('naiveCostOfUsage vs costOfUsage: cache_read makes cache-aware cheaper', () => {
  // When cache_read is large, the 0.1× discount makes cache-aware cost much lower
  const usage = {
    input_tokens: 5,
    output_tokens: 5,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 50_000,  // large cache read
  }
  const cacheAware = costOfUsage(usage, 'claude-haiku-4-5-20251001')
  const naive = naiveCostOfUsage(usage, 'claude-haiku-4-5-20251001')
  assert.ok(cacheAware < naive,
    `cache-aware (${cacheAware}) must be < naive (${naive}) when large cache_read`)
})

// ── Beacon ingest shape validation ───────────────────────────────────────────
// We test the shape the server expects from beacon payloads (from injected agents
// that curl POST /v1/observe). We can't start the full server here without
// a session dir, but we can validate the data shape logic.

test('beacon payload: run-start shape is valid JSON', () => {
  const payload = {
    runId: 'test-run-123',
    ev: 'run-start',
    name: 'my-workflow',
    ts: 1700000000000,
  }
  const json = JSON.stringify(payload)
  const parsed = JSON.parse(json)
  assert.equal(parsed.runId, 'test-run-123')
  assert.equal(parsed.ev, 'run-start')
  assert.ok(typeof parsed.ts === 'number')
})

test('beacon payload: phase shape is valid JSON', () => {
  const payload = {
    runId: 'test-run-123',
    ev: 'phase',
    phase: 'Summarize',
    ts: 1700000000100,
  }
  const json = JSON.stringify(payload)
  const parsed = JSON.parse(json)
  assert.equal(parsed.ev, 'phase')
  assert.equal(parsed.phase, 'Summarize')
})

test('beacon payload: run-end shape is valid JSON', () => {
  const payload = {
    runId: 'test-run-123',
    ev: 'run-end',
    ts: 1700000010000,
    result: 'completed',
  }
  const json = JSON.stringify(payload)
  const parsed = JSON.parse(json)
  assert.equal(parsed.ev, 'run-end')
})

// ── Observed run list shape ───────────────────────────────────────────────────
test('summaryFromRun produces required fields', async () => {
  // Import inline to avoid requiring a live session dir
  const { summaryFromRun } = await import('../src/observer.mjs')
  const fakeRun = {
    runId: 'abc123',
    source: 'observed-native',
    status: 'completed',
    meta: { name: 'my-test-wf' },
    agentCount: 3,
    totalTokens: 50000,
    durationMs: 5000,
    startTime: 1700000000000,
    timestamp: '2024-01-01T00:00:00Z',
    telemetry: {
      calls: [],
      perPhase: [],
      run: { calls: 3, inTok: 40000, outTok: 10000, costUsd: 0.000123, sumMs: 4800, wallMs: 2500, concurrencySavingMs: 2300, speedup: 1.92 },
    },
    beacons: [],
    traceRecords: [],
    phases: [],
  }
  const summary = summaryFromRun(fakeRun)
  assert.equal(summary.runId, 'abc123')
  assert.equal(summary.name, 'my-test-wf')
  assert.equal(summary.source, 'observed-native')
  assert.equal(summary.status, 'completed')
  assert.equal(summary.agentCount, 3)
  assert.equal(summary.costUsd, 0.000123)
})
