// test/fallbacks.test.mjs — Fable→Opus refusal-fallback parsing + per-model cost attribution.
//
// Wire shapes are copied from REAL transcripts (captured 2026-07-02):
//   1. bare refusal   — model claude-fable-5, stop_reason "refusal", stop_details
//                       {type:"refusal",category:null,...}; the streamed partial IS billed.
//   2. fallback switch — model claude-opus-4-8, a {"type":"fallback","from","to"} content
//                       block, usage.iterations [{type:"message",model:fable},
//                       {type:"fallback_message",model:opus}].
//   3. sticky turn     — same iterations signature, NO fallback block (sticky routing
//                       serves later turns on the fallback model for ~1h).
// Streamed rows repeat usage under one requestId — dedup must count each request once.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseAgentTranscript } from '../src/observer.mjs'
import { costOfParse } from '../src/observe-cost.mjs'

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

function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-fallbacks-'))
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-06-12T20:40:00.000Z', cwd: '/repo', message: { content: 'do the thing' } }),
    // normal fable turn: 1000 in / 100 out
    entry({ ts: '2026-06-12T20:41:00.000Z', req: 'req_norm', model: 'claude-fable-5', text: 'working on it', usage: { ...U0, input_tokens: 1000, output_tokens: 100 } }),
    // bare refusal on fable — 357 output tokens billed for the discarded partial
    entry({
      ts: '2026-06-12T20:42:00.000Z', req: 'req_refusal', model: 'claude-fable-5', stop: 'refusal',
      stopDetails: { type: 'refusal', category: null, explanation: null, fallback_has_prefill_claim: true },
      content: [{ type: 'thinking', thinking: 'hmm' }],
      usage: { ...U0, input_tokens: 685, output_tokens: 357 },
    }),
    // fallback SWITCH — served by opus, carries the fallback block + iterations
    entry({
      ts: '2026-06-12T20:43:00.000Z', req: 'req_switch', model: 'claude-opus-4-8',
      content: [
        { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } },
        { type: 'text', text: 'continuing on opus' },
      ],
      usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
    // streamed DUPE row of the same switch request — must not double-count anything
    entry({
      ts: '2026-06-12T20:43:01.000Z', req: 'req_switch', model: 'claude-opus-4-8', text: 'more streamed text',
      usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
    // STICKY turn — opus-served, fallback_message iterations, no block
    entry({
      ts: '2026-06-12T20:44:00.000Z', req: 'req_sticky', model: 'claude-opus-4-8', text: 'still on opus',
      usage: { ...U0, input_tokens: 3000, output_tokens: 300, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
  ]
  const path = join(dir, 'agent-afallback01.jsonl')
  writeFileSync(path, lines.join('\n') + '\n')
  return { dir, path }
}

test('parseAgentTranscript: fallback rollup — refusals, switches, sticky turns, dedup', () => {
  const { dir, path } = writeFixture()
  try {
    const p = parseAgentTranscript(path)
    assert.ok(p, 'parsed')
    assert.ok(p.fallbacks, 'fallbacks rollup present')
    assert.equal(p.fallbacks.refusals, 1, 'one refusal')
    assert.equal(p.fallbacks.switches, 1, 'one switch (dupe row not double-counted)')
    assert.equal(p.fallbacks.stickyTurns, 1, 'one sticky turn')
    assert.equal(p.fallbacks.from, 'claude-fable-5')
    assert.equal(p.fallbacks.to, 'claude-opus-4-8')
    assert.equal(p.fallbacks.refusalOutputTokens, 357, 'billed partial output on the refusal')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseAgentTranscript: usageByModel splits per served model (dedup by requestId)', () => {
  const { dir, path } = writeFixture()
  try {
    const p = parseAgentTranscript(path)
    assert.ok(p.usageByModel, 'usageByModel present')
    const fable = p.usageByModel['claude-fable-5']
    const opus = p.usageByModel['claude-opus-4-8']
    assert.ok(fable && opus, 'both models bucketed')
    assert.equal(fable.input_tokens, 1685, 'fable input = normal 1000 + refusal 685')
    assert.equal(fable.output_tokens, 457, 'fable output = 100 + 357')
    assert.equal(opus.input_tokens, 5000, 'opus input = switch 2000 (once) + sticky 3000')
    assert.equal(opus.output_tokens, 500, 'opus output = 200 + 300')
    // totalUsage remains the sum of the split
    assert.equal(p.totalUsage.input_tokens, fable.input_tokens + opus.input_tokens)
    assert.equal(p.totalUsage.output_tokens, fable.output_tokens + opus.output_tokens)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseAgentTranscript light mode also carries fallbacks + usageByModel', () => {
  const { dir, path } = writeFixture()
  try {
    const p = parseAgentTranscript(path, { light: true })
    assert.ok(p.fallbacks, 'light mode fallbacks present')
    assert.equal(p.fallbacks.switches, 1)
    assert.ok(p.usageByModel && p.usageByModel['claude-opus-4-8'], 'light mode usageByModel present')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('costOfParse: mixed-model sessions price each model at its own rate', () => {
  const { dir, path } = writeFixture()
  try {
    const p = parseAgentTranscript(path)
    const cost = costOfParse(p)
    // fable: 1685 in ×$10 + 457 out ×$50 ; opus: 5000 in ×$5 + 500 out ×$25 (per Mtok)
    const expected = (1685 * 10 + 457 * 50) / 1e6 + (5000 * 5 + 500 * 25) / 1e6
    assert.ok(Math.abs(cost - expected) < 1e-9, `per-model sum (got ${cost}, want ${expected})`)
    // single-model pricing at fable rates would overcharge the opus turns — must differ
    const naive = (6685 * 10 + 957 * 50) / 1e6
    assert.ok(Math.abs(cost - naive) > 1e-6, 'not priced at first-model rates')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseAgentTranscript: sessions without fallbacks report fallbacks=null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-nofb-'))
  try {
    const path = join(dir, 'agent-aplain01.jsonl')
    writeFileSync(path, [
      JSON.stringify({ type: 'user', timestamp: '2026-06-12T20:40:00.000Z', message: { content: 'hi' } }),
      entry({ ts: '2026-06-12T20:41:00.000Z', req: 'req_1', model: 'claude-opus-4-8', usage: { ...U0, input_tokens: 10, output_tokens: 5 } }),
    ].join('\n') + '\n')
    const p = parseAgentTranscript(path)
    assert.equal(p.fallbacks, null, 'no fallback noise on clean sessions')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('parseAgentTranscript: fallback events carry the triggering prompt + timestamps', () => {
  const { dir, path } = writeFixture()
  try {
    const p = parseAgentTranscript(path)
    const evs = p.fallbacks.events
    assert.ok(Array.isArray(evs) && evs.length === 2, 'refusal + switch events recorded')
    const refusal = evs.find((e) => e.kind === 'refusal')
    const sw = evs.find((e) => e.kind === 'switch')
    assert.ok(refusal && sw, 'both kinds present')
    assert.equal(refusal.prompt, 'do the thing', 'refusal carries the triggering prompt')
    assert.equal(sw.prompt, 'do the thing', 'switch carries the triggering prompt')
    assert.equal(sw.from, 'claude-fable-5')
    assert.equal(sw.to, 'claude-opus-4-8')
    assert.ok(refusal.at && sw.at, 'timestamps present for timeline placement')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── REGRESSION: streamed refusal must be counted once, not dropped ────────────
// The bug (fixed 2026-07-02): refusals were counted only inside the usage-dedup
// block. A streamed refusal repeats its requestId across rows; when a non-refusal
// partial (stop_reason:null) precedes the refusal row, the usage-dedup marked the
// requestId "seen" first, so the refusal row was skipped → undercount (26→22, the
// launch number showed 100 instead of 104). This fixture reproduces that ordering.
test('REGRESSION: a streamed refusal (partial row first, same requestId) counts once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-streamref-'))
  try {
    const path = join(dir, 'agent-astream01.jsonl')
    writeFileSync(path, [
      JSON.stringify({ type: 'user', timestamp: '2026-06-12T20:40:00.000Z', message: { content: 'do a thing' } }),
      // Partial streamed row FIRST — same requestId, NOT a refusal. Pre-fix this
      // marked req_stream "seen" and consumed the usage-dedup slot.
      entry({ ts: '2026-06-12T20:41:00.000Z', req: 'req_stream', model: 'claude-fable-5', stop: null,
        content: [{ type: 'thinking', thinking: 'working' }],
        usage: { ...U0, input_tokens: 500, output_tokens: 40 } }),
      // The refusal row SECOND — same requestId. Pre-fix: countUsage=false → dropped.
      entry({ ts: '2026-06-12T20:41:02.000Z', req: 'req_stream', model: 'claude-fable-5', stop: 'refusal',
        stopDetails: { type: 'refusal', category: 'cyber', explanation: null },
        content: [{ type: 'thinking', thinking: 'declining' }],
        usage: { ...U0, input_tokens: 500, output_tokens: 120 } }),
    ].join('\n') + '\n')
    const p = parseAgentTranscript(path)
    assert.ok(p.fallbacks, 'fallbacks present')
    assert.equal(p.fallbacks.refusals, 1, 'streamed refusal counted exactly once (was 0 pre-fix)')
    assert.equal(p.fallbacks.categories.cyber, 1, 'category captured from the refusal row')
    // And it must NOT double-count if the refusal row itself repeats (multi-chunk stream).
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('REGRESSION: a refusal repeated across multiple streamed rows still counts once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-streamref2-'))
  try {
    const path = join(dir, 'agent-astream02.jsonl')
    const refRow = (ts) => entry({ ts, req: 'req_r', model: 'claude-fable-5', stop: 'refusal',
      stopDetails: { type: 'refusal', category: null, explanation: null },
      content: [{ type: 'thinking', thinking: 'x' }], usage: { ...U0, input_tokens: 300, output_tokens: 90 } })
    writeFileSync(path, [
      JSON.stringify({ type: 'user', timestamp: '2026-06-12T20:40:00.000Z', message: { content: 'hi' } }),
      refRow('2026-06-12T20:41:00.000Z'),
      refRow('2026-06-12T20:41:00.500Z'), // duplicate streamed chunk, same requestId
    ].join('\n') + '\n')
    const p = parseAgentTranscript(path)
    assert.equal(p.fallbacks.refusals, 1, 'duplicate streamed refusal rows dedup to one')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
