// src/observe-cost.mjs — cache-aware cost calculation for native harness runs.
//
// The real harness transcripts (agent-*.jsonl) carry actual cache token counts.
// Standard `costOf(tier, inTok, outTok)` ignores cache; this module applies the
// Anthropic ephemeral-cache pricing convention:
//   - cache_creation tokens: input price × 1.25 (write premium)
//   - cache_read tokens:     input price × 0.10 (read discount)
//   - plain input_tokens:    input price × 1.00
//
// Caveat: these multipliers are derived from the Anthropic pricing convention,
// not from a live billing API. Actual invoiced cost may differ. This is the same
// honesty stance as /v1/about.

import { PRICE } from '../../workflow-lens/src/shim.mjs'

// Resolve the tier from a full model ID like 'claude-haiku-4-5-20251001'
// Falls back to 'sonnet' if unrecognized.
export function tierFromModel(model) {
  if (!model) return 'sonnet'
  const m = String(model).toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('opus') || m.includes('fable')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  return 'sonnet'
}

// usage: {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}
// model: the full model string (we derive the tier from it)
// price: optional price table override (default = shim.PRICE)
export function costOfUsage(usage, model, price = PRICE) {
  const tier = tierFromModel(model)
  const p = price[tier] || price.sonnet
  const inRate = p.in / 1e6       // $/tok
  const outRate = p.out / 1e6     // $/tok

  const inputTok    = usage.input_tokens || 0
  const outputTok   = usage.output_tokens || 0
  const cacheCreate = usage.cache_creation_input_tokens || 0
  const cacheRead   = usage.cache_read_input_tokens || 0

  // plain input (non-cache) cost
  const inputCost  = inputTok  * inRate
  // cache_creation: 1.25× write premium
  const createCost = cacheCreate * inRate * 1.25
  // cache_read: 0.10× read discount
  const readCost   = cacheRead   * inRate * 0.10
  // output
  const outputCost = outputTok * outRate

  return +(inputCost + createCost + readCost + outputCost).toFixed(8)
}

// Naive cost (no cache adjustment) — used to show savings vs. naive
export function naiveCostOfUsage(usage, model, price = PRICE) {
  const tier = tierFromModel(model)
  const p = price[tier] || price.sonnet
  const inRate = p.in / 1e6
  const outRate = p.out / 1e6
  const totalIn = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
  return +(totalIn * inRate + (usage.output_tokens || 0) * outRate).toFixed(8)
}
