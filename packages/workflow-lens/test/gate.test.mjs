// test/gate.test.mjs — keyless gate tests (cache hit, HITL deny, fail-closed model-swap).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createGate, hashCall } from '../src/gate.mjs'

// Minimal stub backend (no network): returns a predictable envelope.
let callCount = 0
function makeStub() {
  callCount = 0
  return async (prompt, opts = {}) => {
    callCount++
    return { text: 'ok', usage: { inTok: 5, outTok: 3 }, ms: 10, requestId: `req-${callCount}`, tier: opts.model || 'sonnet', model: opts.model || 'sonnet' }
  }
}

// ── hashCall ──────────────────────────────────────────────────────────────────

test('hashCall: same (prompt, opts) always returns same 32-char key', () => {
  const a = hashCall('hello', { model: 'haiku' })
  const b = hashCall('hello', { model: 'haiku' })
  assert.equal(a, b)
  assert.equal(a.length, 32)
})

test('hashCall: different prompt -> different key', () => {
  const a = hashCall('hello', { model: 'haiku' })
  const b = hashCall('world', { model: 'haiku' })
  assert.notEqual(a, b)
})

test('hashCall: ignores label and phase (telemetry opts, not response-shaping)', () => {
  const a = hashCall('hello', { model: 'haiku', label: 'greeter', phase: 'Greet' })
  const b = hashCall('hello', { model: 'haiku', label: 'other', phase: 'Other' })
  assert.equal(a, b)
})

// ── cache hit ─────────────────────────────────────────────────────────────────

test('gate cache: 2nd identical call returns cached:true with 0 extra backend calls', async () => {
  const stub = makeStub()
  const gate = createGate(stub)
  const first = await gate('hello', { model: 'haiku' })
  const second = await gate('hello', { model: 'haiku' })
  assert.equal(first.cached, false, 'first call should not be cached')
  assert.equal(second.cached, true, 'second call should be cached')
  assert.equal(callCount, 1, 'backend should only have been called once')
})

// ── HITL deny ────────────────────────────────────────────────────────────────

test('gate HITL: decider deny -> throws HITL_DENIED', async () => {
  const stub = makeStub()
  const gate = createGate(stub, {
    decider: async () => ({ approve: false, reason: 'test deny' }),
  })
  await assert.rejects(
    () => gate('hello', { model: 'haiku' }),
    (e) => e.code === 'HITL_DENIED',
  )
  assert.equal(callCount, 0, 'backend should not be called when HITL denies')
})

test('gate HITL: decider approve -> call proceeds', async () => {
  const stub = makeStub()
  const gate = createGate(stub, {
    decider: async () => ({ approve: true }),
  })
  const result = await gate('hello', { model: 'haiku' })
  assert.equal(result.text, 'ok')
  assert.equal(callCount, 1)
})

// ── model-swap / MISSING_CREDENTIAL ──────────────────────────────────────────

test('gate model-swap: non-Anthropic tier with no key -> MISSING_CREDENTIAL', async () => {
  const stub = makeStub()
  const gate = createGate(stub, {
    env: {},  // empty env: no OPENAI_API_KEY or any other key
  })
  await assert.rejects(
    () => gate('hello', { model: 'gpt-4o-mini' }),
    (e) => e.code === 'MISSING_CREDENTIAL',
  )
  assert.equal(callCount, 0, 'backend should not be called')
})

test('gate stats: tracks realCalls, cacheHits, hitlDenied', async () => {
  const stub = makeStub()
  const decider = async (p, o) => ({ approve: o.model === 'haiku' ? true : false, reason: 'deny non-haiku' })
  const gate = createGate(stub, { decider })
  await gate('a', { model: 'haiku' })
  await gate('a', { model: 'haiku' })  // cache hit
  try { await gate('b', { model: 'sonnet' }) } catch {}  // HITL denied
  const s = gate.stats()
  assert.equal(s.realCalls, 1)
  assert.equal(s.cacheHits, 1)
  assert.equal(s.hitlDenied, 1)
})
