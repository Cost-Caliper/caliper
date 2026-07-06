// test/fable-evidence.test.mjs — src/fable-evidence.mjs: the two-phase evidence
// gatherer behind the `distill-fable` skill (skills/distill-fable/SKILL.md). Fable is
// being removed from Claude Code; this finds every place it was genuinely the author
// of an assistant turn — main sessions OR subagents, anywhere on the machine — so a
// later live Workflow run can have Fable introspect on its own real past work before
// it's gone.
//
// gatherFableEvidence() transitively calls summarizeSessionFile() (src/sessions.mjs),
// which reads/writes a disk cache keyed off homedir() — per AGENTS.md rule 5, sandbox
// HOME by importing test/_env.mjs FIRST, same as every other test touching sessions.mjs.
//
// Real wire shapes (assistant/user lines, fallback content blocks, subagent meta.json)
// copied from test/sessions.test.mjs / test/subagents.test.mjs / test/fallbacks.test.mjs.

import './_env.mjs' // FIRST: sandbox HOME (sessions.mjs's disk cache)
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatherFableEvidence } from '../src/fable-evidence.mjs'

function ts(sec) { return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString() }
function user(tArr, text) {
  return JSON.stringify({ type: 'user', timestamp: tArr, message: { role: 'user', content: [{ type: 'text', text }] } })
}
// bigUsage: makes an opus turn dominate cost over tiny fable turns in the SAME
// transcript, so a real fallback-affected session's dominant tier resolves to opus
// even though it genuinely started on Fable — exactly the case per-turn attribution
// (not session-level tier) has to handle correctly.
function assistant(tArr, { model = 'claude-fable-5', text = 'ok', content, big = false } = {}) {
  const usage = big
    ? { input_tokens: 200000, output_tokens: 40000 }
    : { input_tokens: 500, output_tokens: 100 }
  return JSON.stringify({
    type: 'assistant', timestamp: tArr, cwd: '/repo', gitBranch: 'main',
    message: { role: 'assistant', model, usage, content: content || [{ type: 'text', text }] },
  })
}
// A real fallback content block, matching the shape test/fallbacks.test.mjs documents.
function fallbackBlock(from, to) { return { type: 'fallback', from: { model: from }, to: { model: to } } }

function makeProjectsRoot() { return mkdtempSync(join(tmpdir(), 'ct-fableevidence-')) }

// ── fixture 1: a PURE fable main session, no subagents, no fallback ────────────────
function pureFableSession(root, slug, id) {
  const projectDir = join(root, slug)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${id}.jsonl`), [
    user(ts(0), 'help me refactor this'),
    assistant(ts(1), { model: 'claude-fable-5', text: 'fable turn one: scope the change narrowly' }),
    user(ts(2), 'ok go'),
    assistant(ts(3), { model: 'claude-fable-5', text: 'fable turn two: verify the test still passes before moving on' }),
  ].join('\n'))
  return { projectDir, id }
}

// ── fixture 2: a session that STARTS on fable, then genuinely falls back to opus ──
// dominant tier resolves to OPUS (big usage on the opus turn), but fallbacks.from must
// still be claude-fable-5 — this is the shortlist's fallback-based inclusion path.
function fallbackSession(root, slug, id) {
  const projectDir = join(root, slug)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${id}.jsonl`), [
    user(ts(0), 'do something sensitive-sounding'),
    assistant(ts(1), { model: 'claude-fable-5', text: 'fable turn: here is my careful plan for this' }),
    assistant(ts(2), { model: 'claude-fable-5', text: 'fable turn: a second genuine fable turn before the switch' }),
    assistant(ts(3), { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'switching now' }, fallbackBlock('claude-fable-5', 'claude-opus-4-8')] }),
    assistant(ts(4), { model: 'claude-opus-4-8', text: 'opus turn AFTER the switch: this must never be attributed to fable', big: true }),
  ].join('\n'))
  return { projectDir, id }
}

// ── fixture 3: a plain non-fable session — must be excluded entirely ─────────────
function plainSession(root, slug, id) {
  const projectDir = join(root, slug)
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, `${id}.jsonl`), [
    user(ts(0), 'normal sonnet task'),
    assistant(ts(1), { model: 'claude-sonnet-4-6', text: 'sonnet turn, nothing to do with fable' }),
  ].join('\n'))
  return { projectDir, id }
}

// ── fixture 4: a non-fable MAIN session with a fable SUBAGENT nested under it ─────
// Per sessions.mjs's own comment, most real fable usage lives in subagents, not main.
function fableSubagentSession(root, slug, id) {
  const projectDir = join(root, slug)
  const sessDir = join(projectDir, id)
  mkdirSync(join(sessDir, 'subagents'), { recursive: true })
  writeFileSync(join(projectDir, `${id}.jsonl`), [
    user(ts(0), 'go explore the repo'),
    assistant(ts(1), { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'spawning an explorer' }, { type: 'tool_use', id: 'tA', name: 'Agent', input: { description: 'explore', model: 'claude-fable-5' } }] }),
  ].join('\n'))
  writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'explore', toolUseId: 'tA' }))
  writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.jsonl'), [
    user(ts(2), 'find the config'),
    assistant(ts(3), { model: 'claude-fable-5', text: 'fable subagent turn: found it in config/app.yml, checking every caller before changing it' }),
  ].join('\n'))
  return { projectDir, id }
}

// ── evidence set inclusion/exclusion ────────────────────────────────────────────
test('gatherFableEvidence: includes a pure fable session, excludes a plain non-fable session', () => {
  const root = makeProjectsRoot()
  try {
    pureFableSession(root, '-proj-a', '11111111-1111-4111-8111-111111111111')
    plainSession(root, '-proj-a', '22222222-2222-4222-8222-222222222222')
    const { excerpts, manifest } = gatherFableEvidence(root)
    assert.ok(excerpts.every((e) => e.text.includes('fable turn')), 'no excerpt from the plain session must appear')
    assert.equal(excerpts.length, 2, 'both genuine fable turns from the pure-fable session must be kept')
    assert.equal(manifest.sessionsScanned, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// MUTATION-PROVED: changed the per-turn filter from `tierFromModel(event.model) ===
// 'fable'` to checking the SESSION's dominant tier instead -> RED: the post-switch
// opus turn ("this must never be attributed to fable") leaked into the excerpts, and
// the count went from 2 to 3. Restored -> GREEN.
test('gatherFableEvidence: per-turn attribution — a fallback session contributes ONLY its genuine fable turns, never the post-switch opus turn', () => {
  const root = makeProjectsRoot()
  try {
    fallbackSession(root, '-proj-b', '33333333-3333-4333-8333-333333333333')
    const { excerpts } = gatherFableEvidence(root)
    assert.equal(excerpts.length, 2, 'exactly the two pre-switch fable turns, not the switch row or the post-switch opus turn')
    assert.ok(excerpts.every((e) => e.text.startsWith('fable turn')), 'every kept excerpt must be a genuine fable turn')
    assert.ok(!excerpts.some((e) => e.text.includes('must never be attributed')), 'the post-switch opus turn must never appear')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gatherFableEvidence: a session is shortlisted via fallbacks.from even when its DOMINANT tier is opus', () => {
  const root = makeProjectsRoot()
  try {
    fallbackSession(root, '-proj-b', '33333333-3333-4333-8333-333333333333')
    const { excerpts } = gatherFableEvidence(root)
    assert.ok(excerpts.length > 0, 'the fallback session must be found even though its dominant cost/tier is opus')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gatherFableEvidence: finds a fable SUBAGENT nested under a non-fable main session', () => {
  const root = makeProjectsRoot()
  try {
    fableSubagentSession(root, '-proj-c', '44444444-4444-4444-8444-444444444444')
    const { excerpts } = gatherFableEvidence(root)
    assert.equal(excerpts.length, 1)
    assert.match(excerpts[0].text, /found it in config\/app\.yml/)
    assert.equal(excerpts[0].sessionId, '44444444-4444-4444-8444-444444444444')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gatherFableEvidence: excerpts carry citation metadata (sessionId, projectSlug, ts, tools)', () => {
  const root = makeProjectsRoot()
  try {
    pureFableSession(root, '-proj-a', '11111111-1111-4111-8111-111111111111')
    const { excerpts } = gatherFableEvidence(root)
    const e = excerpts[0]
    assert.equal(e.projectSlug, '-proj-a')
    assert.equal(e.sessionId, '11111111-1111-4111-8111-111111111111')
    assert.ok(e.ts)
    assert.ok(Array.isArray(e.tools))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gatherFableEvidence: empty projects root yields an empty (not thrown) result', () => {
  const root = makeProjectsRoot()
  try {
    const { excerpts, manifest } = gatherFableEvidence(root)
    assert.deepEqual(excerpts, [])
    assert.equal(manifest.sessionsScanned, 0)
    assert.equal(manifest.projectsScanned, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gatherFableEvidence: a nonexistent projects root yields an empty result, never throws', () => {
  const { excerpts, manifest } = gatherFableEvidence('/no/such/projects/root/at/all')
  assert.deepEqual(excerpts, [])
  assert.equal(manifest.sessionsScanned, 0)
})

// ── bounded sampling ────────────────────────────────────────────────────────────
// MUTATION-PROVED: removed the `.slice(0, maxExcerpts)` cap entirely -> RED: kept
// count was 5 (every excerpt found), not the configured cap of 2. Restored -> GREEN.
test('gatherFableEvidence: caps total excerpts at maxExcerpts, preferring the longest (most substantive) turns', () => {
  const root = makeProjectsRoot()
  try {
    const projectDir = join(root, '-proj-cap')
    mkdirSync(projectDir, { recursive: true })
    const id = '55555555-5555-4555-8555-555555555555'
    const lines = [user(ts(0), 'go')]
    const lengths = [50, 500, 100, 300, 200]
    lengths.forEach((n, i) => {
      lines.push(assistant(ts(i + 1), { model: 'claude-fable-5', text: `fable turn ${i}: ` + 'x'.repeat(n) }))
    })
    writeFileSync(join(projectDir, `${id}.jsonl`), lines.join('\n'))

    const { excerpts, manifest } = gatherFableEvidence(root, { maxExcerpts: 2 })
    assert.equal(excerpts.length, 2, 'must respect the configured cap')
    assert.equal(manifest.excerptsFound, 5)
    assert.equal(manifest.excerptsKept, 2)
    // The two LONGEST turns (500 and 300 extra chars) must be the ones kept.
    assert.ok(excerpts.every((e) => e.text.includes('turn 1') || e.text.includes('turn 3')), 'must keep the most substantive turns, not the first-encountered ones')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('gatherFableEvidence: manifest reports projectsScanned/sessionsScanned/dateRange honestly', () => {
  const root = makeProjectsRoot()
  try {
    pureFableSession(root, '-proj-a', '11111111-1111-4111-8111-111111111111')
    fableSubagentSession(root, '-proj-c', '44444444-4444-4444-8444-444444444444')
    const { manifest } = gatherFableEvidence(root)
    assert.equal(manifest.projectsScanned, 2)
    assert.equal(manifest.sessionsScanned, 2)
    assert.ok(manifest.dateRange && manifest.dateRange.from && manifest.dateRange.to)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
