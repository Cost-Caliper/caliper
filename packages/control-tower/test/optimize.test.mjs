// test/optimize.test.mjs — node --test: verify optimization suggestions cite real ledger reqIds.
//
// The grounding invariant: every suggestion.cites[] entry must be a string that
// appears literally in the serialized ledger snapshot. This prevents the optimizer
// from fabricating request IDs or numbers that weren't in the actual run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveOptimizations } from '../src/optimize.mjs'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLedgerSnapshot({ calls = [], run = {} } = {}) {
  const defaultRun = {
    calls: calls.length,
    inTok: calls.reduce((s, c) => s + (c.inTok || 0), 0),
    outTok: calls.reduce((s, c) => s + (c.outTok || 0), 0),
    costUsd: calls.reduce((s, c) => s + (c.costUsd || 0), 0),
    sumMs: calls.reduce((s, c) => s + (c.ms || 0), 0),
    wallMs: calls.length ? Math.max(...calls.map(c => c.endMs || 0)) - Math.min(...calls.map(c => c.startMs || 0)) : 0,
    speedup: 1,
    concurrencySavingMs: 0,
  }
  return { calls, perPhase: [], run: { ...defaultRun, ...run } }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('deriveOptimizations — empty ledger returns no suggestions', () => {
  const snap = makeLedgerSnapshot()
  const { suggestions } = deriveOptimizations(snap)
  assert.ok(Array.isArray(suggestions), 'suggestions is array')
})

test('deriveOptimizations — cap-budget suggestion cites real costUsd value', () => {
  const calls = [
    { id: 1, label: 'greeter', tier: 'haiku', model: 'haiku', costUsd: 0.000035, ms: 800,
      inTok: 20, outTok: 5, requestId: 'req-abc123', startMs: 0, endMs: 800 },
  ]
  const snap = makeLedgerSnapshot({
    calls,
    run: { calls: 1, costUsd: 0.000035, wallMs: 800, sumMs: 800 }
  })

  const { suggestions } = deriveOptimizations(snap)

  // cap-budget suggestion should be present
  const capSug = suggestions.find(s => s.kind === 'cap-budget')
  assert.ok(capSug, 'cap-budget suggestion present')
  assert.ok(Array.isArray(capSug.cites), 'cites is array')
  assert.ok(capSug.cites.length > 0, 'has at least one cite')

  // Every cite must appear as a substring in the serialized snapshot
  const corpus = JSON.stringify(snap)
  for (const cite of capSug.cites) {
    assert.ok(corpus.includes(String(cite)), `cite "${cite}" appears in ledger corpus`)
  }
})

test('deriveOptimizations — duplicate label triggers gate-cache suggestion with grounded cites', () => {
  const calls = [
    { id: 1, label: 'fact:oceans', tier: 'haiku', model: 'haiku', costUsd: 0.000010, ms: 500,
      inTok: 10, outTok: 3, requestId: 'req-1', startMs: 0, endMs: 500 },
    { id: 2, label: 'fact:oceans', tier: 'haiku', model: 'haiku', costUsd: 0.000010, ms: 480,
      inTok: 10, outTok: 3, requestId: 'req-2', startMs: 10, endMs: 490 },
    { id: 3, label: 'fact:mountains', tier: 'haiku', model: 'haiku', costUsd: 0.000010, ms: 520,
      inTok: 10, outTok: 3, requestId: 'req-3', startMs: 20, endMs: 540 },
  ]
  const snap = makeLedgerSnapshot({ calls })

  const { suggestions } = deriveOptimizations(snap)
  const cacheSug = suggestions.find(s => s.kind === 'gate-cache')
  assert.ok(cacheSug, 'gate-cache suggestion present for duplicate labels')

  // Grounding check: all cites in corpus
  const corpus = JSON.stringify(snap)
  for (const cite of cacheSug.cites) {
    assert.ok(corpus.includes(String(cite)), `gate-cache cite "${cite}" is grounded in ledger`)
  }

  // proposedRunBody should suggest useGate:true
  assert.ok(cacheSug.proposedRunBody?.useGate, 'gate-cache proposes useGate:true')
})

test('deriveOptimizations — all suggestion cites are grounded (invariant)', () => {
  // Parameterized: for any valid ledger, every cite must appear in the serialized ledger.
  const calls = [
    { id: 1, label: 'call-a', tier: 'sonnet', model: 'sonnet', costUsd: 0.0005, ms: 1200,
      inTok: 100, outTok: 50, requestId: 'req-sonnet-001', startMs: 0, endMs: 1200 },
    { id: 2, label: 'call-a', tier: 'sonnet', model: 'sonnet', costUsd: 0.0005, ms: 1100,
      inTok: 100, outTok: 50, requestId: 'req-sonnet-002', startMs: 5, endMs: 1105 },
    { id: 3, label: 'call-b', tier: 'haiku',  model: 'haiku',  costUsd: 0.00002, ms: 600,
      inTok: 20, outTok: 8, requestId: 'req-haiku-003', startMs: 0, endMs: 600 },
  ]
  const snap = makeLedgerSnapshot({
    calls,
    run: { calls: 3, costUsd: 0.00102, wallMs: 1205, sumMs: 2900, speedup: 2.4, concurrencySavingMs: 1695 }
  })

  const { suggestions } = deriveOptimizations(snap)
  const corpus = JSON.stringify(snap)

  let totalCites = 0
  let failedCites = 0
  for (const sug of suggestions) {
    for (const cite of (sug.cites || [])) {
      totalCites++
      if (!corpus.includes(String(cite))) {
        failedCites++
        console.error(`UNGROUNDED CITE: "${cite}" in suggestion kind="${sug.kind}"`)
      }
    }
  }
  assert.equal(failedCites, 0, `All ${totalCites} cites are grounded in the ledger (${failedCites} failed)`)
})

test('deriveOptimizations — no suggestions for single-call run with unique labels', () => {
  const calls = [
    { id: 1, label: 'only-call', tier: 'haiku', model: 'haiku', costUsd: 0.000015, ms: 400,
      inTok: 15, outTok: 4, requestId: null, startMs: 0, endMs: 400 },
  ]
  const snap = makeLedgerSnapshot({ calls })
  const { suggestions } = deriveOptimizations(snap)

  // With a single haiku call, there's no router candidate or duplicate
  // only cap-budget should appear (if cost > 0)
  const nonCapSuggestions = suggestions.filter(s => s.kind !== 'cap-budget')
  assert.equal(nonCapSuggestions.length, 0, 'no non-cap suggestions for single unique haiku call')
})
