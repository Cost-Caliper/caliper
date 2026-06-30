// test/subagents.test.mjs — Subagents view: pure forest assembly + a temp-dir
// end-to-end scan/reconstruct. Keyless; synthetic fixtures (portable, no real session).

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildForest, scanSubagentTree, reconstructSubagent, MAIN_SESSION } from '../src/subagents.mjs'
import { parseAgentTranscript } from '../src/observer.mjs'

// ── pure buildForest ─────────────────────────────────────────────────────────
const node = (id, parentToolUseId, extra = {}) => ({
  agentId: id, agentType: 'general-purpose', description: id, parentToolUseId,
  model: 'claude-sonnet-4-6', tier: 'sonnet', tokens: { in: 10, out: 2, cacheWr: 0, cacheRd: 0 },
  costUsd: 0.001, ms: 1000, startedAt: '2026-06-01T00:00:00.000Z', startedAtMs: 1000, toolCalls: 1,
  tools: ['Bash'], turns: 1, status: 'done', ...extra,
})

test('buildForest: roots attach under MAIN, nesting computes depth, childCount set', () => {
  const subs = [node('a', 'tA'), node('b', 'tB'), node('c', 'tC')]
  // a,b spawned by MAIN; c spawned by a (nested)
  const owner = new Map([['tA', MAIN_SESSION], ['tB', MAIN_SESSION], ['tC', 'a']])
  const { root, index, rollup } = buildForest(subs, owner)

  assert.equal(root.agentId, MAIN_SESSION)
  assert.equal(root.depth, 0)
  assert.equal(root.childCount, 2)                       // a, b
  assert.equal(index.get('a').depth, 1)
  assert.equal(index.get('a').childCount, 1)             // c
  assert.equal(index.get('c').depth, 2)
  assert.equal(index.get('c').parentAgentId, 'a')
  assert.equal(rollup.totalSubagents, 3)
  assert.equal(rollup.maxDepth, 2)
  assert.equal(rollup.orphanCount, 0)
})

test('buildForest: an unresolvable parent → orphan re-homed under MAIN, never dropped', () => {
  const subs = [node('a', 'tA'), node('orphan', 'tMissing')]
  const owner = new Map([['tA', MAIN_SESSION]]) // tMissing not present
  const { root, index, rollup } = buildForest(subs, owner)
  assert.equal(index.get('orphan').orphan, true)
  assert.equal(index.get('orphan').parentAgentId, MAIN_SESSION)
  assert.equal(root.childCount, 2)               // a + orphan both under MAIN
  assert.equal(rollup.orphanCount, 1)
  assert.equal(rollup.totalSubagents, 2)
})

test('buildForest: parent cycle is broken (no infinite loop), each node attached once', () => {
  const subs = [node('a', 'tB'), node('b', 'tA')]
  const owner = new Map([['tB', 'b'], ['tA', 'a']]) // a→b and b→a : a 2-cycle
  const { root, index, rollup } = buildForest(subs, owner)
  // one of them is re-homed under MAIN as an orphan; total attached nodes == 2
  const countAttached = (n, seen = new Set()) => {
    if (seen.has(n.agentId)) return 0
    seen.add(n.agentId)
    let c = n.agentId === MAIN_SESSION ? 0 : 1
    for (const k of n.children) c += countAttached(k, seen)
    return c
  }
  assert.equal(countAttached(root), 2)
  assert.ok(rollup.orphanCount >= 1)
})

test('buildForest: rollup sums cost/tokens and counts agentTypes', () => {
  const subs = [node('a', 'tA', { costUsd: 0.5, agentType: 'Explore' }), node('b', 'tB', { costUsd: 0.25 })]
  const owner = new Map([['tA', MAIN_SESSION], ['tB', MAIN_SESSION]])
  const { rollup } = buildForest(subs, owner)
  assert.equal(rollup.totalCostUsd, 0.75)
  assert.equal(rollup.totalTokens.in, 20)
  assert.equal(rollup.agentTypeCounts.Explore, 1)
  assert.equal(rollup.agentTypeCounts['general-purpose'], 1)
})

// ── temp-dir end-to-end (scanSubagentTree + reconstructSubagent) ───────────────
function ts(sec) { return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString() }
function assistant(tArr, content, model = 'claude-sonnet-4-6') {
  return JSON.stringify({ type: 'assistant', timestamp: tArr, cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', model, usage: { input_tokens: 100, output_tokens: 20 }, content } })
}
function user(tArr, content) {
  return JSON.stringify({ type: 'user', timestamp: tArr, message: { role: 'user', content } })
}
function spawnBlock(id, desc) { return { type: 'tool_use', id, name: 'Agent', input: { description: desc, model: 'claude-haiku-4-5' } } }

function makeSession() {
  const base = mkdtempSync(join(tmpdir(), 'ct-sub-'))
  const sessDir = join(base, 'sess')
  mkdirSync(join(sessDir, 'subagents'), { recursive: true })

  // MAIN transcript: spawns root agents a (tA) and b (tB)
  writeFileSync(base + '/sess.jsonl', [
    user(ts(0), [{ type: 'text', text: 'go' }]),
    assistant(ts(1), [{ type: 'text', text: 'spawning' }, spawnBlock('tA', 'root a'), spawnBlock('tB', 'root b')]),
  ].join('\n'))

  // agent a (root): does a Bash tool call, then spawns nested child c (tC)
  const aId = 'aaaa1111'
  writeFileSync(join(sessDir, 'subagents', `agent-${aId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'root a', toolUseId: 'tA' }))
  writeFileSync(join(sessDir, 'subagents', `agent-${aId}.jsonl`), [
    user(ts(2), [{ type: 'text', text: 'do a' }]),
    assistant(ts(3), [{ type: 'text', text: 'running tool' }, { type: 'tool_use', id: 'bash1', name: 'Bash', input: { command: 'ls' } }]),
    user(ts(8), [{ type: 'tool_result', tool_use_id: 'bash1', content: 'file1\nfile2' }]),
    assistant(ts(9), [{ type: 'text', text: 'now spawning child' }, spawnBlock('tC', 'nested c')]),
  ].join('\n'))

  // agent b (root, leaf)
  const bId = 'bbbb2222'
  writeFileSync(join(sessDir, 'subagents', `agent-${bId}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'root b', toolUseId: 'tB' }))
  writeFileSync(join(sessDir, 'subagents', `agent-${bId}.jsonl`), [
    user(ts(2), [{ type: 'text', text: 'do b' }]),
    assistant(ts(4), [{ type: 'text', text: 'done b' }]),
  ].join('\n'))

  // agent c (nested under a, leaf)
  const cId = 'cccc3333'
  writeFileSync(join(sessDir, 'subagents', `agent-${cId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'nested c', toolUseId: 'tC' }))
  writeFileSync(join(sessDir, 'subagents', `agent-${cId}.jsonl`), [
    user(ts(10), [{ type: 'text', text: 'do c' }]),
    assistant(ts(12), [{ type: 'text', text: 'done c' }]),
  ].join('\n'))

  // orphan agent d (toolUseId not in any transcript)
  const dId = 'dddd4444'
  writeFileSync(join(sessDir, 'subagents', `agent-${dId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: 'orphan d', toolUseId: 'tMissing' }))
  writeFileSync(join(sessDir, 'subagents', `agent-${dId}.jsonl`), [
    user(ts(2), [{ type: 'text', text: 'do d' }]),
    assistant(ts(3), [{ type: 'text', text: 'done d' }]),
  ].join('\n'))

  return { base, sessDir, aId, bId, cId, dId }
}

test('scanSubagentTree: discovers subagents, resolves parents, computes depth + orphan', () => {
  const { base, sessDir, aId, cId, dId } = makeSession()
  try {
    const { root, rollup } = scanSubagentTree(sessDir)
    assert.equal(rollup.totalSubagents, 4)
    assert.equal(rollup.maxDepth, 2)          // MAIN(0) → a(1) → c(2)
    assert.equal(rollup.orphanCount, 1)       // d
    // roots under MAIN: a, b, and the re-homed orphan d
    const rootIds = root.children.map((n) => n.agentId).sort()
    assert.deepEqual(rootIds, [aId, dId, 'bbbb2222'].sort())
    const a = root.children.find((n) => n.agentId === aId)
    assert.equal(a.childCount, 1)
    assert.equal(a.children[0].agentId, cId)
    assert.equal(a.children[0].depth, 2)
    const d = root.children.find((n) => n.agentId === dId)
    assert.equal(d.orphan, true)
    // light node carries cost/tier/tools
    assert.equal(a.tier, 'sonnet')
    assert.ok(a.costUsd > 0)
    assert.ok(a.toolCalls >= 1)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('scanSubagentTree: a trailing slash on the session dir still resolves MAIN + the same forest', () => {
  const { base, sessDir } = makeSession()
  try {
    const a = scanSubagentTree(sessDir)
    const b = scanSubagentTree(sessDir + '/')   // trailing slash — MAIN sibling path must not break
    assert.equal(b.rollup.totalSubagents, a.rollup.totalSubagents)
    assert.equal(b.rollup.rootCount, a.rollup.rootCount)
    assert.equal(b.rollup.maxDepth, a.rollup.maxDepth)
    // MAIN stats resolved (sibling <sessDir>.jsonl found despite the trailing slash)
    assert.ok(b.root.toolCalls >= 1 || b.root.turns >= 1, 'MAIN transcript parsed')
    assert.ok(reconstructSubagent(sessDir + '/', MAIN_SESSION), 'MAIN detail resolves with trailing slash')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('scanSubagentTree: a meta sidecar with no transcript is labelled "missing", not "running"', () => {
  const { base, sessDir } = makeSession()
  try {
    // meta present, transcript absent
    writeFileSync(join(sessDir, 'subagents', 'agent-eeee5555.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'aborted e', toolUseId: 'tNone' }))
    const { root, rollup } = scanSubagentTree(sessDir)
    assert.equal(rollup.totalSubagents, 5)
    const e = root.children.find((n) => n.agentId === 'eeee5555')
    assert.ok(e, 'missing-transcript node still in the tree')
    assert.equal(e.status, 'missing')
    assert.notEqual(e.status, 'running')
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('reconstructSubagent: full detail with segments + rejects bad ids', () => {
  const { base, sessDir, aId } = makeSession()
  try {
    const d = reconstructSubagent(sessDir, aId)
    assert.ok(d, 'returns detail')
    assert.equal(d.tier, 'sonnet')
    assert.ok(Array.isArray(d.segments) && d.segments.length >= 1, 'has segments')
    // agent a had inference → tool(Bash) → inference, so a tool segment with detail exists
    const toolSeg = d.segments.find((s) => s.kind === 'tool')
    assert.ok(toolSeg && toolSeg.detail.calls.length >= 1, 'tool segment carries call detail')
    assert.equal(toolSeg.detail.calls[0].name, 'Bash')
    assert.ok(typeof d.task === 'string')
    // path-traversal / non-hex id rejected
    assert.equal(reconstructSubagent(sessDir, '../../etc/passwd'), null)
    assert.equal(reconstructSubagent(sessDir, 'zzzz9999nope!'), null)
    // MAIN session reconstructs from the sibling transcript
    const main = reconstructSubagent(sessDir, MAIN_SESSION)
    assert.ok(main && main.isMain)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

// ── observer.mjs additive change (light mode + agentCalls) ─────────────────────
test('parseAgentTranscript: light mode skips segments but keeps totals + agentCalls', () => {
  const { base, sessDir, aId } = makeSession()
  try {
    const p = join(sessDir, 'subagents', `agent-${aId}.jsonl`)
    const light = parseAgentTranscript(p, { light: true })
    assert.deepEqual(light.segments, [])
    assert.equal(light.task, null)
    assert.ok(light.toolCalls >= 1)
    // a spawned child c via Agent tool_use 'tC' → captured in agentCalls
    assert.ok(light.agentCalls.some((a) => a.id === 'tC'))

    const full = parseAgentTranscript(p) // default full
    assert.ok(full.segments.length >= 1)
    assert.ok(typeof full.task === 'string')
    assert.ok(full.agentCalls.some((a) => a.id === 'tC')) // agentCalls present in full too
  } finally { rmSync(base, { recursive: true, force: true }) }
})
