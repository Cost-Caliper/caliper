// test/subagents-edges.test.mjs — Subagents view edge paths not covered by
// subagents.test.mjs: the MAX_DEPTH_GUARD parent-chain cap, first-wins duplicate
// tool_use ownership, MAIN-transcript-absent forests, spawnMeta label/model
// fallbacks into light nodes, degenerate wallSpanMs, and the plain-object
// (non-Map) ownerOfToolUse branch. Keyless; synthetic temp-dir fixtures only.
// (No sessions.mjs in the import chain, so test/_env.mjs is not required here.)

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildForest, scanSubagentTree, MAIN_SESSION } from '../src/subagents.mjs'

// ── shared helpers (mirroring subagents.test.mjs) ─────────────────────────────
const node = (id, parentToolUseId, extra = {}) => ({
  agentId: id, agentType: 'general-purpose', description: id, parentToolUseId,
  model: 'claude-sonnet-4-6', tier: 'sonnet', tokens: { in: 10, out: 2, cacheWr: 0, cacheRd: 0 },
  costUsd: 0.001, ms: 1000, startedAt: '2026-06-01T00:00:00.000Z', startedAtMs: 1000, toolCalls: 1,
  tools: ['Bash'], turns: 1, status: 'done', ...extra,
})

function ts(sec) { return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString() }
function assistant(t, content, model = 'claude-sonnet-4-6') {
  const message = { role: 'assistant', usage: { input_tokens: 100, output_tokens: 20 }, content }
  if (model != null) message.model = model // model omitted when null → parsed.model stays null
  return JSON.stringify({ type: 'assistant', timestamp: t, cwd: '/repo', gitBranch: 'main', message })
}
function user(t, content) {
  return JSON.stringify({ type: 'user', timestamp: t, message: { role: 'user', content } })
}
function spawnBlock(id, desc) { return { type: 'tool_use', id, name: 'Agent', input: { description: desc, model: 'claude-haiku-4-5' } } }

// ── (a) MAX_DEPTH_GUARD caps a runaway parent chain ───────────────────────────
// A 250-deep parent chain (longer than the 200-hop guard): the walk breaks the
// chain at the node whose chain exceeds the guard (re-homed under MAIN as an
// orphan) instead of walking forever. Nodes past the break re-attach to the
// re-homed node, so the resulting maxDepth is exactly MAX_DEPTH_GUARD (200).
// MUTATION-PROVED: src/subagents.mjs:24 `MAX_DEPTH_GUARD = 200` → `= 1e9`
// (guard effectively removed) ⇒ maxDepth becomes 250 and orphanCount 0 → RED
// on both assertions (fails fast — no hang; the chain itself is acyclic).
test('buildForest: parent chain longer than MAX_DEPTH_GUARD is broken, depth capped at 200', () => {
  const N = 250
  const subs = []
  const owner = new Map()
  for (let i = 0; i < N; i++) {
    subs.push(node(`n${i}`, `t${i}`))
    owner.set(`t${i}`, i === 0 ? MAIN_SESSION : `n${i - 1}`)
  }
  const { index, rollup } = buildForest(subs, owner)
  assert.equal(rollup.totalSubagents, N)
  // n199 has a 200-hop chain (allowed); n200's 201-hop chain trips the guard.
  assert.equal(rollup.maxDepth, 200, 'depth capped at MAX_DEPTH_GUARD')
  assert.equal(index.get('n199').depth, 200)
  const broken = index.get('n200')
  assert.equal(broken.orphan, true, 'guard-tripped node re-homed as orphan')
  assert.equal(broken.parentAgentId, MAIN_SESSION)
  assert.equal(broken.depth, 1)
  // once n200 is re-homed, its descendants' chains are short again — not orphaned
  assert.equal(index.get('n201').orphan, false)
  assert.equal(index.get('n201').parentAgentId, 'n200')
  assert.equal(index.get('n249').depth, 50) // 249 sits 49 below the re-homed n200
  assert.equal(rollup.orphanCount, 1)
  // every node attached exactly once
  const attached = new Set()
  const walk = (n) => { assert.ok(!attached.has(n.agentId)); attached.add(n.agentId); n.children.forEach(walk) }
  walk(index.get(MAIN_SESSION))
  assert.equal(attached.size, N + 1)
})

// ── (e) wallSpanMs degenerate cases → 0, never negative/NaN ──────────────────
test('buildForest rollup: zero-duration and timestamp-less nodes give wallSpanMs 0', () => {
  // single node, ms 0 (single-timestamp transcript): maxEnd === minStart → 0
  const one = buildForest([node('a', 'tA', { ms: 0 })], new Map([['tA', MAIN_SESSION]]))
  assert.equal(one.rollup.wallSpanMs, 0)
  assert.ok(Number.isFinite(one.rollup.wallSpanMs))
  // no startedAtMs at all: min/max never set → still 0, not -Infinity/NaN
  const none = buildForest([node('b', 'tB', { startedAtMs: 0, startedAt: null, ms: 0 })], new Map([['tB', MAIN_SESSION]]))
  assert.equal(none.rollup.wallSpanMs, 0)
})

// ── (f) plain-object ownerOfToolUse (non-Map branch) ──────────────────────────
test('buildForest: a plain object ownerOfToolUse resolves parents identically to a Map', () => {
  const subs = () => [node('a', 'tA'), node('c', 'tC')]
  const viaMap = buildForest(subs(), new Map([['tA', MAIN_SESSION], ['tC', 'a']]))
  const viaObj = buildForest(subs(), { tA: MAIN_SESSION, tC: 'a' })
  assert.equal(viaObj.index.get('c').parentAgentId, 'a')
  assert.equal(viaObj.index.get('c').depth, 2)
  assert.equal(viaObj.rollup.maxDepth, viaMap.rollup.maxDepth)
  assert.equal(viaObj.rollup.orphanCount, 0)
  // and a null/absent map orphans everything under MAIN instead of throwing
  const bare = buildForest([node('x', 'tX')], null)
  assert.equal(bare.index.get('x').orphan, true)
  assert.equal(bare.index.get('x').parentAgentId, MAIN_SESSION)
})

// ── temp-dir fixtures for the scan-level edges ────────────────────────────────

// (b) duplicate tool_use ids: MAIN and subagent a BOTH emit an Agent tool_use
// with id 'addd0001'. The owner map is first-wins (scanSubagentTree parses MAIN
// before any subagent), so the duplicate's child z lands under MAIN, not a.
// MUTATION-PROVED: src/subagents.mjs:196 removed `!ownerOfToolUse.has(a.id) &&`
// (last-wins) ⇒ z resolved under 'aaaa1111' → RED:
//   "z parented by the FIRST claimant (MAIN)" / z.depth 2 !== 1.
test('scanSubagentTree: duplicate tool_use id — the first claimant (MAIN) keeps ownership', () => {
  const base = mkdtempSync(join(tmpdir(), 'ct-sub-edge-'))
  try {
    const sessDir = join(base, 'sess')
    mkdirSync(join(sessDir, 'subagents'), { recursive: true })
    writeFileSync(base + '/sess.jsonl', [
      user(ts(0), [{ type: 'text', text: 'go' }]),
      assistant(ts(1), [spawnBlock('tA', 'root a'), spawnBlock('addd0001', 'dup spawn from MAIN')]),
    ].join('\n'))
    // agent a: ALSO claims tool_use id 'addd0001'
    writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'root a', toolUseId: 'tA' }))
    writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.jsonl'), [
      user(ts(2), [{ type: 'text', text: 'do a' }]),
      assistant(ts(3), [spawnBlock('addd0001', 'dup spawn from a')]),
    ].join('\n'))
    // agent z: spawned via the contested id
    writeFileSync(join(sessDir, 'subagents', 'agent-ffff9999.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'dup child z', toolUseId: 'addd0001' }))
    writeFileSync(join(sessDir, 'subagents', 'agent-ffff9999.jsonl'), [
      user(ts(4), [{ type: 'text', text: 'do z' }]),
      assistant(ts(5), [{ type: 'text', text: 'done z' }]),
    ].join('\n'))

    const { root, rollup } = scanSubagentTree(sessDir)
    assert.equal(rollup.totalSubagents, 2)
    const z = root.children.find((n) => n.agentId === 'ffff9999')
    assert.ok(z, 'z parented by the FIRST claimant (MAIN)')
    assert.equal(z.depth, 1)
    assert.equal(z.orphan, false)
    const a = root.children.find((n) => n.agentId === 'aaaa1111')
    assert.equal(a.childCount, 0, 'the later claimant (a) does NOT get the child')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// (c) MAIN transcript absent but subagents exist: forest still builds with a
// synthetic MAIN root carrying NO measured stats (mainStats = {}), and the
// subagent — whose spawner can't be found — is re-homed as an orphan.
test('scanSubagentTree: missing main .jsonl still yields a MAIN root with no stats', () => {
  const base = mkdtempSync(join(tmpdir(), 'ct-sub-edge-'))
  try {
    const sessDir = join(base, 'sess')
    mkdirSync(join(sessDir, 'subagents'), { recursive: true })
    // NOTE: no sess.jsonl sibling written
    writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'lonely a', toolUseId: 'tA' }))
    writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.jsonl'), [
      user(ts(0), [{ type: 'text', text: 'do a' }]),
      assistant(ts(2), [{ type: 'text', text: 'done a' }]),
    ].join('\n'))

    const out = scanSubagentTree(sessDir)
    assert.equal(out.sessionId, 'sess')
    assert.ok(out.root, 'forest still built')
    assert.equal(out.root.agentId, MAIN_SESSION)
    assert.equal(out.root.isMain, true)
    // mainStats spread is {} → MAIN carries none of the measured-stat keys
    assert.equal(out.root.model, undefined)
    assert.equal(out.root.costUsd, undefined)
    assert.equal(out.root.status, undefined)
    assert.equal(out.rollup.totalSubagents, 1)
    const a = out.root.children[0]
    assert.equal(a.agentId, 'aaaa1111')
    assert.equal(a.orphan, true, 'spawner unresolvable without the MAIN transcript')
    // cwd/gitBranch fall back to the subagent transcript
    assert.equal(out.cwd, '/repo')
    assert.equal(out.gitBranch, 'main')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// (d) spawnMeta fallbacks: the meta sidecar has NO description and the child
// transcript has NO assistant model → the light node falls back to the spawning
// Agent call's input.description / input.model (and tier follows that model).
test('scanSubagentTree: node description/model fall back to the spawn call metadata', () => {
  const base = mkdtempSync(join(tmpdir(), 'ct-sub-edge-'))
  try {
    const sessDir = join(base, 'sess')
    mkdirSync(join(sessDir, 'subagents'), { recursive: true })
    writeFileSync(base + '/sess.jsonl', [
      user(ts(0), [{ type: 'text', text: 'go' }]),
      assistant(ts(1), [spawnBlock('tA', 'spawn-desc from parent')]), // input.model = claude-haiku-4-5
    ].join('\n'))
    // meta lacks description; transcript's assistant entry lacks a model field
    writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'tA' }))
    writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.jsonl'), [
      user(ts(2), [{ type: 'text', text: 'do a' }]),
      assistant(ts(3), [{ type: 'text', text: 'done a' }], null), // model omitted
    ].join('\n'))

    const { root } = scanSubagentTree(sessDir)
    const a = root.children.find((n) => n.agentId === 'aaaa1111')
    assert.equal(a.description, 'spawn-desc from parent')
    assert.equal(a.model, 'claude-haiku-4-5')
    assert.equal(a.tier, 'haiku', 'tier derived from the fallback model')
    assert.equal(a.orphan, false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// (e, scan-level) single-timestamp transcript end-to-end: one entry → ms 0 and
// rollup wallSpanMs 0 (never negative/NaN) even though startedAtMs is set.
test('scanSubagentTree: a single-timestamp transcript yields ms 0 and wallSpanMs 0', () => {
  const base = mkdtempSync(join(tmpdir(), 'ct-sub-edge-'))
  try {
    const sessDir = join(base, 'sess')
    mkdirSync(join(sessDir, 'subagents'), { recursive: true })
    writeFileSync(base + '/sess.jsonl', [
      user(ts(0), [{ type: 'text', text: 'go' }]),
      assistant(ts(1), [spawnBlock('tA', 'root a')]),
    ].join('\n'))
    writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'root a', toolUseId: 'tA' }))
    // exactly ONE timestamped entry
    writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.jsonl'), assistant(ts(5), [{ type: 'text', text: 'one shot' }]))

    const { root, rollup } = scanSubagentTree(sessDir)
    const a = root.children.find((n) => n.agentId === 'aaaa1111')
    assert.equal(a.ms, 0)
    assert.ok(a.startedAtMs > 0, 'start timestamp captured')
    assert.equal(rollup.wallSpanMs, 0)
    assert.ok(Number.isFinite(rollup.wallSpanMs) && rollup.wallSpanMs >= 0)
  } finally { rmSync(base, { recursive: true, force: true }) }
})
