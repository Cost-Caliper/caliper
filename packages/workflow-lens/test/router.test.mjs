// test/router.test.mjs — keyless classify/routeTier tests.
// All purely deterministic; no LLM calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, routeTier, createRouter } from '../src/router.mjs'

// ── classify ──────────────────────────────────────────────────────────────────

test('classify: short prompts (<=80 chars) -> easy', () => {
  assert.equal(classify('yes or no?'), 'easy')
  assert.equal(classify('What is 2+2?'), 'easy')
  assert.equal(classify('ok'), 'easy')
})

test('classify: yes-or-no signal -> easy', () => {
  assert.equal(classify('Is this a valid JSON string? Answer yes or no, nothing else.'), 'easy')
})

test('classify: one-word signal -> easy', () => {
  assert.equal(classify('Reply with one word: the color of the sky during daytime'), 'easy')
})

test('classify: long complex prose -> hard', () => {
  const longPrompt = 'Write a detailed technical analysis of the tradeoffs between microservices and monolithic architectures, including considerations for team size, deployment complexity, data consistency, and operational overhead. Compare at least three real-world examples.'
  assert.equal(classify(longPrompt), 'hard')
})

test('classify: arithmetic-only -> easy', () => {
  assert.equal(classify('42 + 17 = ?'), 'easy')
  assert.equal(classify('(100 * 3) / 5'), 'easy')
})

// ── routeTier ─────────────────────────────────────────────────────────────────

test('routeTier: explicit non-sonnet tier -> passthrough (no reclassification)', () => {
  const { tier, decision } = routeTier('any prompt', { model: 'haiku' })
  assert.equal(tier, 'haiku')
  assert.equal(decision, 'passthrough')
})

test('routeTier: explicit sonnet + easy prompt -> passthrough (not forceRoute)', () => {
  const { tier, decision, classification } = routeTier('yes or no', { model: 'sonnet' })
  assert.equal(tier, 'sonnet')
  assert.equal(decision, 'passthrough')
})

test('routeTier: no explicit tier + easy prompt -> routed-down', () => {
  const { tier, decision, classification } = routeTier('ok')
  assert.equal(tier, 'cheap')
  assert.equal(decision, 'routed-down')
  assert.equal(classification, 'easy')
})

test('routeTier: no explicit tier + hard prompt -> kept-strong', () => {
  const longPrompt = 'Write a detailed technical analysis with comprehensive coverage across multiple domains including distributed systems, consistency models, partition tolerance, and network failures with concrete examples from production systems.'
  const { tier, decision, classification } = routeTier(longPrompt)
  assert.equal(decision, 'kept-strong')
  assert.equal(classification, 'hard')
})

// ── createRouter (stub backends, keyless) ─────────────────────────────────────

test('createRouter: routes easy prompt to cheap backend', async () => {
  let usedCheap = false
  const strongStub = async () => ({ text: 'strong', usage: { inTok: 10, outTok: 5 }, ms: 50, requestId: 'r1', tier: 'sonnet', model: 'sonnet' })
  const cheapStub = async () => { usedCheap = true; return { text: 'cheap', usage: { inTok: 5, outTok: 3 }, ms: 20, requestId: 'r2', tier: 'gpt-4o-mini', model: 'gpt-4o-mini' } }
  const router = createRouter(strongStub, cheapStub)
  const result = await router('yes or no', {})  // easy -> cheap
  assert.ok(usedCheap, 'expected cheap backend to be called for easy prompt')
})

test('createRouter: routes hard prompt to strong backend', async () => {
  let usedStrong = false
  const strongStub = async () => { usedStrong = true; return { text: 'strong', usage: { inTok: 10, outTok: 5 }, ms: 50, requestId: 'r1', tier: 'sonnet', model: 'sonnet' } }
  const cheapStub = async () => ({ text: 'cheap', usage: { inTok: 5, outTok: 3 }, ms: 20, requestId: 'r2', tier: 'gpt-4o-mini', model: 'gpt-4o-mini' })
  const router = createRouter(strongStub, cheapStub)
  const longPrompt = 'Analyze the comprehensive tradeoffs between event-driven and request-response architectures in distributed systems, including consistency, latency, operational complexity, and team cognitive load with real production examples spanning multiple years of data.'
  await router(longPrompt, {})
  assert.ok(usedStrong, 'expected strong backend to be called for hard prompt')
})

test('createRouter: result includes routedTier, routeDecision, classification', async () => {
  const stub = async () => ({ text: 'ok', usage: { inTok: 5, outTok: 3 }, ms: 10, requestId: 'r1', tier: 'cheap', model: 'gpt-4o-mini' })
  const router = createRouter(stub, stub)
  const result = await router('ok', {})
  assert.ok('routedTier' in result)
  assert.ok('routeDecision' in result)
})
