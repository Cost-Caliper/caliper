// test/estimate.test.mjs — keyless estimate/analyzeGraph/compare tests.
// Ported from A6 test-estimate.mjs static parts; no live LLM calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX = join(__dirname, 'fixtures')

import { analyzeGraph, estimate, compare, buildCalibratedTable } from '../src/estimate.mjs'

const fanoutSrc = readFileSync(join(FIX, 'fixture-fanout.workflow.js'), 'utf8')
const helloSrc = readFileSync(join(FIX, 'fixture-hello.workflow.js'), 'utf8')

// ── analyzeGraph ──────────────────────────────────────────────────────────────

test('analyzeGraph: fanout — correct agent count + phase count', () => {
  const a = analyzeGraph(fanoutSrc)
  assert.equal(a.agentCount, 3, 'AST sees 3 agent call-sites (1 template + 2 pipeline stages)')
  assert.equal(a.phases, 2, 'should have 2 phases')
})

test('analyzeGraph: fanout — byModel only contains haiku', () => {
  const a = analyzeGraph(fanoutSrc)
  assert.ok('haiku' in a.byModel, 'should have haiku in byModel')
  assert.equal(a.byModel.haiku, 3)
})

test('analyzeGraph: fanout — has parallel and pipeline groups', () => {
  const a = analyzeGraph(fanoutSrc)
  assert.ok(a.structure.parallelGroups >= 1, 'should have at least 1 parallel group')
  assert.ok(a.structure.pipelineGroups >= 1, 'should have at least 1 pipeline group')
})

test('analyzeGraph: hello — 1 agent, 1 phase, sequential', () => {
  const a = analyzeGraph(helloSrc)
  assert.equal(a.agentCount, 1)
  assert.equal(a.phases, 1)
  assert.equal(a.structure.sequential, 1)
  assert.equal(a.structure.parallelGroups, 0)
  assert.equal(a.structure.pipelineGroups, 0)
})

// ── estimate ──────────────────────────────────────────────────────────────────

test('estimate: returns positive costUsd', () => {
  const est = estimate(fanoutSrc)
  assert.ok(est.costUsd > 0, 'costUsd should be > 0: ' + est.costUsd)
})

test('estimate: costLow < costUsd < costHigh (±200% band)', () => {
  const est = estimate(fanoutSrc)
  assert.ok(est.costLow < est.costUsd, 'costLow should be < costUsd')
  assert.ok(est.costUsd < est.costHigh, 'costUsd should be < costHigh')
})

test('estimate: wallMs > 0', () => {
  const est = estimate(fanoutSrc)
  assert.ok(est.wallMs > 0, 'wallMs should be > 0: ' + est.wallMs)
})

test('estimate: tolerancePct = 200', () => {
  const est = estimate(fanoutSrc)
  assert.equal(est.tolerancePct, 200)
})

test('estimate: method is static-ast-calibrated', () => {
  const est = estimate(fanoutSrc)
  assert.equal(est.method, 'static-ast-calibrated')
})

test('estimate: fanout parallel group noted in breakdown notes (dynamic-multiplier caveat)', () => {
  const est = estimate(fanoutSrc)
  // The parallel has 1 AST agent (dynamic map pattern), which should produce a note
  const hasNote = est.breakdown.notes.length > 0 ||
    est.breakdown.parallelGroups.some(g => g.note)
  assert.ok(hasNote, 'expected a dynamic-multiplier note for the parallel group')
})

// ── compare ───────────────────────────────────────────────────────────────────

test('compare: inBand = true when actual is close to estimate', () => {
  const est = estimate(helloSrc)
  // Synthetic ledger snapshot that's within the ±200% band
  const syntheticLedger = {
    run: {
      calls: 1,
      costUsd: est.costUsd,  // exact match -> definitely in band
      wallMs: est.wallMs,
      sumMs: est.wallMs,
      inTok: 20,
      outTok: 8,
      concurrencySavingMs: 0,
      speedup: 1,
    }
  }
  const result = compare(est, syntheticLedger)
  assert.equal(result.inBand, true)
  assert.equal(result.verdict, 'PASS')
})

test('compare: inBand = false when actual is wildly outside band', () => {
  const est = estimate(helloSrc)
  const syntheticLedger = {
    run: {
      calls: 1,
      costUsd: est.costUsd * 1000,  // 1000x more expensive -> outside ±200% band
      wallMs: est.wallMs * 1000,
      sumMs: est.wallMs * 1000,
      inTok: 20000, outTok: 8000,
      concurrencySavingMs: 0, speedup: 1,
    }
  }
  const result = compare(est, syntheticLedger)
  assert.equal(result.inBand, false)
  assert.equal(result.verdict, 'OUTSIDE_TOLERANCE')
})

// ── buildCalibratedTable ──────────────────────────────────────────────────────

test('buildCalibratedTable: empty calibData -> returns seed table with haiku', () => {
  const table = buildCalibratedTable({ calls: [] })
  assert.ok('haiku' in table)
  assert.ok('sonnet' in table)
  assert.ok(table.haiku.avgMs > 0)
})

test('buildCalibratedTable: live calibData overrides seed table', () => {
  const calibData = {
    calls: [
      { tier: 'haiku', inTok: 50, outTok: 20, ms: 1234 },
      { tier: 'haiku', inTok: 60, outTok: 25, ms: 987 },
    ],
  }
  const table = buildCalibratedTable(calibData)
  // avgMs should reflect the live data average, not the seed
  assert.ok(table.haiku.source.startsWith('live'), 'source should indicate live data: ' + table.haiku.source)
  assert.equal(table.haiku.avgMs, Math.round((1234 + 987) / 2))
})
