// test/observe-cost-edges.test.mjs — src/observe-cost.mjs edge coverage:
// dominantModel (cost-weighted, not token-weighted), costOfParse composition,
// costOfUsage price-table override + cache-bucket arithmetic, naiveCostOfUsage,
// tierFromModel fallbacks.
//
// Inputs are parsed-like plain objects — the real contract of these functions
// (they consume parseAgentTranscript results; shape mirrors fallbacks.test.mjs).
// PRICE ($/Mtok, shim.mjs): haiku 1/5, sonnet 3/15, opus 5/25, fable 10/50.
// Cache: creation ×1.25 (5m) / ×2.0 (1h) / legacy ×1.25, read ×0.10.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tierFromModel, costOfUsage, costOfParse, dominantModel, naiveCostOfUsage } from '../src/observe-cost.mjs'

const U0 = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} !== ${b}`)

// ---------------------------------------------------------------------------
// tierFromModel
// MUTATION-PROVED: changed the final fallback `return 'sonnet'` → `return 'haiku'`
// (observe-cost.mjs:27) → "unrecognized model falls back to sonnet: got haiku". Restored → green.

test('tierFromModel: nullish, unrecognized, and case-insensitive resolution', () => {
  assert.equal(tierFromModel(null), 'sonnet', 'null model falls back to sonnet')
  assert.equal(tierFromModel(undefined), 'sonnet', 'undefined model falls back to sonnet')
  assert.equal(tierFromModel('gpt-4'), 'sonnet', `unrecognized model falls back to sonnet: got ${tierFromModel('gpt-4')}`)
  assert.equal(tierFromModel('Claude-FABLE-5'), 'fable', 'tier match is case-insensitive')
  assert.equal(tierFromModel('claude-haiku-4-5-20251001'), 'haiku')
  assert.equal(tierFromModel('claude-opus-4-8'), 'opus')
  assert.equal(tierFromModel('claude-sonnet-4-5'), 'sonnet')
})

// ---------------------------------------------------------------------------
// costOfUsage — exact arithmetic, legacy + bucketed cache paths
// MUTATION-PROVED (3 mutations, each restored → green):
//   - cache-read discount `* 0.10` → `* 1.0` (observe-cost.mjs:61)
//     → "legacy cache path exact: 0.04725 !== 0.02025"
//   - 1h bucket `(b1h || 0) * 2.0` → `* 1.25` (observe-cost.mjs:56)
//     → "bucketed cache-create exact: 0.01125 !== 0.0135"
//   - ignored the price param (shadowed with PRICE) (observe-cost.mjs:33)
//     → "custom table used for fable: 60 !== 300"

test('costOfUsage: exact legacy cache arithmetic (no TTL buckets present)', () => {
  // sonnet: in 3/Mtok, out 15/Mtok
  const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 10000 }
  // 1000*3e-6 + 3000*3e-6*1.25 + 10000*3e-6*0.10 + 200*15e-6
  const expected = 0.003 + 0.01125 + 0.003 + 0.003
  close(costOfUsage(usage, 'claude-sonnet-4-5'), expected, 'legacy cache path exact')
})

test('costOfUsage: TTL-bucketed cache creation (5m ×1.25, 1h ×2.0, remainder ×1.25)', () => {
  const usage = {
    ...U0, cache_creation_input_tokens: 3000,
    cache_5m_input_tokens: 1000, cache_1h_input_tokens: 1000, // remainder 1000 → legacy ×1.25
  }
  // (1000*1.25 + 1000*2.0 + 1000*1.25) * 3e-6 = 4500 * 3e-6
  close(costOfUsage(usage, 'claude-sonnet-4-5'), 0.0135, 'bucketed cache-create exact')
  // raw nested form (usage.cache_creation.ephemeral_*) must price identically
  const raw = { ...U0, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1000 } }
  close(costOfUsage(raw, 'claude-sonnet-4-5'), 0.0135, 'nested ephemeral buckets exact')
})

test('costOfUsage: honors the price-table override parameter', () => {
  const custom = { fable: { in: 100.0, out: 200.0 }, sonnet: { in: 1.0, out: 1.0 } }
  const usage = { ...U0, input_tokens: 1_000_000, output_tokens: 1_000_000 }
  // custom fable: $100 + $200
  close(costOfUsage(usage, 'claude-fable-5', custom), 300, 'custom table used for fable')
  // unrecognized tier resolves via the CUSTOM table's sonnet, not shim PRICE
  close(costOfUsage(usage, 'gpt-4', custom), 2, 'custom table sonnet fallback used')
})

// ---------------------------------------------------------------------------
// costOfParse
// MUTATION-PROVED: changed the unknown-bucket resolution in costOfParse
// (observe-cost.mjs:78) `m === 'unknown' ? parsed.model : m` → just `m`
// → "unknown bucket priced at parsed.model tier: 3 !== 10". Restored → green.

test('costOfParse: null parse costs 0; single model equals costOfUsage(totalUsage) exactly', () => {
  assert.equal(costOfParse(null), 0, 'null parse → 0')
  const totalUsage = { input_tokens: 12345, output_tokens: 678, cache_creation_input_tokens: 9012, cache_read_input_tokens: 34567 }
  const parsed = { model: 'claude-opus-4-8', totalUsage, usageByModel: { 'claude-opus-4-8': { ...totalUsage } } }
  const direct = costOfUsage(totalUsage, 'claude-opus-4-8')
  close(costOfParse(parsed), direct, 'single-model parse === costOfUsage(totalUsage)')
  // no usageByModel at all → totalUsage path
  close(costOfParse({ model: 'claude-opus-4-8', totalUsage }), direct, 'totalUsage fallback path')
})

test('costOfParse: mixed usageByModel sums per-model costOfUsage at each model rate', () => {
  const fableU = { ...U0, input_tokens: 100_000, output_tokens: 10_000 }
  const haikuU = { ...U0, input_tokens: 1_000_000 }
  const parsed = { model: 'claude-fable-5', usageByModel: { 'claude-fable-5': fableU, 'claude-haiku-4-5': haikuU } }
  // fable 100k in @$10 + 10k out @$50 = 1.0 + 0.5 = 1.5; haiku 1M in @$1 = 1.0
  close(costOfParse(parsed), 2.5, 'sum of per-model buckets')
  close(costOfParse(parsed), costOfUsage(fableU, 'claude-fable-5') + costOfUsage(haikuU, 'claude-haiku-4-5'), 'equals explicit per-model sum')
})

test('costOfParse: unknown-model bucket is priced at parsed.model tier', () => {
  const u = { ...U0, input_tokens: 1_000_000 }
  const parsed = { model: 'claude-fable-5', usageByModel: { unknown: u } }
  // priced as fable ($10/Mtok), not the sonnet fallback ($3/Mtok)
  close(costOfParse(parsed), 10, 'unknown bucket priced at parsed.model tier')
})

// ---------------------------------------------------------------------------
// dominantModel — cost-weighted, never token-weighted
// MUTATION-PROVED: inverted the comparison in dominantModel (observe-cost.mjs:95)
// `if (c > bestCost)` → `if (c < bestCost)` → "dominant by COST not tokens:
// 'claude-haiku-4-5' !== 'claude-fable-5'". Restored → green.
// ALSO PROVED against a token-sum rewrite: replaced the costOfUsage call with
// `input_tokens + output_tokens` → same red (haiku has ~10× the tokens but
// fewer dollars). Restored → green.

test('dominantModel: returns the model carrying the most COST, not the most tokens', () => {
  const parsed = {
    model: 'claude-haiku-4-5',
    usageByModel: {
      'claude-haiku-4-5': { ...U0, input_tokens: 1_000_000 },                      // $1.00, 1M tokens
      'claude-fable-5': { ...U0, input_tokens: 100_000, output_tokens: 10_000 },   // $1.50, 110k tokens
    },
  }
  assert.equal(dominantModel(parsed), 'claude-fable-5', 'dominant by COST not tokens')
})

test('dominantModel: single-model, null, and unknown-bucket edges', () => {
  assert.equal(dominantModel(null), null, 'null parse → null')
  const single = { model: 'claude-opus-4-8', usageByModel: { 'claude-opus-4-8': { ...U0, input_tokens: 5 } } }
  assert.equal(dominantModel(single), 'claude-opus-4-8', 'single bucket → that model')
  // no usageByModel at all → parsed.model
  assert.equal(dominantModel({ model: 'claude-sonnet-4-5' }), 'claude-sonnet-4-5')
  // 'unknown' winning bucket resolves to parsed.model, never the literal 'unknown'
  const mixed = {
    model: 'claude-fable-5',
    usageByModel: {
      unknown: { ...U0, input_tokens: 1_000_000 },              // fable-priced $10 — wins
      'claude-haiku-4-5': { ...U0, input_tokens: 1_000_000 },   // $1
    },
  }
  assert.equal(dominantModel(mixed), 'claude-fable-5', 'unknown winner resolves to parsed.model')
})

// ---------------------------------------------------------------------------
// naiveCostOfUsage
// MUTATION-PROVED: dropped cache_read_input_tokens from totalIn in naiveCostOfUsage
// (observe-cost.mjs:106) → "naive exact: 0.2 !== 1.1". Restored → green.

test('naiveCostOfUsage: all input classes at full input rate; exceeds cache-aware cost', () => {
  // fable, cache-read-heavy: read discount is where the savings live
  const usage = { input_tokens: 5000, output_tokens: 1000, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 90_000 }
  // (5000 + 10000 + 90000) * 10e-6 + 1000 * 50e-6 = 1.05 + 0.05
  const naive = naiveCostOfUsage(usage, 'claude-fable-5')
  close(naive, 1.1, 'naive exact')
  const aware = costOfUsage(usage, 'claude-fable-5')
  // aware = 5000*10e-6 + 10000*10e-6*1.25 + 90000*10e-6*0.10 + 1000*50e-6 = 0.05+0.125+0.09+0.05
  close(aware, 0.315, 'cache-aware exact')
  assert.ok(naive > aware, `naive (${naive}) must exceed cache-aware (${aware}) for cache-read-heavy usage`)
})
