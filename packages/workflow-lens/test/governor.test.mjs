// test/governor.test.mjs — keyless budget governor tests.
// Verifies BUDGET_EXCEEDED is re-thrown THROUGH parallel/pipeline barriers.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createGovernor, BudgetExceededError } from '../src/governor.mjs'
import { createLedger } from '../src/ledger.mjs'
import { PRICE } from '../src/shim.mjs'

// A stub backend that also charges a realistic cost so the governor can trip.
// Each call costs $costPerCall.
function makeCostedStub(costPerCall = 0.001) {
  return async (prompt, opts = {}) => {
    // Return a shape that ledger.instrument() can record cost from
    return {
      text: 'ok',
      usage: { inTok: 100, outTok: 50 },
      ms: 10,
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      tier: opts.model || 'haiku',
      model: opts.model || 'haiku',
    }
  }
}

test('governor: agent calls within cap succeed', async () => {
  const ledger = createLedger()
  const stub = makeCostedStub()
  const recorded = ledger.instrument(stub)
  const { agent } = createGovernor(recorded, ledger, { capUsd: 1.0 })
  const result = await agent('hello', { model: 'haiku' })
  assert.equal(result, 'ok')
})

test('governor: no cap (null) -> unlimited calls', async () => {
  const ledger = createLedger()
  const stub = makeCostedStub()
  const recorded = ledger.instrument(stub)
  const { agent } = createGovernor(recorded, ledger, { capUsd: null })
  for (let i = 0; i < 5; i++) {
    const r = await agent('prompt', { model: 'haiku' })
    assert.equal(r, 'ok')
  }
})

test('governor: BUDGET_EXCEEDED re-thrown through parallel barrier', async () => {
  // Use a very tiny cap so the first call trips it
  const ledger = createLedger()
  const stub = makeCostedStub(0.001)
  const recorded = ledger.instrument(stub)
  // Set cap below the cost of a single real call (haiku ~$0.000125 for 100in/50out)
  // Use an absurdly tiny cap to ensure immediate trip
  const { agent, parallel } = createGovernor(recorded, ledger, { capUsd: 0.000001 })

  // Force the ledger to have a high spend by manually injecting a record
  // so the governor sees the cap as exceeded immediately
  ledger.record({
    id: 99, label: 'pre-charge', tier: 'haiku', model: 'haiku', phase: null,
    startMs: 0, endMs: 1, ms: 1,
    inTok: 10000, outTok: 5000,
    costUsd: 0.1,  // well over the $0.000001 cap
    requestId: null, error: null,
  })

  // parallel barrier should RE-THROW BUDGET_EXCEEDED (not swallow to null)
  await assert.rejects(
    () => parallel([
      () => agent('task1', { model: 'haiku' }),
      () => agent('task2', { model: 'haiku' }),
    ]),
    (e) => e.code === 'BUDGET_EXCEEDED',
    'expected BUDGET_EXCEEDED to be re-thrown through parallel barrier',
  )
})

test('governor: BUDGET_EXCEEDED re-thrown through pipeline barrier', async () => {
  const ledger = createLedger()
  const stub = makeCostedStub()
  const recorded = ledger.instrument(stub)
  const { agent, pipeline } = createGovernor(recorded, ledger, { capUsd: 0.000001 })

  // Pre-charge the ledger to exceed cap
  ledger.record({
    id: 99, label: 'pre-charge', tier: 'haiku', model: 'haiku', phase: null,
    startMs: 0, endMs: 1, ms: 1,
    inTok: 10000, outTok: 5000, costUsd: 0.1,
    requestId: null, error: null,
  })

  await assert.rejects(
    () => pipeline(
      ['item1', 'item2'],
      (item) => agent(`process: ${item}`, { model: 'haiku' }),
    ),
    (e) => e.code === 'BUDGET_EXCEEDED',
    'expected BUDGET_EXCEEDED to be re-thrown through pipeline barrier',
  )
})

test('governor.stats: tripped=true after BUDGET_EXCEEDED', async () => {
  const ledger = createLedger()
  const stub = makeCostedStub()
  const recorded = ledger.instrument(stub)
  const { agent } = createGovernor(recorded, ledger, { capUsd: 0.000001 })

  ledger.record({
    id: 99, label: 'pre-charge', tier: 'haiku', model: 'haiku', phase: null,
    startMs: 0, endMs: 1, ms: 1, inTok: 10000, outTok: 5000, costUsd: 0.1,
    requestId: null, error: null,
  })

  try { await agent('hello', { model: 'haiku' }) } catch {}
  const s = agent.stats()
  assert.equal(s.tripped, true)
  assert.ok(s.cap > 0)
})

test('BudgetExceededError: has code BUDGET_EXCEEDED', () => {
  const e = new BudgetExceededError(0.5, 0.1)
  assert.equal(e.code, 'BUDGET_EXCEEDED')
  assert.ok(e instanceof Error)
  assert.ok(e.message.includes('BUDGET_EXCEEDED'))
})
