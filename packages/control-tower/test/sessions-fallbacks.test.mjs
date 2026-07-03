// test/sessions-fallbacks.test.mjs — the LAUNCH NUMBER: summary.fallbacks rollup on
// summarizeSessionFile, including scanSubagentFallbacks (the subagent-transcript scan).
//
// The "switched off Fable N times" stat is main-transcript fallbacks PLUS a scan of
// every subagents/agent-*.jsonl AND subagents/workflows/wf_*/agent-*.jsonl (the
// workflow fan-out is where ~95% of real switches live — 71 of 78 in the measured
// machine scan). These tests pin: the wfDir walk, the direct walk, the main/sub
// split ("numbers must add up" banner invariant), key omission on clean sessions,
// the FB_SIG_RE pre-filter, category merging, and from/to propagation + defaults.
//
// Wire shapes are copied from test/fallbacks.test.mjs (real transcripts, 2026-07-02):
// bare refusal / fallback-block switch / sticky turn. Fixtures are per-test mkdtemp
// dirs (distinct paths, so the (mtime,size) summary cache can never cross-talk).

import './_env.mjs' // MUST be first: sandboxes HOME before sessions.mjs computes its disk-cache path

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { summarizeSessionFile } from '../src/sessions.mjs'

const U0 = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// Same assistant-entry builder as test/fallbacks.test.mjs (real wire shape).
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
const uLine = (ts, text) =>
  JSON.stringify({ type: 'user', timestamp: ts, cwd: '/repo', message: { role: 'user', content: text } })
const cleanRow = (ts, req) =>
  entry({ ts, req, model: 'claude-fable-5', text: 'plain work, nothing to see', usage: { ...U0, input_tokens: 100, output_tokens: 20 } })

// The three real fallback signatures (see fallbacks.test.mjs header).
const refusalRow = (ts, req, category = null) => entry({
  ts, req, model: 'claude-fable-5', stop: 'refusal',
  stopDetails: { type: 'refusal', category, explanation: null, fallback_has_prefill_claim: true },
  content: [{ type: 'thinking', thinking: 'hmm' }],
  usage: { ...U0, input_tokens: 685, output_tokens: 357 },
})
const switchRow = (ts, req, to = 'claude-opus-4-8') => entry({
  ts, req, model: to,
  content: [
    { type: 'fallback', from: { model: 'claude-fable-5' }, to: { model: to } },
    { type: 'text', text: 'continuing on the other model' },
  ],
  usage: { ...U0, input_tokens: 2000, output_tokens: 200, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: to }] },
})
const stickyRow = (ts, req, to = 'claude-opus-4-8') => entry({
  ts, req, model: to, text: 'still routed elsewhere',
  usage: { ...U0, input_tokens: 3000, output_tokens: 300, iterations: [{ type: 'message', model: 'claude-fable-5' }, { type: 'fallback_message', model: to }] },
})

// Valid session uuids (SESSION_ID_RE) — one per test so cache paths never collide.
const SID = (n) => `${String(n).padStart(8, '0')}-1111-4222-8333-444455556666`

// Session fixture: <proj>/<uuid>.jsonl + <proj>/<uuid>/subagents/agent-*.jsonl
// + <proj>/<uuid>/subagents/workflows/wf_*/agent-*.jsonl (the real on-disk layout).
function makeSession(proj, id, { main, direct = {}, wf = {} }) {
  writeFileSync(join(proj, `${id}.jsonl`), main.join('\n') + '\n')
  const sessDir = join(proj, id)
  for (const [name, lines] of Object.entries(direct)) {
    mkdirSync(join(sessDir, 'subagents'), { recursive: true })
    writeFileSync(join(sessDir, 'subagents', name), lines.join('\n') + '\n')
  }
  for (const [wfName, files] of Object.entries(wf)) {
    const d = join(sessDir, 'subagents', 'workflows', wfName)
    mkdirSync(d, { recursive: true })
    for (const [name, lines] of Object.entries(files)) writeFileSync(join(d, name), lines.join('\n') + '\n')
  }
}
const cleanMain = [uLine('2026-06-12T20:40:00.000Z', 'do the thing'), cleanRow('2026-06-12T20:41:00.000Z', 'req_main1')]

// MUTATION-PROVED (a): delete the wfDir walk in collectSubagentTranscripts
// (sessions.mjs:87-94) → "workflow fan-out switch counted: 1 !== 0" RED.
// This is the exact 71-of-78 miss the handoff documents.
test('workflow fan-out transcripts (subagents/workflows/wf_*/agent-*.jsonl) ARE counted', () => {
  const proj = mkdtempSync(join(tmpdir(), 'ct-sfb-wf-'))
  try {
    const id = SID(1)
    makeSession(proj, id, {
      main: cleanMain,
      wf: { wf_fanout1: { 'agent-bbbb2222.jsonl': [
        uLine('2026-06-12T20:42:00.000Z', 'sub task'),
        switchRow('2026-06-12T20:43:00.000Z', 'req_sw1'),
        stickyRow('2026-06-12T20:44:00.000Z', 'req_st1'),
      ] } },
    })
    const s = summarizeSessionFile(proj, id)
    assert.ok(s && s.fallbacks, 'fallbacks rollup present when only a workflow subagent switched')
    assert.equal(s.fallbacks.switches, 1, 'workflow fan-out switch counted')
    assert.equal(s.fallbacks.sticky, 1, 'workflow fan-out sticky turn counted')
    assert.equal(s.fallbacks.sub.switches, 1, 'attributed to the sub layer')
    assert.equal(s.fallbacks.sub.wfAgents, 1, 'recognized as a workflow-dir transcript')
    assert.equal(s.fallbacks.main.switches, 0, 'main stays clean')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

// MUTATION-PROVED (b): make the wfAgents attribution unconditional in
// scanSubagentFallbacks (sessions.mjs:109, drop the '/subagents/workflows/' check)
// → "wfAgents counts ONLY workflow-dir transcripts: 2 !== 1" RED.
test('direct subagents count too; sub.agents = transcripts with events, sub.wfAgents = workflow-dir only', () => {
  const proj = mkdtempSync(join(tmpdir(), 'ct-sfb-mix-'))
  try {
    const id = SID(2)
    makeSession(proj, id, {
      main: cleanMain,
      direct: { 'agent-aaaa1111.jsonl': [
        uLine('2026-06-12T20:42:00.000Z', 'direct sub task'),
        refusalRow('2026-06-12T20:43:00.000Z', 'req_ref1', 'cyber'),
      ] },
      wf: { wf_fanout1: { 'agent-bbbb2222.jsonl': [
        uLine('2026-06-12T20:42:30.000Z', 'wf sub task'),
        switchRow('2026-06-12T20:44:00.000Z', 'req_sw1'),
      ] } },
    })
    const s = summarizeSessionFile(proj, id)
    assert.ok(s.fallbacks, 'fallbacks present')
    assert.equal(s.fallbacks.sub.refusals, 1, 'direct subagent refusal counted')
    assert.equal(s.fallbacks.sub.switches, 1, 'workflow subagent switch counted')
    assert.equal(s.fallbacks.sub.agents, 2, 'both transcripts with events counted as agents')
    assert.equal(s.fallbacks.sub.wfAgents, 1, 'wfAgents counts ONLY workflow-dir transcripts')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

// MUTATION-PROVED (c): double-add the sub counts in the summarizeSessionFile rollup
// (sessions.mjs:161, switches: main.switches + subN.switches * 2)
// → "banner invariant: main + sub === total: 3 !== 4" RED.
test('main vs sub split is exact and (main + sub) === total (banner invariant)', () => {
  const proj = mkdtempSync(join(tmpdir(), 'ct-sfb-split-'))
  try {
    const id = SID(3)
    makeSession(proj, id, {
      main: [
        uLine('2026-06-12T20:40:00.000Z', 'main ask'),
        cleanRow('2026-06-12T20:41:00.000Z', 'req_main1'),
        refusalRow('2026-06-12T20:41:30.000Z', 'req_mref1'),
      ],
      wf: { wf_x1: { 'agent-cccc3333.jsonl': [
        uLine('2026-06-12T20:42:00.000Z', 'sub ask'),
        switchRow('2026-06-12T20:43:00.000Z', 'req_sw1'),
        refusalRow('2026-06-12T20:43:30.000Z', 'req_sref1'),
      ] } },
    })
    const s = summarizeSessionFile(proj, id)
    const fb = s.fallbacks
    assert.ok(fb, 'fallbacks present')
    assert.deepEqual({ sw: fb.main.switches, rf: fb.main.refusals }, { sw: 0, rf: 1 }, 'main split correct')
    assert.deepEqual({ sw: fb.sub.switches, rf: fb.sub.refusals }, { sw: 1, rf: 1 }, 'sub split correct')
    assert.equal(
      (fb.main.switches + fb.main.refusals) + (fb.sub.switches + fb.sub.refusals),
      fb.switches + fb.refusals,
      'banner invariant: main + sub === total',
    )
    assert.equal(fb.main.sticky + fb.sub.sticky, fb.sticky, 'sticky adds up too')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

// MUTATION-PROVED (d): remove the zero-total early return in summarizeSessionFile
// (sessions.mjs:162) → "clean sessions carry NO fallbacks key" RED (key present with zeros).
test('clean session (no subagents dir, clean main) has NO fallbacks key at all', () => {
  const proj = mkdtempSync(join(tmpdir(), 'ct-sfb-clean-'))
  try {
    const id = SID(4)
    makeSession(proj, id, { main: cleanMain })
    const s = summarizeSessionFile(proj, id)
    assert.ok(s, 'summary produced')
    assert.equal(s.turns, 1, 'sanity: transcript parsed')
    assert.equal('fallbacks' in s, false, 'clean sessions carry NO fallbacks key')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

// MUTATION-PROVED (e): break FB_SIG_RE (sessions.mjs:75) to a never-matching /$^/ —
// i.e. the pre-filter regex drifts away from the real wire signatures — →
// "switch behind the pre-filter still counted: 0 !== 1" RED.
// NOTE (verified empirically, see structured notes): DELETING the gate changes no
// counts — a signatureless transcript light-parses to fallbacks:null and is skipped
// by the fb check anyway. The gate is purely a perf pre-filter; what this test
// guards is (1) signatureless files add nothing / don't crash and (2) the regex
// still matches all three real signatures so gated files aren't dropped.
test('signatureless subagent transcripts are skipped cleanly; signature-bearing ones still count', () => {
  const proj = mkdtempSync(join(tmpdir(), 'ct-sfb-gate-'))
  try {
    const id = SID(5)
    makeSession(proj, id, {
      main: cleanMain,
      direct: { 'agent-dddd4444.jsonl': [ // no refusal/fallback signature anywhere
        uLine('2026-06-12T20:42:00.000Z', 'plain sub task'),
        cleanRow('2026-06-12T20:42:30.000Z', 'req_plain1'),
      ] },
      wf: { wf_g1: { 'agent-eeee5555.jsonl': [
        uLine('2026-06-12T20:43:00.000Z', 'sub ask'),
        switchRow('2026-06-12T20:44:00.000Z', 'req_sw1'),
      ] } },
    })
    const s = summarizeSessionFile(proj, id)
    assert.ok(s.fallbacks, 'fallbacks present')
    assert.equal(s.fallbacks.switches, 1, 'switch behind the pre-filter still counted')
    assert.equal(s.fallbacks.sub.agents, 1, 'signatureless transcript contributes no agent')
    assert.equal(s.fallbacks.refusals, 0, 'signatureless transcript adds nothing')

    // A session whose ONLY subagent is signatureless stays fallback-free entirely.
    const id2 = SID(6)
    makeSession(proj, id2, {
      main: cleanMain,
      direct: { 'agent-ffff6666.jsonl': [
        uLine('2026-06-12T20:42:00.000Z', 'plain'),
        cleanRow('2026-06-12T20:42:30.000Z', 'req_p2'),
      ] },
    })
    const s2 = summarizeSessionFile(proj, id2)
    assert.equal('fallbacks' in s2, false, 'signatureless-only session has no fallbacks key')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

// MUTATION-PROVED (f): overwrite instead of add in the summary categories merge
// (sessions.mjs:164, categories[k] = v) → "cyber category merged across main + sub:
// 1 !== 2" RED. Also proves from/to come from the transcripts, not the defaults:
// the sub switch targets claude-sonnet-4-6 and the summary must carry THAT.
test('categories merge across main + sub; from/to propagate from the transcripts', () => {
  const proj = mkdtempSync(join(tmpdir(), 'ct-sfb-cats-'))
  try {
    const id = SID(7)
    makeSession(proj, id, {
      main: [
        uLine('2026-06-12T20:40:00.000Z', 'main ask'),
        refusalRow('2026-06-12T20:41:00.000Z', 'req_mref1', 'cyber'),
      ],
      direct: { 'agent-abab1212.jsonl': [
        uLine('2026-06-12T20:42:00.000Z', 'sub ask'),
        refusalRow('2026-06-12T20:43:00.000Z', 'req_sref1', 'cyber'),
        refusalRow('2026-06-12T20:43:30.000Z', 'req_sref2', null), // null category → 'unspecified'
        switchRow('2026-06-12T20:44:00.000Z', 'req_sw1', 'claude-sonnet-4-6'),
      ] },
    })
    const s = summarizeSessionFile(proj, id)
    const fb = s.fallbacks
    assert.ok(fb, 'fallbacks present')
    assert.equal(fb.categories.cyber, 2, 'cyber category merged across main + sub')
    assert.equal(fb.categories.unspecified, 1, 'uncategorized refusal bucketed')
    assert.equal(fb.from, 'claude-fable-5', 'from propagated from the switch block')
    assert.equal(fb.to, 'claude-sonnet-4-6', 'to propagated from the transcript, not the default')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

// MUTATION-PROVED (g): change the default to-model literal in summarizeSessionFile
// (sessions.mjs:168, 'claude-opus-4-8' → 'claude-opus-9-9') → "to defaults to
// claude-opus-4-8" RED. Refusal-only sessions carry no switch block, so from/to
// must fall back to the canonical pair.
test('refusal-only session falls back to canonical from/to defaults', () => {
  const proj = mkdtempSync(join(tmpdir(), 'ct-sfb-def-'))
  try {
    const id = SID(8)
    makeSession(proj, id, {
      main: [
        uLine('2026-06-12T20:40:00.000Z', 'main ask'),
        refusalRow('2026-06-12T20:41:00.000Z', 'req_mref1'),
      ],
    })
    const s = summarizeSessionFile(proj, id)
    assert.ok(s.fallbacks, 'fallbacks present')
    assert.equal(s.fallbacks.refusals, 1)
    assert.equal(s.fallbacks.from, 'claude-fable-5', 'from defaults to claude-fable-5')
    assert.equal(s.fallbacks.to, 'claude-opus-4-8', 'to defaults to claude-opus-4-8')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})
