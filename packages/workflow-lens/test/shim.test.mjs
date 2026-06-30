// test/shim.test.mjs — keyless runtime primitive tests.
// Covers makeParallel, makePipeline, makeBudget, compileWorkflow semantics.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  makeParallel,
  makePipeline,
  makeBudget,
  compileWorkflow,
} from '../src/shim.mjs'

// ── makeParallel ──────────────────────────────────────────────────────────────

test('makeParallel: resolves all values in order', async () => {
  const parallel = makeParallel()
  const results = await parallel([
    () => Promise.resolve(1),
    () => Promise.resolve(2),
    () => Promise.resolve(3),
  ])
  assert.deepEqual(results, [1, 2, 3])
})

test('makeParallel: throwing thunk resolves to null (not rejected)', async () => {
  const parallel = makeParallel()
  const results = await parallel([
    () => Promise.resolve('ok'),
    () => { throw new Error('boom') },
    () => Promise.resolve('still'),
  ])
  assert.deepEqual(results, ['ok', null, 'still'])
})

test('makeParallel: empty thunks array resolves to []', async () => {
  const parallel = makeParallel()
  const results = await parallel([])
  assert.deepEqual(results, [])
})

// ── makePipeline ──────────────────────────────────────────────────────────────

test('makePipeline: each item flows through stages', async () => {
  const pipeline = makePipeline()
  const results = await pipeline(
    [1, 2, 3],
    (x) => x * 2,
    (x) => x + 10,
  )
  assert.deepEqual(results, [12, 14, 16])
})

test('makePipeline: a throwing stage drops item to null', async () => {
  const pipeline = makePipeline()
  const results = await pipeline(
    ['a', 'b', 'c'],
    (x) => x + '1',
    (x) => { if (x === 'b1') throw new Error('skip b'); return x + '2' },
  )
  assert.deepEqual(results, ['a12', null, 'c12'])
})

// ── makeBudget ────────────────────────────────────────────────────────────────

test('makeBudget: _check does not throw below ceiling', () => {
  const b = makeBudget(1.0)
  b._charge(0.5)
  assert.doesNotThrow(() => b._check())
})

test('makeBudget: _check throws BUDGET_EXCEEDED at ceiling', () => {
  const b = makeBudget(1.0)
  b._charge(1.0)
  assert.throws(() => b._check(), (e) => e.code === 'BUDGET_EXCEEDED')
})

test('makeBudget: total:null => Infinity (no ceiling)', () => {
  const b = makeBudget(null)
  b._charge(9999)
  assert.doesNotThrow(() => b._check())
  assert.equal(b.remaining(), Infinity)
})

test('makeBudget: remaining() tracks spend', () => {
  const b = makeBudget(10.0)
  b._charge(3.0)
  assert.equal(b.remaining(), 7.0)
  assert.equal(b.spent(), 3.0)
})

// ── compileWorkflow ───────────────────────────────────────────────────────────

test('compileWorkflow: runs a minimal workflow with stub agent', async () => {
  const src = `export const meta = { name: 'test-compile' }
const r = await agent('hello', { model: 'haiku' })
return r`
  const fn = compileWorkflow(src)
  const stubAgent = async () => 'stub-result'
  const parallel = makeParallel()
  const pipeline = makePipeline()
  const budget = makeBudget(null)
  const result = await fn(stubAgent, parallel, pipeline, () => {}, () => {}, {}, budget, async () => null)
  assert.equal(result, 'stub-result')
})

test('compileWorkflow: returns value from workflow body', async () => {
  const src = `export const meta = { name: 'test-return' }
return { ok: true, constant: 42 }`
  const fn = compileWorkflow(src)
  const result = await fn(async () => null, makeParallel(), makePipeline(), () => {}, () => {}, {}, makeBudget(null), async () => null)
  assert.deepEqual(result, { ok: true, constant: 42 })
})
