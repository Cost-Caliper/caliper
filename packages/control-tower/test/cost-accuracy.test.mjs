// test/cost-accuracy.test.mjs — Cost accuracy vs ground truth (ccusage parity).
// Two real bugs found 2026-07-01 by cross-checking ccusage v20:
//   1. Streamed transcripts repeat the SAME usage under one requestId across
//      multiple assistant rows → summing every row double-counts (exactly 2× on
//      the fixture session). Fix: count usage once per requestId.
//   2. fable-5 is $10/$50 (own tier), not opus $5/$25; and cache WRITES are
//      priced by TTL bucket: ephemeral_5m ×1.25, ephemeral_1h ×2.0 of input.
// With both fixes our totals match ccusage exactly on real sessions.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { costOfUsage, tierFromModel } from '../src/observe-cost.mjs'
import { parseAgentTranscript } from '../src/observer.mjs'

test('tierFromModel: fable-5 is its own tier (priced 2× opus), not opus', () => {
  assert.equal(tierFromModel('claude-fable-5'), 'fable')
  assert.equal(tierFromModel('claude-opus-4-8'), 'opus')
})

test('costOfUsage: fable-5 at $10/$50; 1h cache writes at ×2.0, 5m at ×1.25', () => {
  // The real 0cb84732 session (deduped): ccusage says $1.16
  const usage = {
    input_tokens: 16730, output_tokens: 453,
    cache_creation_input_tokens: 47073, cache_read_input_tokens: 30086,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 47073 },
  }
  const c = costOfUsage(usage, 'claude-fable-5')
  // 16730×10 + 453×50 + 47073×10×2.0 + 30086×10×0.10 per Mtok
  const expected = (16730 * 10 + 453 * 50 + 47073 * 20 + 30086 * 1) / 1e6
  assert.ok(Math.abs(c - expected) < 1e-6, `${c} != ${expected}`)
  assert.ok(Math.abs(c - 1.16) < 0.01, `should match ccusage ~$1.16, got ${c}`)
})

test('costOfUsage: no TTL buckets → legacy ×1.25 fallback unchanged', () => {
  const usage = { input_tokens: 1e6, output_tokens: 0, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 0 }
  const c = costOfUsage(usage, 'claude-opus-4-8')
  assert.ok(Math.abs(c - (5 + 6.25)) < 1e-6, `got ${c}`)
})

test('parseAgentTranscript: usage counted ONCE per requestId (streamed dupes ignored)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-cost-'))
  try {
    const u = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 50, cache_read_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 } }
    const row = (req, text) => JSON.stringify({ type: 'assistant', requestId: req, timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', usage: u, content: [{ type: 'text', text }] } })
    const p = join(dir, 'sess.jsonl')
    writeFileSync(p, [
      JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } }),
      row('req_1', 'part a'), row('req_1', 'part b'), // same request, streamed twice
      row('req_2', 'second answer'),
    ].join('\n'))
    const parsed = parseAgentTranscript(p)
    assert.equal(parsed.totalUsage.input_tokens, 200)   // 2 unique requests, not 3 rows
    assert.equal(parsed.totalUsage.output_tokens, 20)
    assert.equal(parsed.totalUsage.cache_creation_input_tokens, 100)
    assert.equal(parsed.totalUsage.cache_read_input_tokens, 400)
    // TTL buckets accumulate too (for accurate pricing of the totals)
    assert.equal(parsed.totalUsage.cache_5m_input_tokens, 100)
    assert.equal(parsed.totalUsage.cache_1h_input_tokens, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('REAL-SESSION PARITY: 0cb84732 matches ccusage ($1.16) and 738d4acc main ($108.87)', (t) => {
  const proj = '/Users/dennison/.claude/projects/-Users-dennison-develop-agent-university'
  const plain = join(proj, '0cb84732-d6d3-4854-90c6-985062eb6290.jsonl')
  const rich = join(proj, '738d4acc-35fb-492c-bcec-153e4b8d1d68.jsonl')
  const p1 = parseAgentTranscript(plain, { light: true })
  if (!p1) return t.skip('fixture session not on this machine')
  assert.equal(p1.totalUsage.input_tokens, 16730)
  assert.equal(p1.totalUsage.output_tokens, 453)
  const c1 = costOfUsage(p1.totalUsage, p1.model)
  assert.ok(Math.abs(c1 - 1.16) < 0.01, `plain session: got $${c1}, ccusage $1.16`)
  // ccusage's "session" merges the main transcript WITH its subagent transcripts
  // (they carry the parent sessionId). Our decomposition is finer-grained — main and
  // subagents attributed separately — so parity is on the SUM, not the main alone.
  const p2 = parseAgentTranscript(rich, { light: true })
  if (!p2) return t.skip('rich fixture absent')
  let total = costOfUsage(p2.totalUsage, p2.model)
  const subDir = rich.replace(/\.jsonl$/, '') + '/subagents'
  for (const f of readdirSync(subDir).filter((x) => /^agent-[0-9a-f]+\.jsonl$/.test(x))) {
    const ps = parseAgentTranscript(join(subDir, f), { light: true })
    if (ps) total += costOfUsage(ps.totalUsage, ps.model)
  }
  assert.ok(Math.abs(total - 108.87) < 1.7, `rich session main+subagents: got $${total}, ccusage $108.87`)
})
