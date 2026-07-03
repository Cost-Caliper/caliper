// test/observer-resilience.test.mjs — parseAgentTranscript malformed-line resilience.
//
// A LIVE session's transcript can carry a torn tail (Claude Code appends JSONL; a
// read that races the writer sees half a JSON object with no newline) and, in
// pathological cases, interleaved junk. The `catch { continue }` in the parse loop
// (src/observer.mjs, `try { entry = JSON.parse(line) } catch { continue }`) is what
// keeps that from crashing the summary — a fail-fast refactor would silently drop
// in-progress sessions from machine totals. These tests pin that resilience.
//
// Wire shapes copied from test/fallbacks.test.mjs (REAL transcripts captured
// 2026-07-02): bare refusal, fallback-block switch, sticky turn, streamed dupes.
//
// _env.mjs MUST be first: summarizeSessionFile (src/sessions.mjs) writes a disk
// cache under ~/.cache/workflow-lens — the sandbox HOME keeps runs hermetic.
import './_env.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseAgentTranscript } from '../src/observer.mjs'
import { summarizeSessionFile } from '../src/sessions.mjs'

const U0 = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// Same entry builder as test/fallbacks.test.mjs — real assistant-row shape.
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

// The full fallback fixture from test/fallbacks.test.mjs: user prompt, normal fable
// turn, bare refusal, fallback switch (+ streamed dupe), sticky turn.
// Expected rollup: refusals=1, switches=1, stickyTurns=1, turns=5,
// tokens in=6685 out=957 (fable 1685/457 + opus 5000/500).
function fallbackLines() {
  return [
    JSON.stringify({ type: 'user', timestamp: '2026-06-12T20:40:00.000Z', cwd: '/repo', message: { content: 'do the thing' } }),
    entry({ ts: '2026-06-12T20:41:00.000Z', req: 'req_norm', model: 'claude-fable-5', text: 'working on it', usage: { ...U0, input_tokens: 1000, output_tokens: 100 } }),
    entry({
      ts: '2026-06-12T20:42:00.000Z', req: 'req_refusal', model: 'claude-fable-5', stop: 'refusal',
      stopDetails: { type: 'refusal', category: null, explanation: null, fallback_has_prefill_claim: true },
      content: [{ type: 'thinking', thinking: 'hmm' }],
      usage: { ...U0, input_tokens: 685, output_tokens: 357 },
    }),
    entry({
      ts: '2026-06-12T20:43:00.000Z', req: 'req_switch', model: 'claude-opus-4-8',
      content: [
        { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: 'claude-opus-4-8' } },
        { type: 'text', text: 'continuing on opus' },
      ],
      usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
    entry({
      ts: '2026-06-12T20:43:01.000Z', req: 'req_switch', model: 'claude-opus-4-8', text: 'more streamed text',
      usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
    entry({
      ts: '2026-06-12T20:44:00.000Z', req: 'req_sticky', model: 'claude-opus-4-8', text: 'still on opus',
      usage: { ...U0, input_tokens: 3000, output_tokens: 300, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: 'claude-opus-4-8' }] },
    }),
  ]
}

// A torn tail: the FIRST HALF of a valid assistant row, no trailing newline —
// exactly what a reader sees when it races the harness appending to a live
// transcript. Big token numbers so any accidental counting would be visible.
function tornTail() {
  const full = entry({ ts: '2026-06-12T20:45:00.000Z', req: 'req_torn', model: 'claude-fable-5', text: 'never finished', usage: { ...U0, input_tokens: 999999, output_tokens: 888888 } })
  return full.slice(0, Math.floor(full.length / 2))
}

// Fields that must be identical between a torn-tail parse and the intact-prefix parse.
function comparable(p) {
  return {
    totalUsage: p.totalUsage,
    usageByModel: p.usageByModel,
    assistantTurns: p.assistantTurns,
    toolCalls: p.toolCalls,
    model: p.model,
    fallbacks: p.fallbacks && {
      refusals: p.fallbacks.refusals, switches: p.fallbacks.switches, stickyTurns: p.fallbacks.stickyTurns,
      refusalOutputTokens: p.fallbacks.refusalOutputTokens, categories: p.fallbacks.categories,
      from: p.fallbacks.from, to: p.fallbacks.to,
    },
    firstTimestamp: p.firstTimestamp,
    lastTimestamp: p.lastTimestamp,
  }
}

// ── (a) torn tail on a live transcript ────────────────────────────────────────
// MUTATION-PROVED (2026-07-02): src/observer.mjs parse loop
//   `try { entry = JSON.parse(line) } catch { continue }`
// → `try { entry = JSON.parse(line) } catch (e) { throw e }`
// RED: "SyntaxError: Unterminated string in JSON at position 209" thrown from
// parseAgentTranscript (also reds tests b–e below — same guard). Restored via
// git checkout → green.
test('torn tail: a truncated final line parses; totals equal the intact prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-torn-'))
  try {
    const intactPath = join(dir, 'agent-abc0123de0.jsonl')
    const tornPath = join(dir, 'agent-abc0123de1.jsonl')
    writeFileSync(intactPath, fallbackLines().join('\n') + '\n')
    writeFileSync(tornPath, fallbackLines().join('\n') + '\n' + tornTail()) // no trailing newline
    const intact = parseAgentTranscript(intactPath, { light: true })
    const torn = parseAgentTranscript(tornPath, { light: true })
    assert.ok(torn, 'torn transcript still parses')
    assert.deepEqual(comparable(torn), comparable(intact), 'torn tail changes nothing')
    // Exact pins so a silently-empty parse can never pass:
    assert.equal(torn.assistantTurns, 5, 'all intact turns counted')
    assert.equal(torn.totalUsage.input_tokens, 6685, 'input tokens = intact prefix (torn 999999 not counted)')
    assert.equal(torn.totalUsage.output_tokens, 957)
    assert.equal(torn.fallbacks.refusals, 1)
    assert.equal(torn.fallbacks.switches, 1)
    assert.equal(torn.fallbacks.stickyTurns, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── (b) garbage interleaved between valid lines ───────────────────────────────
// MUTATION-PROVED (2026-07-02), two mutations:
//   1. catch rethrow (as in test a) → RED: "SyntaxError: Unexpected token"
//   2. `catch { continue }` → `catch { break }` (fail-fast drop-the-rest) → RED:
//      "AssertionError ... assistantTurns after junk still counted: 0 !== 5"
//      (test a stays GREEN under mutation 2 — its junk is tail-only — so this
//      test is the one that pins mid-file resilience). Restored → green.
test('interleaved garbage (binary junk, empty lines, half-objects) is skipped; counts unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-junk-'))
  try {
    const clean = fallbackLines()
    const junk = [
      'this is not json at all',
      ' � binary-ish junk ÿþ',
      '{"type":"assistant","message":{"mod', // half an object mid-file
      '}{',
      '', // empty line
      '   ', // whitespace-only line
    ]
    // Interleave: junk after every valid line.
    const lines = []
    for (let i = 0; i < clean.length; i++) { lines.push(clean[i]); lines.push(junk[i % junk.length]) }
    const cleanPath = join(dir, 'agent-abc0123de2.jsonl')
    const dirtyPath = join(dir, 'agent-abc0123de3.jsonl')
    writeFileSync(cleanPath, clean.join('\n') + '\n')
    writeFileSync(dirtyPath, lines.join('\n') + '\n')
    const a = parseAgentTranscript(cleanPath, { light: true })
    const b = parseAgentTranscript(dirtyPath, { light: true })
    assert.ok(b, 'dirty transcript still parses')
    assert.equal(b.assistantTurns, 5, 'assistantTurns after junk still counted')
    assert.deepEqual(comparable(b), comparable(a), 'interleaved junk changes nothing')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── (c) entirely-garbage transcript ───────────────────────────────────────────
// Pins the ACTUAL behavior (probed 2026-07-02): parseAgentTranscript returns the
// empty shape (not null, does not throw) — zero usage, 0 turns, fallbacks null.
// MUTATION-PROVED (2026-07-02): same catch-rethrow mutation as test a → RED:
// "SyntaxError: Unexpected token" thrown instead of the empty shape. Restored → green.
test('entirely-garbage transcript returns the empty shape rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-alljunk-'))
  try {
    const path = join(dir, 'agent-abc0123de4.jsonl')
    writeFileSync(path, 'not json\n � garbage\n{"half": tr\n}{}{\n')
    const p = parseAgentTranscript(path, { light: true })
    assert.ok(p, 'returns an object, does not throw / return undefined')
    assert.equal(p.assistantTurns, 0)
    assert.equal(p.toolCalls, 0)
    assert.equal(p.model, null)
    assert.equal(p.fallbacks, null)
    assert.equal(p.firstTimestamp, null)
    assert.deepEqual(p.totalUsage, {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, cache_5m_input_tokens: 0, cache_1h_input_tokens: 0,
    })
    assert.deepEqual(p.usageByModel, {})
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// BUG (found 2026-07-02, NOT fixed — production code untouched per ground rules):
// a transcript line containing literal `null` (valid JSON!) crashes
// parseAgentTranscript with an uncaught "TypeError: Cannot read properties of
// null (reading 'cwd')" — the `catch { continue }` wraps only JSON.parse, and the
// very next statement dereferences `entry.cwd`. Any JSON-scalar line whose parse
// result is null escapes the malformed-line guard entirely, so one such line in a
// live transcript drops that session from machine totals (the exact failure mode
// this file exists to prevent). Repro (verified red against current src):
//
// test('BUG: a literal `null` line must be skipped like any other junk line', () => {
//   const dir = mkdtempSync(join(tmpdir(), 'ct-nullline-'))
//   try {
//     const path = join(dir, 'agent-abc0123de5.jsonl')
//     writeFileSync(path, fallbackLines().join('\n') + '\nnull\n')
//     const p = parseAgentTranscript(path, { light: true }) // THROWS TypeError today
//     assert.equal(p.assistantTurns, 5)
//   } finally { rmSync(dir, { recursive: true, force: true }) }
// })

// ── (d) torn tail through summarizeSessionFile (the machine-totals path) ──────
// MUTATION-PROVED (2026-07-02): same catch-rethrow mutation as test a → RED:
// "SyntaxError: Unterminated string in JSON" thrown out of summarizeSessionFile —
// i.e. the live session would crash the summary instead of being counted.
// Restored → green.
test('summarizeSessionFile: torn-tail live session summarizes; costUsd/tokens equal the intact prefix', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'ct-proj-torn-'))
  try {
    const intactId = '11111111-1111-1111-1111-111111111111'
    const tornId = '22222222-2222-2222-2222-222222222222'
    writeFileSync(join(projectDir, `${intactId}.jsonl`), fallbackLines().join('\n') + '\n')
    writeFileSync(join(projectDir, `${tornId}.jsonl`), fallbackLines().join('\n') + '\n' + tornTail())
    const intact = summarizeSessionFile(projectDir, intactId)
    const torn = summarizeSessionFile(projectDir, tornId)
    assert.ok(intact && torn, 'both sessions summarized')
    assert.equal(torn.costUsd, intact.costUsd, 'cost of the torn session = intact prefix')
    assert.ok(torn.costUsd > 0, 'cost is real, not a zeroed-out summary')
    assert.deepEqual(torn.tokens, intact.tokens, 'token rollup unchanged by the torn tail')
    assert.deepEqual(torn.tokens, { in: 6685, out: 957, cacheWr: 0, cacheRd: 0 })
    assert.equal(torn.turns, 5)
    assert.ok(torn.fallbacks, 'fallback rollup survives the torn tail')
    assert.equal(torn.fallbacks.refusals, intact.fallbacks.refusals)
    assert.equal(torn.fallbacks.switches, intact.fallbacks.switches)
  } finally { rmSync(projectDir, { recursive: true, force: true }) }
})

// ── (e) torn tail in a SUBAGENT transcript with fallback signatures ───────────
// The subagent scan (scanSubagentFallbacks, exercised via summarizeSessionFile's
// `fallbacks.sub`) is where ~95% of real switches live — a torn subagent tail must
// not lose the intact events.
// MUTATION-PROVED (2026-07-02): same catch-rethrow mutation as test a → RED:
// "SyntaxError: Unterminated string in JSON" out of summarizeSessionFile (the
// throw escapes scanSubagentFallbacks). Restored → green.
test('summarizeSessionFile: torn tail in a subagent transcript — intact fallback events still counted', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'ct-proj-sub-'))
  try {
    const id = '33333333-3333-3333-3333-333333333333'
    // Main transcript: clean, no fallbacks of its own.
    writeFileSync(join(projectDir, `${id}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: '2026-06-12T20:40:00.000Z', cwd: '/repo', message: { content: 'run the swarm' } }),
      entry({ ts: '2026-06-12T20:41:00.000Z', req: 'req_main', model: 'claude-opus-4-8', usage: { ...U0, input_tokens: 10, output_tokens: 5 } }),
    ].join('\n') + '\n')
    // Subagent tree: one direct Task subagent whose transcript carries the full
    // fallback fixture PLUS a torn tail (filename must match /^agent-[0-9a-f]+\.jsonl$/).
    const subDir = join(projectDir, id, 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, 'agent-abc0123def.jsonl'), fallbackLines().join('\n') + '\n' + tornTail())
    const s = summarizeSessionFile(projectDir, id)
    assert.ok(s, 'session summarized')
    assert.ok(s.fallbacks, 'subagent fallbacks surfaced on the session summary')
    assert.deepEqual(s.fallbacks.main, { switches: 0, refusals: 0, sticky: 0 }, 'main chat clean')
    assert.equal(s.fallbacks.sub.switches, 1, 'intact switch counted despite torn tail')
    assert.equal(s.fallbacks.sub.refusals, 1, 'intact refusal counted despite torn tail')
    assert.equal(s.fallbacks.sub.sticky, 1, 'intact sticky turn counted despite torn tail')
    assert.equal(s.fallbacks.sub.agents, 1, 'exactly one affected subagent')
    assert.equal(s.fallbacks.sub.wfAgents, 0, 'direct subagent, not a workflow agent')
    assert.equal(s.fallbacks.switches, 1)
    assert.equal(s.fallbacks.refusals, 1)
    assert.equal(s.fallbacks.from, 'claude-fable-5')
    assert.equal(s.fallbacks.to, 'claude-opus-4-8')
  } finally { rmSync(projectDir, { recursive: true, force: true }) }
})
