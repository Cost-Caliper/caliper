// test/instrument.shim.test.mjs — run instrumented output under the shim to PROVE behavior.
//
// Each test instruments a fixture source then compileWorkflow + runs it with a
// deterministic stub backend that counts real calls and records which models were used.
// No real harness, no network — behavior is provable locally.
//
// Coverage:
//   C5  cache:true     — a dup-prompt fixture makes ONE real call; second is cache-hit
//   C6  callCap:N      — a 5-call fanout with cap=3 yields 3 real calls + 2 nulls
//   C7  rerouteModel   — authored model:'sonnet' → stub sees model:'haiku'
//   C8  conditionalShunt — decision agent returns tier; target agents run on that tier
//   C9  escapeHatch    — flagged label produces an escape trace; stub handles injection

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { instrument } from '../src/instrument.mjs'
import { compileWorkflow, makeParallel, makePipeline, makeBudget } from '../src/shim.mjs'

// ── Stub builder ──────────────────────────────────────────────────────────────
// Returns { stub, calls } where stub is an async backend that records calls.
function makeRecordingStub(responses = {}) {
  const calls = []
  const stub = async (prompt, opts = {}) => {
    const rec = { prompt, model: opts.model || 'sonnet', label: opts.label || null }
    calls.push(rec)
    // Check for a scripted response by label first, then by index
    if (rec.label && rec.label in responses) return responses[rec.label]
    return `stub-${calls.length}`
  }
  return { stub, calls }
}

// Run an instrumented source under the shim, collecting logs.
async function runInstrumented(instrumentedSource, stub, extraGlobals = {}) {
  const fn = compileWorkflow(instrumentedSource)
  const logs = []
  const phases = []
  const parallel = extraGlobals.parallel || makeParallel()
  const pipeline = extraGlobals.pipeline || makePipeline()
  const ret = await fn(
    stub,
    parallel,
    pipeline,
    (title) => phases.push(title),
    (m) => logs.push(String(m)),
    extraGlobals.args || {},
    makeBudget(null),
    async () => null,
  )
  const traceLines = logs
    .filter(l => l.startsWith('WFLENS_TRACE '))
    .map(l => { try { return JSON.parse(l.slice(13)) } catch { return null } })
    .filter(Boolean)
  return { ret, logs, traceLines, phases }
}

// ── C5: policy.cache — dup-prompt deduplication ───────────────────────────────

const DUP_PROMPT_SRC = `export const meta = { name: 'dup-prompt' }
const a = await agent('same prompt', { label: 'a', model: 'haiku' })
const b = await agent('same prompt', { label: 'b', model: 'haiku' })
const c = await agent('different prompt', { label: 'c', model: 'haiku' })
return { a, b, c }`

test('C5: cache:true — identical prompt makes ONE real call; second is cache-hit', async () => {
  const result = instrument(DUP_PROMPT_SRC, { policy: { cache: true } })
  assert.ok(result.lintOk, 'instrumented output should lint clean')

  const { stub, calls } = makeRecordingStub()
  const { ret, traceLines } = await runInstrumented(result.instrumentedSource, stub)

  // a and b have identical (prompt + model) — only ONE real call
  assert.equal(calls.length, 2, `expected 2 real calls (a + c), got ${calls.length}`)

  // b returns same value as a (from cache)
  assert.equal(ret.a, ret.b, 'cache-hit should return same value as first call')
  assert.notEqual(ret.a, ret.c, 'c has a different prompt so different value')

  // There should be a cache-hit trace line
  const cacheHits = traceLines.filter(t => t.ev === 'cache-hit')
  assert.equal(cacheHits.length, 1, `expected 1 cache-hit trace, got ${cacheHits.length}`)
})

test('C5: cache:false — identical prompts make TWO real calls', async () => {
  const result = instrument(DUP_PROMPT_SRC, { policy: { cache: false } })
  const { stub, calls } = makeRecordingStub()
  await runInstrumented(result.instrumentedSource, stub)
  assert.equal(calls.length, 3, `expected 3 real calls (no cache), got ${calls.length}`)
})

// ── C6: policy.callCap — cap trips at N ───────────────────────────────────────

const FANOUT_5_SRC = `export const meta = { name: 'fanout-5' }
const results = await parallel([
  () => agent('task 1', { label: 't1', model: 'haiku' }),
  () => agent('task 2', { label: 't2', model: 'haiku' }),
  () => agent('task 3', { label: 't3', model: 'haiku' }),
  () => agent('task 4', { label: 't4', model: 'haiku' }),
  () => agent('task 5', { label: 't5', model: 'haiku' }),
])
return { results }`

test('C6: callCap=3 (throw) — 5-call fanout yields 3 real + 2 nulls', async () => {
  const result = instrument(FANOUT_5_SRC, { policy: { callCap: 3, onCap: 'throw' } })
  assert.ok(result.lintOk)

  const { stub, calls } = makeRecordingStub()
  const { ret, traceLines } = await runInstrumented(result.instrumentedSource, stub)

  // parallel swallows throws → those items become null
  assert.equal(calls.length, 3, `expected 3 real calls, got ${calls.length}`)
  const nullCount = ret.results.filter(r => r === null).length
  assert.equal(nullCount, 2, `expected 2 null results from cap, got ${nullCount}`)

  const capTrips = traceLines.filter(t => t.ev === 'cap-trip')
  assert.ok(capTrips.length >= 2, `expected at least 2 cap-trip traces, got ${capTrips.length}`)
})

test('C6: callCap=3 (skip) — 5-call fanout yields 3 real + 2 nulls (no throw)', async () => {
  const result = instrument(FANOUT_5_SRC, { policy: { callCap: 3, onCap: 'skip' } })
  assert.ok(result.lintOk)

  const { stub, calls } = makeRecordingStub()
  const { ret, traceLines } = await runInstrumented(result.instrumentedSource, stub)

  assert.equal(calls.length, 3, `expected 3 real calls, got ${calls.length}`)
  const nullCount = ret.results.filter(r => r === null).length
  assert.equal(nullCount, 2, `expected 2 nulls from skip, got ${nullCount}`)

  const capTrips = traceLines.filter(t => t.ev === 'cap-trip')
  assert.ok(capTrips.length >= 2)
})

// ── C7: policy.rerouteModel — authored sonnet → stub sees haiku ───────────────

const REROUTE_SRC = `export const meta = { name: 'reroute-test' }
const a = await agent('task a', { label: 'a', model: 'sonnet' })
const b = await agent('task b', { label: 'b', model: 'opus' })
const c = await agent('task c', { label: 'c', model: 'haiku' })
return { a, b, c }`

test('C7: rerouteModel {sonnet:haiku} — authored sonnet reaches stub as haiku', async () => {
  const result = instrument(REROUTE_SRC, { policy: { rerouteModel: { sonnet: 'haiku' } } })
  assert.ok(result.lintOk)

  const { stub, calls } = makeRecordingStub()
  const { traceLines } = await runInstrumented(result.instrumentedSource, stub)

  // All 3 calls should happen
  assert.equal(calls.length, 3)

  // The call that was authored as 'sonnet' should reach stub as 'haiku'
  const callA = calls.find(c => c.label === 'a')
  assert.equal(callA.model, 'haiku', `expected 'a' to be rerouted to haiku, got ${callA.model}`)

  // Opus is NOT in the reroute map — stays as opus
  const callB = calls.find(c => c.label === 'b')
  assert.equal(callB.model, 'opus')

  // Haiku stays haiku
  const callC = calls.find(c => c.label === 'c')
  assert.equal(callC.model, 'haiku')

  // Should have reroute trace for 'a'
  const rerouteTraces = traceLines.filter(t => t.ev === 'reroute')
  assert.ok(rerouteTraces.length >= 1)
  assert.equal(rerouteTraces[0].from, 'sonnet')
  assert.equal(rerouteTraces[0].to, 'haiku')
})

test('C7: rerouteModel + cache compose — rerouted model is used as cache key', async () => {
  const result = instrument(REROUTE_SRC, {
    policy: { rerouteModel: { sonnet: 'haiku' }, cache: true }
  })
  assert.ok(result.lintOk)
  // After reroute, cache key uses the rerouted tier.
  // task a (authored sonnet → haiku) and task c (haiku) have different prompts, so no cache hit.
  const { stub, calls } = makeRecordingStub()
  await runInstrumented(result.instrumentedSource, stub)
  // All 3 prompts are unique, so 3 real calls expected
  assert.equal(calls.length, 3)
})

// ── C8: conditionalShunt — decision agent controls downstream tier ─────────────
// We prove this under the shim using a decision stub: the decision agent (label
// '__wflens_decide') returns 'haiku'; the target agent should then use 'haiku'
// even though it was authored as 'sonnet'.

const SHUNT_TARGET_SRC = `export const meta = { name: 'shunt-target' }
const plan = await agent('make a plan', { label: 'planner', model: 'haiku' })
const work = await agent('do the work: ' + plan, { label: 'worker', model: 'sonnet' })
return { plan, work }`

test('C8: conditionalShunt — decision agent returns haiku; target worker gets haiku', async () => {
  const result = instrument(SHUNT_TARGET_SRC, {
    hooks: {
      conditionalShunt: {
        endpoint: 'http://decide:9999/tier',
        decideModel: 'haiku',
        map: { fast: 'haiku', smart: 'sonnet' },
        targets: ['worker'],
      }
    }
  })
  assert.ok(result.lintOk, `lint findings: ${JSON.stringify(result.lintFindings)}`)

  // Stub: decision agent (label '__wflens_decide') returns 'haiku'
  // The decision agent's prompt instructs it to curl and reply with a tier word.
  // Our stub just checks the label and returns the scripted tier.
  const { stub, calls } = makeRecordingStub()
  // Override stub to return 'haiku' when it's the decision agent
  const decisionStub = async (prompt, opts = {}) => {
    const label = opts && opts.label
    calls.push({ prompt, model: opts.model || 'sonnet', label })
    // The injected decision agent has label '__wflens_decide'
    if (label === '__wflens_decide') return 'haiku'
    return `result-${label}`
  }

  const { ret, traceLines } = await runInstrumented(result.instrumentedSource, decisionStub)

  // Should have: decision agent + planner + worker
  const decisionCalls = calls.filter(c => c.label === '__wflens_decide')
  assert.equal(decisionCalls.length, 1, 'decision agent should be called once')
  assert.equal(decisionCalls[0].model, 'haiku', 'decision agent should run on haiku')

  // Worker is a target — should have been shunted to haiku
  const workerCalls = calls.filter(c => c.label === 'worker')
  assert.equal(workerCalls.length, 1)
  assert.equal(workerCalls[0].model, 'haiku', `worker should be shunted to haiku, got ${workerCalls[0].model}`)

  // Planner is NOT a target — stays on haiku (as authored)
  const plannerCalls = calls.filter(c => c.label === 'planner')
  assert.equal(plannerCalls.length, 1)
  assert.equal(plannerCalls[0].model, 'haiku')

  // Should have a shunt trace
  const shuntTraces = traceLines.filter(t => t.ev === 'shunt')
  assert.equal(shuntTraces.length, 1)
  assert.equal(shuntTraces[0].decisionRaw, 'haiku')
  assert.equal(shuntTraces[0].chosenTier, 'haiku')

  assert.ok(ret.plan)
  assert.ok(ret.work)
})

test('C8: conditionalShunt with map — raw decision word is remapped', async () => {
  const result = instrument(SHUNT_TARGET_SRC, {
    hooks: {
      conditionalShunt: {
        endpoint: 'http://decide:9999/tier',
        decideModel: 'haiku',
        map: { fast: 'haiku', smart: 'sonnet' },  // 'fast' maps to 'haiku'
        targets: ['worker'],
      }
    }
  })
  assert.ok(result.lintOk)

  const { stub, calls } = makeRecordingStub()
  const decisionStub = async (prompt, opts = {}) => {
    const label = opts && opts.label
    calls.push({ prompt, model: opts.model || 'sonnet', label })
    if (label === '__wflens_decide') return 'fast'  // decision returns 'fast'
    return `result-${label}`
  }

  const { traceLines } = await runInstrumented(result.instrumentedSource, decisionStub)

  // 'fast' should be mapped to 'haiku' via the map
  const shuntTraces = traceLines.filter(t => t.ev === 'shunt')
  assert.equal(shuntTraces[0].decisionRaw, 'fast')
  assert.equal(shuntTraces[0].chosenTier, 'haiku', `fast should map to haiku, got ${shuntTraces[0].chosenTier}`)

  const workerCalls = calls.filter(c => c.label === 'worker')
  assert.equal(workerCalls[0].model, 'haiku')
})

// ── C9: escapeHatch — flagged labels produce escape trace ─────────────────────
// Under the shim the escape agent is injected as an agent() call with label
// '__wflens_escape_<label>'. We prove: the escape trace is emitted, and the
// injected escape agent is called (not the original flagged one directly).

const ESCAPE_SRC = `export const meta = { name: 'escape-test' }
const a = await agent('normal task', { label: 'normal', model: 'haiku' })
const b = await agent('escape task', { label: 'escape-me', model: 'haiku' })
return { a, b }`

test('C9: escapeHatch — flagged label emits escape trace + injected agent is called', async () => {
  const result = instrument(ESCAPE_SRC, {
    hooks: {
      escapeHatch: {
        flagLabels: ['escape-me'],
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        keyEnv: 'OPENROUTER_API_KEY',
      }
    }
  })
  assert.ok(result.lintOk)

  const { stub, calls } = makeRecordingStub()
  const { traceLines } = await runInstrumented(result.instrumentedSource, stub)

  // Should emit an 'escape' trace for the flagged label
  const escapeTraces = traceLines.filter(t => t.ev === 'escape')
  assert.equal(escapeTraces.length, 1, `expected 1 escape trace, got ${escapeTraces.length}`)
  assert.equal(escapeTraces[0].label, 'escape-me')
  assert.equal(escapeTraces[0].provider, 'openrouter')
  assert.equal(escapeTraces[0].model, 'openai/gpt-4o-mini')

  // The escape injection replaces the direct call with a Bash subagent call.
  // Under the shim, that means agent() is called with label '__wflens_escape_escape-me'.
  const escapedCalls = calls.filter(c => c.label && c.label.startsWith('__wflens_escape_'))
  assert.ok(escapedCalls.length >= 1, `expected escape subagent call, calls: ${JSON.stringify(calls.map(c => c.label))}`)

  // The 'normal' label should call agent directly (not escaped)
  const normalCalls = calls.filter(c => c.label === 'normal')
  assert.equal(normalCalls.length, 1)
})

test('C9: escapeHatch — non-flagged labels are not escaped', async () => {
  const result = instrument(ESCAPE_SRC, {
    hooks: {
      escapeHatch: { flagLabels: ['escape-me'], provider: 'openrouter', model: 'openai/gpt-4o-mini', keyEnv: 'OPENROUTER_API_KEY' }
    }
  })

  const { stub, calls } = makeRecordingStub()
  await runInstrumented(result.instrumentedSource, stub)

  // normal should call agent directly (no escape)
  const normalDirect = calls.find(c => c.label === 'normal')
  assert.ok(normalDirect, 'normal label should reach the stub directly')
})

// ── Beacon run-end actually executes (regression) ─────────────────────────────
// A prior bug appended the run-end beacon AFTER the `return`, so it never ran.
// Under the shim, a fired beacon shows up as an agent() call labelled
// '__wflens_beacon_run-end'. Prove BOTH run-start and run-end beacons fire.

const BEACON_SRC = `export const meta = { name: 'beacon-exec' }
const a = await agent('do work', { label: 'a', model: 'haiku' })
return { a }
`

test('beacon: both run-start AND run-end beacon agents actually execute (not dead code)', async () => {
  const result = instrument(BEACON_SRC, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://localhost:8787', events: ['run-start', 'run-end'], model: 'haiku' } }
  })
  assert.ok(result.lintOk)

  const { stub, calls } = makeRecordingStub()
  const { ret } = await runInstrumented(result.instrumentedSource, stub)

  const startBeacons = calls.filter(c => c.label === '__wflens_beacon_run-start')
  const endBeacons = calls.filter(c => c.label === '__wflens_beacon_run-end')
  assert.equal(startBeacons.length, 1, 'run-start beacon agent must fire once')
  assert.equal(endBeacons.length, 1, `run-end beacon agent must fire once (was dead code after return); calls=${JSON.stringify(calls.map(c => c.label))}`)
  // The workflow still returns its real value.
  assert.ok(ret.a, 'workflow return value preserved')
})

// ── Composed: cache + reroute (C7 variant) ────────────────────────────────────

test('cache + reroute compose: only unique rerouted prompts count as cache keys', async () => {
  const src = `export const meta = { name: 'compose-test' }
const a = await agent('task x', { label: 'a', model: 'sonnet' })
const b = await agent('task x', { label: 'b', model: 'sonnet' })
const c = await agent('task y', { label: 'c', model: 'haiku' })
return { a, b, c }`

  const result = instrument(src, {
    policy: { cache: true, rerouteModel: { sonnet: 'haiku' } }
  })
  assert.ok(result.lintOk)

  const { stub, calls } = makeRecordingStub()
  const { ret, traceLines } = await runInstrumented(result.instrumentedSource, stub)

  // a and b: same prompt, both rerouted to haiku → same cache key → 1 real call
  // c: different prompt → 1 real call
  assert.equal(calls.length, 2, `expected 2 real calls (a/b dedupe + c), got ${calls.length}`)
  assert.equal(ret.a, ret.b, 'a and b should get same cached result')

  const cacheHits = traceLines.filter(t => t.ev === 'cache-hit')
  assert.equal(cacheHits.length, 1)

  // Both real calls should use haiku (rerouted)
  assert.ok(calls.every(c => c.model === 'haiku'), `all calls should be haiku, got ${JSON.stringify(calls.map(c => c.model))}`)
})
