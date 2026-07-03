// test/fallback-invariants.test.mjs — order-independence INVARIANTS of the
// parseAgentTranscript fallback rollup (the "distinct events, no double-count"
// property the launch total of 104 relies on).
//
// Pinned semantics (read from src/observer.mjs, lines ~282-426):
//   * refusals    = number of DISTINCT requestIds that carry a stop_reason:"refusal"
//                   row. Dedup lives in its OWN set (seenRefusalReqs), independent of
//                   both the usage-dedup set and the fallback state map — so streamed
//                   dupes and row order cannot change the count.
//   * switches + stickyTurns = number of DISTINCT requestIds that carry a fallback
//                   block and/or fallback_message iterations (fbReqState keys). The
//                   split is order-independent: a fallback BLOCK on any streamed row
//                   makes that request a switch — if it was already tallied sticky,
//                   the upgrade branch decrements stickyTurns and increments switches.
//   * kinds are INDEPENDENT: one requestId can be tallied as BOTH a refusal and a
//                   switch (separate dedup keys); within one kind it never counts twice.
//   * usageByModel is a PARTITION of totalUsage: usage counts once per requestId, on
//                   the first-seen row, attributed to that row's model. Summing the
//                   per-model buckets reproduces totalUsage exactly, in every order.
//
// Wire shapes are copied from test/fallbacks.test.mjs (real transcripts, 2026-07-02):
// bare refusal / fallback-block switch / sticky iterations-only turn / streamed dupes.
// Permutations are ENUMERATED (4! = 24 fixtures) — no randomness.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseAgentTranscript } from '../src/observer.mjs'

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

const userRow = JSON.stringify({ type: 'user', timestamp: '2026-06-12T20:40:00.000Z', cwd: '/repo', message: { content: 'do the thing' } })
const FABLE = 'claude-fable-5'
const OPUS = 'claude-opus-4-8'
const stickyIters = [{ type: 'message', model: FABLE }, { type: 'fallback_message', model: OPUS }]

// The four permutable rows: one refusal request, one switch request (block row +
// its streamed iterations-only dupe on the SAME requestId), one sticky request.
// Timestamps are constant on purpose — ordering comes from LINE order, which is
// what the parser iterates; that is exactly the axis under test.
const ROWS = {
  R1: entry({ // bare refusal on fable — billed discarded partial
    ts: '2026-06-12T20:42:00.000Z', req: 'req_refusal', model: FABLE, stop: 'refusal',
    stopDetails: { type: 'refusal', category: null, explanation: null },
    content: [{ type: 'thinking', thinking: 'hmm' }],
    usage: { ...U0, input_tokens: 685, output_tokens: 357 },
  }),
  S1: entry({ // fallback SWITCH — block + iterations
    ts: '2026-06-12T20:43:00.000Z', req: 'req_switch', model: OPUS,
    content: [
      { type: 'fallback', from: { model: FABLE }, to: { model: OPUS } },
      { type: 'text', text: 'continuing on opus' },
    ],
    usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: stickyIters },
  }),
  S1d: entry({ // streamed dupe of the switch request — iterations only, NO block.
    // When this row precedes S1 it exercises the sticky→switch upgrade path.
    ts: '2026-06-12T20:43:01.000Z', req: 'req_switch', model: OPUS, text: 'streamed text',
    usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: stickyIters },
  }),
  T1: entry({ // STICKY turn — iterations, no block, distinct requestId
    ts: '2026-06-12T20:44:00.000Z', req: 'req_sticky', model: OPUS, text: 'still on opus',
    usage: { ...U0, input_tokens: 3000, output_tokens: 300, iterations: stickyIters },
  }),
}

function parseFixture(lines, tag) {
  const dir = mkdtempSync(join(tmpdir(), `ct-fbinv-${tag}-`))
  try {
    const path = join(dir, 'agent-ainv01.jsonl')
    writeFileSync(path, lines.join('\n') + '\n')
    return parseAgentTranscript(path)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

function permutations(arr) {
  if (arr.length <= 1) return [arr]
  const out = []
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const p of permutations(rest)) out.push([arr[i], ...p])
  }
  return out
}

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens',
  'cache_read_input_tokens', 'cache_5m_input_tokens', 'cache_1h_input_tokens']

function assertUsagePartition(p, label) {
  // (d) usageByModel is a partition of totalUsage — dedup invariant on the usage side.
  for (const k of USAGE_KEYS) {
    const sum = Object.values(p.usageByModel).reduce((a, mu) => a + (mu[k] || 0), 0)
    assert.equal(sum, p.totalUsage[k] || 0, `${label}: usageByModel sums to totalUsage for ${k}`)
  }
}

// ── (a)+(d) every permutation: each requestId counts once per kind ────────────
// MUTATION-PROVED (2026-07-02):
//   src/observer.mjs:407 `if (prev === 'sticky') fb.stickyTurns--` → `if (false) ...`
//   → RED here on every S1d-before-S1 ordering ("stickyTurns=1 ... got 2") and in the
//   upgrade test below; restored via git checkout → GREEN.
//   src/observer.mjs:354 delete `if (requestId) seenRequestIds.add(requestId)`
//   → RED ("opus usage counted once: ... 5000 ... got 7000"); restored → GREEN.
test('INVARIANT: all 24 orderings of {refusal, switch, switch-dupe, sticky} count each requestId once per kind', () => {
  const names = ['R1', 'S1', 'S1d', 'T1']
  const perms = permutations(names)
  assert.equal(perms.length, 24, 'enumerated fixture count')
  for (const perm of perms) {
    const label = `order=${perm.join(',')}`
    const p = parseFixture([userRow, ...perm.map((n) => ROWS[n])], 'perm')
    assert.ok(p && p.fallbacks, `${label}: fallbacks rollup present`)
    assert.equal(p.fallbacks.refusals, 1, `${label}: refusals=1 (req_refusal once)`)
    assert.equal(p.fallbacks.switches, 1, `${label}: switches=1 (req_switch once, dupe row folded)`)
    assert.equal(p.fallbacks.stickyTurns, 1, `${label}: stickyTurns=1 (req_sticky once)`)
    // switches + stickyTurns = distinct fallback-served requestIds (2);
    // refusals = distinct refused requestIds (1). Grand total = 3 distinct requests.
    assert.equal(p.fallbacks.switches + p.fallbacks.stickyTurns, 2, `${label}: fallback tally = distinct fallback requestIds`)
    assert.equal(p.fallbacks.refusals + p.fallbacks.switches + p.fallbacks.stickyTurns, 3,
      `${label}: total = distinct affected requestIds`)
    // usage dedup: req_switch's two rows carry identical usage — counted once.
    assert.equal(p.usageByModel[FABLE].input_tokens, 685, `${label}: fable usage from the refusal row only`)
    assert.equal(p.usageByModel[OPUS].input_tokens, 5000, `${label}: opus usage counted once per requestId (2000+3000)`)
    assert.equal(p.usageByModel[OPUS].output_tokens, 500, `${label}: opus output counted once per requestId`)
    assertUsagePartition(p, label)
  }
})

// ── (b) sticky→switch upgrade: iterations row FIRST, block row SECOND ─────────
// The upgrade branch decrements the provisional sticky before counting the switch,
// so the request lands as exactly ONE switch — never sticky+switch.
// MUTATION-PROVED: same `if (false)` mutation as above → RED here with
// "upgraded request is not double-counted as sticky: Expected 0, got 1".
test('INVARIANT: sticky-first row upgraded to switch by a later block — not double-counted', () => {
  const p = parseFixture([userRow, ROWS.S1d, ROWS.S1], 'upgrade')
  assert.ok(p.fallbacks, 'fallbacks present')
  assert.equal(p.fallbacks.switches, 1, 'upgraded to exactly one switch')
  assert.equal(p.fallbacks.stickyTurns, 0, 'upgraded request is not double-counted as sticky')
  assert.equal(p.fallbacks.refusals, 0, 'no refusal in this fixture')
  const ev = p.fallbacks.events.filter((e) => e.kind === 'switch')
  assert.equal(ev.length, 1, 'exactly one switch event recorded')
  assert.equal(ev[0].from, FABLE)
  assert.equal(ev[0].to, OPUS)
  assertUsagePartition(p, 'upgrade')
})

// ── streamed dupes of EVERY kind in one adversarial order ─────────────────────
// Dupes: refusal row repeated (R1 twice), switch's iterations-only dupe BEFORE the
// block row, sticky row repeated. Every kind still counts once.
// MUTATION-PROVED (2026-07-02): src/observer.mjs:386 delete `seenRefusalReqs.add(rkey)`
// → RED here ("refusal dupes dedup to one: Expected 1, got 2") and in the permutation
// test's refusal assertions stay green (R1 appears once there) — this fixture is the
// dedup-set guard. Restored via git checkout → GREEN.
test('INVARIANT: streamed duplicates of refusal, switch and sticky rows each dedup to one', () => {
  const p = parseFixture([userRow, ROWS.S1d, ROWS.T1, ROWS.R1, ROWS.S1, ROWS.R1, ROWS.T1], 'dupes')
  assert.ok(p.fallbacks, 'fallbacks present')
  assert.equal(p.fallbacks.refusals, 1, 'refusal dupes dedup to one')
  assert.equal(p.fallbacks.switches, 1, 'switch counted once despite dupe + upgrade ordering')
  assert.equal(p.fallbacks.stickyTurns, 1, 'sticky dupes dedup to one')
  assert.equal(p.fallbacks.refusalOutputTokens, 357, 'refusal billing counted once, not per dupe row')
  assertUsagePartition(p, 'dupes')
})

// ── (c) one requestId that is BOTH refused and switched ───────────────────────
// The code branches on independent dedup keys (seenRefusalReqs vs fbReqState), so a
// single requestId CAN legitimately appear once in each kind — pinned here for both
// row orders. Within one kind it never counts twice.
test('INVARIANT: a requestId both refused and switched counts once per kind, either order', () => {
  const refusalRow = entry({
    ts: '2026-06-12T20:45:00.000Z', req: 'req_both', model: FABLE, stop: 'refusal',
    stopDetails: { type: 'refusal', category: 'cyber', explanation: null },
    content: [{ type: 'thinking', thinking: 'declining' }],
    usage: { ...U0, input_tokens: 400, output_tokens: 50 },
  })
  const switchRow = entry({
    ts: '2026-06-12T20:45:01.000Z', req: 'req_both', model: OPUS,
    content: [
      { type: 'fallback', from: { model: FABLE }, to: { model: OPUS } },
      { type: 'text', text: 're-served on opus' },
    ],
    usage: { ...U0, input_tokens: 400, output_tokens: 50, iterations: stickyIters },
  })
  for (const [label, rows] of [
    ['refusal-first', [refusalRow, switchRow]],
    ['switch-first', [switchRow, refusalRow]],
  ]) {
    const p = parseFixture([userRow, ...rows], 'both')
    assert.ok(p.fallbacks, `${label}: fallbacks present`)
    assert.equal(p.fallbacks.refusals, 1, `${label}: refused once`)
    assert.equal(p.fallbacks.switches, 1, `${label}: switched once`)
    assert.equal(p.fallbacks.stickyTurns, 0, `${label}: never also tallied sticky`)
    // usage still counts ONCE for the shared requestId (first-seen row's model wins)
    assert.equal(p.totalUsage.input_tokens, 400, `${label}: shared requestId usage counted once`)
    assert.equal(p.totalUsage.output_tokens, 50, `${label}: shared requestId output counted once`)
    assertUsagePartition(p, label)
  }
})
