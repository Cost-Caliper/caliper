// test/aggregate-fallbacks.test.mjs — machine-wide aggregation of refusal-fallback
// counts (aggregateMachine totals.fallbacks + per-day/per-repo buckets), resume safety
// of the module-global aggState accumulator, and listAllSessions (cross-project rows).
//
// Wire shapes mirror test/fallbacks.test.mjs (copied from REAL transcripts):
//   bare refusal (stop_reason "refusal" + stop_details), fallback switch (opus-served
//   row with a {"type":"fallback"} block + usage.iterations), sticky turn (iterations
//   fallback_message signature, no block). Clean sessions have neither.
//
// Fixture layout (3 sessions across 2 project dirs):
//   projA/S1  main-transcript fallbacks: 1 refusal(cyber) + 1 switch + 1 sticky, cwd /x/alpha
//   projA/S2  clean, cwd /x/alpha
//   projB/S3  clean main + a workflow subagent with 2 refusals(harmful,cyber) + 1 switch, cwd /x/beta
// Expected machine totals: switches 2, refusals 3, sticky 1, mainTotal 2, subTotal 3,
// wfAgents 1, sessionsAffected 2, categories {cyber:2, harmful:1}.

import './_env.mjs' // FIRST — sandboxes HOME before sessions.mjs computes its disk-cache path
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { aggregateMachine, resetAggregateScan, listAllSessions } from '../src/sessions.mjs'

const U0 = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// Same assistant-row builder as fallbacks.test.mjs, plus a top-level cwd (the
// aggregate groups repos by the transcript's cwd field).
function entry(over) {
  return JSON.stringify({
    type: 'assistant', timestamp: over.ts, cwd: over.cwd, requestId: over.req, uuid: over.uuid || over.req,
    message: {
      model: over.model, stop_reason: over.stop || 'end_turn',
      ...(over.stopDetails ? { stop_details: over.stopDetails } : {}),
      content: over.content || [{ type: 'text', text: over.text || 'ok' }],
      usage: over.usage || { ...U0, input_tokens: 100, output_tokens: 10 },
    },
  })
}
const user = (ts, cwd, text) => JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content: text } })

const refusalRow = (ts, req, cwd, category) => entry({
  ts, req, cwd, model: 'claude-fable-5', stop: 'refusal',
  stopDetails: { type: 'refusal', category, explanation: null, fallback_has_prefill_claim: true },
  content: [{ type: 'thinking', thinking: 'hmm' }],
  usage: { ...U0, input_tokens: 685, output_tokens: 357 },
})
const switchRow = (ts, req, cwd) => entry({
  ts, req, cwd, model: 'claude-opus-4-8',
  content: [
    { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } },
    { type: 'text', text: 'continuing on opus' },
  ],
  usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
})
const stickyRow = (ts, req, cwd) => entry({
  ts, req, cwd, model: 'claude-opus-4-8', text: 'still on opus',
  usage: { ...U0, input_tokens: 3000, output_tokens: 300, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
})

const S1 = '11111111-1111-1111-1111-111111111111' // main-transcript fallbacks
const S2 = '22222222-2222-2222-2222-222222222222' // clean
const S3 = '33333333-3333-3333-3333-333333333333' // workflow-subagent fallbacks

// `pad` appends N clean filler turns per session so each transcript parses in >1ms —
// used by the resume test to force the budgetMs:1 loop to actually span calls.
function makeRoot({ pad = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ct-aggfb-'))
  const filler = (cwd, dayPrefix) => Array.from({ length: pad }, (_, i) =>
    entry({ ts: `${dayPrefix}T13:00:${String(i % 60).padStart(2, '0')}.${String(i % 1000).padStart(3, '0')}Z`, cwd, req: `req_fill_${i}`, model: 'claude-haiku-4-5', text: 'filler' }))

  const projA = join(root, '-Users-x-dev-alpha')
  mkdirSync(projA, { recursive: true })
  // S1 — fallbacks in the MAIN transcript (midday-UTC timestamps keep day buckets stable across tz)
  writeFileSync(join(projA, `${S1}.jsonl`), [
    user('2026-06-01T12:00:00.000Z', '/x/alpha', 'alpha main work'),
    entry({ ts: '2026-06-01T12:01:00.000Z', cwd: '/x/alpha', req: 'req_a1', model: 'claude-fable-5', text: 'working', usage: { ...U0, input_tokens: 1000, output_tokens: 100 } }),
    refusalRow('2026-06-01T12:02:00.000Z', 'req_a2', '/x/alpha', 'cyber'),
    switchRow('2026-06-01T12:03:00.000Z', 'req_a3', '/x/alpha'),
    stickyRow('2026-06-01T12:04:00.000Z', 'req_a4', '/x/alpha'),
    ...filler('/x/alpha', '2026-06-01'),
  ].join('\n') + '\n')
  // S2 — clean session, two days later
  writeFileSync(join(projA, `${S2}.jsonl`), [
    user('2026-06-03T12:00:00.000Z', '/x/alpha', 'clean session'),
    entry({ ts: '2026-06-03T12:00:05.000Z', cwd: '/x/alpha', req: 'req_b1', model: 'claude-opus-4-8', usage: { ...U0, input_tokens: 10, output_tokens: 5 } }),
    ...filler('/x/alpha', '2026-06-03'),
  ].join('\n') + '\n')

  const projB = join(root, '-Users-x-dev-beta')
  mkdirSync(projB, { recursive: true })
  // S3 — clean MAIN transcript; all fallbacks live in a workflow-fan-out subagent
  writeFileSync(join(projB, `${S3}.jsonl`), [
    user('2026-06-05T12:00:00.000Z', '/x/beta', 'beta workflow run'),
    entry({ ts: '2026-06-05T12:00:05.000Z', cwd: '/x/beta', req: 'req_c0', model: 'claude-fable-5', usage: { ...U0, input_tokens: 50, output_tokens: 5 } }),
    ...filler('/x/beta', '2026-06-05'),
  ].join('\n') + '\n')
  const wfDir = join(projB, S3, 'subagents', 'workflows', 'wf_agg01')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, 'agent-ab12cd34.jsonl'), [ // hex-only name — collectSubagentTranscripts' regex
    user('2026-06-05T12:01:00.000Z', '/x/beta', 'sub task'),
    refusalRow('2026-06-05T12:02:00.000Z', 'req_c1', '/x/beta', 'harmful'),
    refusalRow('2026-06-05T12:03:00.000Z', 'req_c2', '/x/beta', 'cyber'),
    switchRow('2026-06-05T12:04:00.000Z', 'req_c3', '/x/beta'),
  ].join('\n') + '\n')
  return root
}

// MUTATION-PROVED: commented out `F.subTotal += (ss.switches||0)+(ss.refusals||0)`
// (src/sessions.mjs:246) → "subTotal = subagent-layer switches+refusals: 0 !== 3" and
// the main+sub identity failed. Restored → green.
test('aggregateMachine totals.fallbacks: per-session sums; mainTotal+subTotal === switches+refusals', () => {
  const root = makeRoot()
  resetAggregateScan()
  try {
    const r = aggregateMachine(root, { budgetMs: 60000 })
    assert.equal(r.done, true, 'big budget finishes in one call')
    const F = r.totals.fallbacks
    assert.equal(F.switches, 2, 'switches = S1 main 1 + S3 sub 1')
    assert.equal(F.refusals, 3, 'refusals = S1 main 1 + S3 sub 2')
    assert.equal(F.sticky, 1, 'sticky = S1 main only')
    assert.equal(F.mainSwitches, 1, 'main-layer switches')
    assert.equal(F.subSwitches, 1, 'subagent-layer switches')
    assert.equal(F.mainTotal, 2, 'mainTotal = main switches+refusals (S1: 1+1)')
    assert.equal(F.subTotal, 3, 'subTotal = subagent-layer switches+refusals (S3: 1+2)')
    assert.equal(F.mainTotal + F.subTotal, F.switches + F.refusals, 'split layers must recompose to the headline total')
    assert.equal(F.wfAgents, 1, 'S3 fallback agent lives under subagents/workflows/')
  } finally { rmSync(root, { recursive: true, force: true }); resetAggregateScan() }
})

// MUTATION-PROVED: changed the per-bucket count (src/sessions.mjs:254) to switches-only
// (dropped `+ (sum.fallbacks.refusals || 0)`) → "S1 day bucket carries its switch+refusal
// count: 1 !== 2" (and byRepo beta 1 !== 3). Restored → green.
test('aggregateMachine byDay/byRepo: per-bucket switches+refusals land on the right buckets', () => {
  const root = makeRoot()
  resetAggregateScan()
  try {
    const r = aggregateMachine(root, { budgetMs: 60000 })
    assert.equal(r.done, true)
    // byDay sorts ascending; the 3 sessions sit on distinct days 2 apart, so relative
    // order survives any local-timezone day shift of the midday-UTC timestamps.
    assert.equal(r.byDay.length, 3, 'one bucket per active day')
    assert.ok(r.byDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)))
    assert.equal(r.byDay[0].fallbacks, 2, 'S1 day bucket carries its switch+refusal count')
    assert.equal(r.byDay[0].sessions, 1)
    assert.equal(r.byDay[1].fallbacks, 0, 'clean S2 day contributes 0')
    assert.equal(r.byDay[2].fallbacks, 3, 'S3 day carries the subagent switch+refusals')
    const alpha = r.byRepo.find((x) => x.repo === 'alpha')
    const beta = r.byRepo.find((x) => x.repo === 'beta')
    assert.ok(alpha && beta, 'repos grouped by transcript cwd basename')
    assert.equal(alpha.sessions, 2, 'S1 + clean S2 share the alpha repo')
    assert.equal(alpha.fallbacks, 2, 'alpha = S1 switch+refusal; clean S2 adds 0')
    assert.equal(beta.sessions, 1)
    assert.equal(beta.fallbacks, 3, 'beta = S3 subagent switch+2 refusals')
  } finally { rmSync(root, { recursive: true, force: true }); resetAggregateScan() }
})

// MUTATION-PROVED: changed `F.sessionsAffected++` (src/sessions.mjs:248) to
// `F.sessionsAffected += (sum.fallbacks.switches||0)+(sum.fallbacks.refusals||0)`
// (counting events, not sessions) → "distinct sessions, not events: 5 !== 2". Restored → green.
test('aggregateMachine: sessionsAffected counts distinct sessions once; categories merge across sessions', () => {
  const root = makeRoot()
  resetAggregateScan()
  try {
    const r = aggregateMachine(root, { budgetMs: 60000 })
    assert.equal(r.done, true)
    assert.equal(r.totals.sessions, 3, 'all sessions scanned (clean one included)')
    // S1 has 3 events and S3 has 3 events — but only 2 sessions are affected.
    assert.equal(r.totals.fallbacks.sessionsAffected, 2, 'distinct sessions, not events')
    assert.deepEqual(r.totals.fallbacks.categories, { cyber: 2, harmful: 1 }, 'S1 cyber + S3 harmful+cyber merge')
  } finally { rmSync(root, { recursive: true, force: true }); resetAggregateScan() }
})

// RESUME SAFETY — aggState is a module-global accumulator; a resumed budget-sliced scan
// must land on exactly the totals of a single big-budget pass (no re-added sessions).
// The resumed pass runs FIRST (cold summary cache + padded transcripts >1ms each) so the
// budgetMs:1 loop provably spans multiple calls; the warm big-budget pass then re-scans.
// MUTATION-PROVED: inserted `if (s.idx > 0) s.idx--` after `const s = aggState`
// (src/sessions.mjs:225) so every resumed call re-processes the previous item → the
// scan never finished within the bounded loop ("resumed scan finishes: false") and, with
// a looser stall, totals.sessions inflated. Restored → green.
test('aggregateMachine resume safety: budget-sliced scan totals === single big-budget scan totals', () => {
  const root = makeRoot({ pad: 2000 })
  resetAggregateScan()
  try {
    let r = null, calls = 0
    while (calls < 500) { calls++; r = aggregateMachine(root, { budgetMs: 1 }); if (r.done) break }
    assert.equal(r.done, true, 'resumed scan finishes within bounded calls')
    assert.ok(calls >= 2, `padded transcripts must force a real resume (took ${calls} call[s])`)
    assert.equal(r.progress.scannedSessions, r.progress.totalSessions, 'progress reaches queue length')
    assert.equal(r.progress.totalSessions, 3)
    const resumed = JSON.parse(JSON.stringify({ totals: r.totals, byDay: r.byDay, byRepo: r.byRepo, byTier: r.byTier }))

    resetAggregateScan()
    const big = aggregateMachine(root, { budgetMs: 600000 })
    assert.equal(big.done, true, 'warm big-budget pass finishes in one call')
    assert.equal(big.totals.sessions, 3)
    assert.deepEqual(resumed.totals, big.totals, 'resumed totals (incl. fallbacks) match the one-shot scan')
    assert.deepEqual(resumed.byDay, big.byDay, 'resumed byDay matches')
    assert.deepEqual(resumed.byRepo, big.byRepo, 'resumed byRepo matches')
    assert.deepEqual(resumed.byTier, big.byTier, 'resumed byTier matches')
  } finally { rmSync(root, { recursive: true, force: true }); resetAggregateScan() }
})

// MUTATION-PROVED: flipped the sort (src/sessions.mjs:196) to oldest-first
// (`(a.mtimeMs||0) - (b.mtimeMs||0)`) → "newest-first across projects" deepEqual failed
// ([S1,S3,S2] instead of [S2,S3,S1]). Restored → green.
test('listAllSessions: cross-project rows carry projectSlug/projectCwd, newest-first; limit caps but total reports all', () => {
  const root = makeRoot()
  try {
    // Force a cross-project mtime order: S2 (alpha) newest, then S3 (beta), then S1 (alpha).
    const t = Date.now() / 1000
    utimesSync(join(root, '-Users-x-dev-alpha', `${S2}.jsonl`), t, t)
    utimesSync(join(root, '-Users-x-dev-beta', `${S3}.jsonl`), t - 100, t - 100)
    utimesSync(join(root, '-Users-x-dev-alpha', `${S1}.jsonl`), t - 200, t - 200)

    const all = listAllSessions(root)
    assert.equal(all.total, 3)
    assert.deepEqual(all.sessions.map((s) => s.id), [S2, S3, S1], 'newest-first across projects')
    const s3 = all.sessions.find((s) => s.id === S3)
    assert.equal(s3.projectSlug, '-Users-x-dev-beta', 'row knows its project folder')
    assert.equal(s3.projectCwd, '/x/beta', 'row carries the recovered real cwd')
    const s1 = all.sessions.find((s) => s.id === S1)
    assert.equal(s1.projectSlug, '-Users-x-dev-alpha')
    assert.equal(s1.projectCwd, '/x/alpha')
    assert.equal(s1.fallbacks.switches, 1, 'summaries (incl. fallbacks) ride along on rows')

    const capped = listAllSessions(root, { limit: 2 })
    assert.equal(capped.sessions.length, 2, 'limit caps the rows')
    assert.deepEqual(capped.sessions.map((s) => s.id), [S2, S3], 'cap keeps the newest')
    assert.equal(capped.total, 3, 'total still reports every session beyond the cap')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
