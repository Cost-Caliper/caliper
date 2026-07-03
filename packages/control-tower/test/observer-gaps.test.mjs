// test/observer-gaps.test.mjs — hermetic unit tests for observer.mjs internals that the
// env-gated fixture tests (observer.test.mjs) don't cover: readRunScript's traversal
// guard, scanCompletedRuns, resolveSessionDir, parseAgentTranscript's titleChars /
// CONV_CAP / FB_EVENTS_CAP / row:N refusal-dedup / refusalOutputTokens, and watchRuns'
// missing-dir no-op. All fixtures are synthetic, in mkdtemp dirs, and mirror the wire
// shapes documented in test/fallbacks.test.mjs (entry()/U0 helpers copied from there).
//
// watchRuns debounce timing is intentionally UNTESTED (50ms timer → flaky); only the
// missing-dir unsubscribe contract is pinned here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  readRunScript, scanCompletedRuns, resolveSessionDir,
  parseAgentTranscript, watchRuns,
} from '../src/observer.mjs'

// ── transcript helpers (same shapes as test/fallbacks.test.mjs) ───────────────
const U0 = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// over.req omitted → NO requestId AND no message.id (observer falls back to row:N keys)
function entry(over) {
  return JSON.stringify({
    type: 'assistant', timestamp: over.ts,
    ...(over.req ? { requestId: over.req, uuid: over.uuid || over.req } : {}),
    message: {
      model: over.model, stop_reason: over.stop === undefined ? 'end_turn' : over.stop,
      ...(over.stopDetails ? { stop_details: over.stopDetails } : {}),
      content: over.content || [{ type: 'text', text: over.text || 'ok' }],
      usage: over.usage,
    },
  })
}

function userLine(text, ts) {
  return JSON.stringify({ type: 'user', ...(ts ? { timestamp: ts } : {}), message: { content: text } })
}

// ── a) readRunScript: runId regex guard ────────────────────────────────────────
// MUTATION-PROVEN: loosened the guard at src/observer.mjs:56 to /^[0-9a-z_/.-]+$/i →
// the planted workflows/wf_a/b.json was read and returned non-null → RED
// ("'a/b' must be rejected …"). Restored → GREEN.
test('readRunScript: path-like runIds are rejected before any fs access', () => {
  const sess = mkdtempSync(join(tmpdir(), 'ct-runscript-guard-'))
  try {
    // Plant a file that a traversal-permissive guard WOULD find for runId 'a/b':
    // join(sess,'workflows','wf_a/b.json') → workflows/wf_a/b.json.
    mkdirSync(join(sess, 'workflows', 'wf_a'), { recursive: true })
    writeFileSync(join(sess, 'workflows', 'wf_a', 'b.json'),
      JSON.stringify({ workflowName: 'evil', script: 'stolen' }))
    assert.equal(readRunScript('a/b', sess), null, "'a/b' must be rejected by the runId guard (never reads outside wf_<id>.json)")
    assert.equal(readRunScript('../../x', sess), null, "'../../x' must be rejected by the runId guard")
    assert.equal(readRunScript('a b', sess), null, 'whitespace runId rejected')
  } finally { rmSync(sess, { recursive: true, force: true }) }
})

test('readRunScript: happy path returns {name, path, source} from wf_<id>.json', () => {
  const sess = mkdtempSync(join(tmpdir(), 'ct-runscript-ok-'))
  try {
    mkdirSync(join(sess, 'workflows', 'scripts'), { recursive: true })
    // The scripts/<name>-wf_<id>.js file links name↔id for parseRunJson; readRunScript
    // itself reads name/path/source straight out of the run record JSON.
    writeFileSync(join(sess, 'workflows', 'scripts', 'myflow-wf_deadb1.js'), '// saved script')
    writeFileSync(join(sess, 'workflows', 'wf_deadb1.json'), JSON.stringify({
      workflowName: 'myflow', scriptPath: '/saved/myflow-wf_deadb1.js', script: 'export const meta = {}',
    }))
    const got = readRunScript('deadb1', sess)
    assert.deepEqual(got, { name: 'myflow', path: '/saved/myflow-wf_deadb1.js', source: 'export const meta = {}' })
    // name falls back to runId; non-string script → source null
    writeFileSync(join(sess, 'workflows', 'wf_deadb2.json'), JSON.stringify({ script: 42 }))
    assert.deepEqual(readRunScript('deadb2', sess), { name: 'deadb2', path: null, source: null })
    assert.equal(readRunScript('feed99', sess), null, 'missing run file → null')
  } finally { rmSync(sess, { recursive: true, force: true }) }
})

// ── b) scanCompletedRuns ───────────────────────────────────────────────────────
test('scanCompletedRuns: summaries sorted newest-first by timestamp; junk skipped', () => {
  const sess = mkdtempSync(join(tmpdir(), 'ct-scan-'))
  try {
    mkdirSync(join(sess, 'workflows'), { recursive: true })
    const rec = (name, ts) => JSON.stringify({ workflowName: name, status: 'completed', timestamp: ts, agentCount: 0, totalTokens: 5, logs: [] })
    writeFileSync(join(sess, 'workflows', 'wf_aa11.json'), rec('older', '2026-06-01T00:00:00.000Z'))
    writeFileSync(join(sess, 'workflows', 'wf_bb22.json'), rec('newer', '2026-06-02T00:00:00.000Z'))
    // malformed filename (non-hex runId → filename regex /^wf_[0-9a-f-]+\.json$/ skips it)
    writeFileSync(join(sess, 'workflows', 'wf_zz99.json'), rec('nonhex', '2026-06-03T00:00:00.000Z'))
    writeFileSync(join(sess, 'workflows', 'notes.txt'), 'not a run')
    // hex-named but unparseable JSON — must be skipped without throwing
    writeFileSync(join(sess, 'workflows', 'wf_cc33.json'), '{oops')
    const got = scanCompletedRuns(sess)
    assert.deepEqual(got.map((r) => r.runId), ['bb22', 'aa11'], 'newest-first by timestamp; junk excluded')
    assert.equal(got[0].name, 'newer')
    assert.equal(got[0].status, 'completed')
    assert.equal(got[0].source, 'observed-native')
    assert.equal(got[0].totalTokens, 5)
  } finally { rmSync(sess, { recursive: true, force: true }) }
})

test('scanCompletedRuns: missing/empty dirs → []', () => {
  const sess = mkdtempSync(join(tmpdir(), 'ct-scan-empty-'))
  try {
    assert.deepEqual(scanCompletedRuns(join(sess, 'nope')), [], 'missing sessDir')
    assert.deepEqual(scanCompletedRuns(sess), [], 'sessDir without workflows/')
    mkdirSync(join(sess, 'workflows'))
    assert.deepEqual(scanCompletedRuns(sess), [], 'empty workflows dir')
    assert.deepEqual(scanCompletedRuns(null), [], 'null sessDir')
  } finally { rmSync(sess, { recursive: true, force: true }) }
})

// ── c) resolveSessionDir ───────────────────────────────────────────────────────
test('resolveSessionDir: WFLENS_SESSION_DIR honored; otherwise null (no auto-derive)', () => {
  const prev = process.env.WFLENS_SESSION_DIR
  try {
    process.env.WFLENS_SESSION_DIR = '/tmp/some-session-dir'
    assert.equal(resolveSessionDir(), '/tmp/some-session-dir')
    delete process.env.WFLENS_SESSION_DIR
    assert.equal(resolveSessionDir(), null, 'documented fallback: null, never a guessed path')
  } finally {
    if (prev === undefined) delete process.env.WFLENS_SESSION_DIR
    else process.env.WFLENS_SESSION_DIR = prev
  }
})

// ── d) parseAgentTranscript titleChars + '<'-skip ─────────────────────────────
test('parseAgentTranscript titleChars: truncates title; harness "<" openers skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-title-'))
  try {
    const path = join(dir, 'agent-atitle01.jsonl')
    writeFileSync(path, [
      // main-session transcripts often open with harness tag blocks — not a human title
      userLine('<local-command-caveat>injected harness block', '2026-06-12T20:40:00.000Z'),
      userLine('Summarize the quarterly report thoroughly', '2026-06-12T20:40:01.000Z'),
      entry({ ts: '2026-06-12T20:41:00.000Z', req: 'req_1', model: 'claude-opus-4-8', usage: { ...U0, input_tokens: 10, output_tokens: 5 } }),
    ].join('\n') + '\n')
    const light = parseAgentTranscript(path, { light: true, titleChars: 10 })
    // title = first user message NOT starting with '<', truncated slice(0,10)+'…'
    assert.equal(light.task, 'Summarize …', 'title skips the "<"-opener and truncates at titleChars')
    // titleChars=0 (light default) → task suppressed entirely
    assert.equal(parseAgentTranscript(path, { light: true }).task, null)
    // full mode: task = the FIRST user message verbatim (even a harness tag block)
    const full = parseAgentTranscript(path)
    assert.equal(full.task, '<local-command-caveat>injected harness block')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── e) CONV_CAP=500 conversation trim ─────────────────────────────────────────
test('parseAgentTranscript: conversation keeps LAST 500 texts, droppedTurns reports the cut', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-convcap-'))
  try {
    const path = join(dir, 'agent-acap01.jsonl')
    const lines = []
    for (let i = 0; i < 260; i++) { // 260 user + 260 assistant = 520 conversation texts
      lines.push(userLine(`u${i}`))
      lines.push(entry({ req: `req_${i}`, model: 'claude-opus-4-8', text: `a${i}`, usage: { ...U0, input_tokens: 1, output_tokens: 1 } }))
    }
    writeFileSync(path, lines.join('\n') + '\n')
    const p = parseAgentTranscript(path)
    assert.equal(p.droppedTurns, 20, '520 texts − CONV_CAP 500 = 20 dropped')
    assert.equal(p.conversation.length, 500, 'conversation capped at 500')
    assert.equal(p.conversation[0].text, 'u10', 'oldest texts dropped (kept the LAST 500)')
    assert.equal(p.conversation[499].text, 'a259', 'most recent turn retained')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── f) FB_EVENTS_CAP=20 ────────────────────────────────────────────────────────
// MUTATION-PROVEN: removed the cap at src/observer.mjs:393 (fb.events.length <
// FB_EVENTS_CAP → true) → events.length was 25 → RED ("events array capped at 20").
// Restored → GREEN.
test('parseAgentTranscript: fallback events capped at 20, counts stay full', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-fbcap-'))
  try {
    const path = join(dir, 'agent-afbcap01.jsonl')
    const lines = [userLine('do a thing', '2026-06-12T20:40:00.000Z')]
    for (let i = 0; i < 25; i++) {
      lines.push(entry({
        ts: `2026-06-12T20:41:${String(i).padStart(2, '0')}.000Z`, req: `req_r${i}`,
        model: 'claude-fable-5', stop: 'refusal',
        stopDetails: { type: 'refusal', category: null, explanation: null },
        content: [{ type: 'thinking', thinking: 'declining' }],
        usage: { ...U0, input_tokens: 100, output_tokens: 10 },
      }))
    }
    writeFileSync(path, lines.join('\n') + '\n')
    const p = parseAgentTranscript(path)
    assert.equal(p.fallbacks.refusals, 25, 'refusal COUNT is not capped')
    assert.equal(p.fallbacks.events.length, 20, 'events array capped at 20 (FB_EVENTS_CAP)')
    assert.equal(p.fallbacks.refusalOutputTokens, 250, 'billed partials summed past the event cap')
    assert.equal(p.fallbacks.categories.unspecified, 25, 'category tally not capped either')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── g) refusal dedup key falls back to row:N when there is no requestId ───────
// MUTATION-PROVEN: broke the fallback key at src/observer.mjs:384 (`row:${assistantTurns}`
// → 'row:0') → the two distinct no-requestId refusals collapsed to 1 → RED ("two distinct
// refusal rows without requestIds each count"). Restored → GREEN.
test('parseAgentTranscript: refusals without requestId dedup per-row (row:N key)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-noreq-'))
  try {
    const path = join(dir, 'agent-anoreq01.jsonl')
    const refusal = (ts, out) => entry({
      ts, model: 'claude-fable-5', stop: 'refusal', // no req → no requestId, no msg.id
      stopDetails: { type: 'refusal', category: null, explanation: null },
      content: [{ type: 'thinking', thinking: 'x' }],
      usage: { ...U0, input_tokens: 100, output_tokens: out },
    })
    writeFileSync(path, [
      userLine('hi', '2026-06-12T20:40:00.000Z'),
      refusal('2026-06-12T20:41:00.000Z', 40),
      refusal('2026-06-12T20:42:00.000Z', 60),
    ].join('\n') + '\n')
    const p = parseAgentTranscript(path)
    assert.equal(p.fallbacks.refusals, 2, 'two distinct refusal rows without requestIds each count')
    // each physical row gets ONE row:N key — a single row can never self-double-count
    assert.equal(p.fallbacks.events.length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── h) refusalOutputTokens accumulates across refusals ────────────────────────
test('parseAgentTranscript: refusalOutputTokens sums billed partials across refusals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-reftok-'))
  try {
    const path = join(dir, 'agent-areftok01.jsonl')
    const refusal = (ts, req, out) => entry({
      ts, req, model: 'claude-fable-5', stop: 'refusal',
      stopDetails: { type: 'refusal', category: null, explanation: null },
      content: [{ type: 'thinking', thinking: 'x' }],
      usage: { ...U0, input_tokens: 100, output_tokens: out },
    })
    writeFileSync(path, [
      userLine('hi', '2026-06-12T20:40:00.000Z'),
      refusal('2026-06-12T20:41:00.000Z', 'req_a', 357),
      entry({ ts: '2026-06-12T20:42:00.000Z', req: 'req_ok', model: 'claude-fable-5', text: 'fine', usage: { ...U0, input_tokens: 50, output_tokens: 500 } }),
      refusal('2026-06-12T20:43:00.000Z', 'req_b', 90),
    ].join('\n') + '\n')
    const p = parseAgentTranscript(path)
    assert.equal(p.fallbacks.refusals, 2)
    assert.equal(p.fallbacks.refusalOutputTokens, 447, '357 + 90; the clean turn does not leak in')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ── i) watchRuns: missing dir is a no-op with a working unsubscribe ───────────
test('watchRuns: missing dirs return a callable no-op unsubscribe', () => {
  const sess = mkdtempSync(join(tmpdir(), 'ct-watch-'))
  try {
    const unsub1 = watchRuns(join(sess, 'does-not-exist'), () => { throw new Error('must not fire') })
    assert.equal(typeof unsub1, 'function')
    unsub1() // must not throw
    // sessDir exists but has no workflows/ subdir — same contract
    const unsub2 = watchRuns(sess, () => { throw new Error('must not fire') })
    assert.equal(typeof unsub2, 'function')
    unsub2()
    const unsub3 = watchRuns(null, () => {})
    unsub3()
  } finally { rmSync(sess, { recursive: true, force: true }) }
})
