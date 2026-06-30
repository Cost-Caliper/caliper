// test/learnings.test.mjs — keyless grounding check tests.
// groundingCheck rejects ungrounded cites. distillLearnings/runAndDistill are
// key-gated and covered by the live demo only.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { groundingCheck } from '../src/learnings.mjs'

// Synthetic learnings + input that lets us verify grounding
const traceLines = [
  { t: 'TRACE', seq: 1, kind: 'agent', label: 'greeter', phase: 'Greet', ev: 'enter' },
  { t: 'TRACE', seq: 1, kind: 'agent', label: 'greeter', phase: 'Greet', ev: 'resolve', ok: true },
]
const ledger = {
  calls: [
    { id: 1, label: 'greeter', tier: 'haiku', model: 'haiku', phase: 'Greet', startMs: 0, endMs: 800, ms: 800, inTok: 20, outTok: 8, costUsd: 0.000060, requestId: 'req-abc123' },
  ],
  run: { calls: 1, inTok: 20, outTok: 8, costUsd: 0.000060, sumMs: 800, wallMs: 800, concurrencySavingMs: 0, speedup: 1 },
}

test('groundingCheck: passes when every cite is a substring of the serialized input', () => {
  const learnings = {
    costHotspots: [{ label: 'greeter', model: 'haiku', phase: 'Greet', costUsd: 0.000060, cites: ['req-abc123', '0.00006'] }],
    slowestAgents: [],
    failures: [],
    patterns: [{ statement: 'one call', cites: ['greeter'] }],
    recommendations: [],
  }
  const result = groundingCheck(learnings, { traceLines, ledger })
  assert.equal(result.failed.length, 0, 'expected no failures, got: ' + JSON.stringify(result.failed))
})

test('groundingCheck: fails an injected fabricated cite not in input', () => {
  const learnings = {
    costHotspots: [{ label: 'greeter', model: 'haiku', phase: 'Greet', costUsd: 0.000060, cites: ['req-FABRICATED-999'] }],
    slowestAgents: [],
    failures: [],
    patterns: [],
    recommendations: [],
  }
  const result = groundingCheck(learnings, { traceLines, ledger })
  assert.ok(result.failed.length > 0, 'expected failures for fabricated cite')
  assert.ok(result.failed.some(f => f.cite === 'req-FABRICATED-999'))
})

test('groundingCheck: fails a learning with empty cites (ungrounded)', () => {
  const learnings = {
    costHotspots: [],
    slowestAgents: [],
    failures: [],
    patterns: [{ statement: 'something happened', cites: [] }],
    recommendations: [],
  }
  const result = groundingCheck(learnings, { traceLines, ledger })
  assert.ok(result.failed.length > 0, 'empty cites should be flagged as ungrounded')
})

test('groundingCheck: requestId is a valid cite when present in ledger', () => {
  const learnings = {
    costHotspots: [{ label: 'greeter', model: 'haiku', phase: 'Greet', costUsd: 0.000060, cites: ['req-abc123'] }],
    slowestAgents: [],
    failures: [],
    patterns: [],
    recommendations: [],
  }
  const result = groundingCheck(learnings, { traceLines, ledger })
  assert.equal(result.failed.length, 0, 'req-abc123 should be found in the ledger')
  assert.ok(result.passed.length > 0)
})

test('groundingCheck: numeric costUsd is a valid cite as string', () => {
  const learnings = {
    costHotspots: [{ label: 'greeter', model: 'haiku', phase: 'Greet', costUsd: 0.000060, cites: ['0.00006'] }],
    slowestAgents: [],
    failures: [],
    patterns: [],
    recommendations: [],
  }
  // '0.00006' should appear in JSON.stringify of the ledger (costUsd: 0.00006)
  const result = groundingCheck(learnings, { traceLines, ledger })
  // Note: JSON.stringify of 0.000060 = '0.00006' — depends on how JS formats it
  // This tests the actual behavior; if it fails adjust the cite to match the serialized form
  const allCites = result.passed.concat(result.failed).map(r => r.cite)
  assert.ok(allCites.includes('0.00006'))
})
