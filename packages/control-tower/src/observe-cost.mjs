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
// fable-5 is its OWN tier: $10/$50 per Mtok (2× opus) — verified against the
// LiteLLM price DB and ccusage 2026-07-01; bucketing it as opus halved its cost.
export function tierFromModel(model) {
  if (!model) return 'sonnet'
  const m = String(model).toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('fable')) return 'fable'
  if (m.includes('opus')) return 'opus'
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
  // cache_creation is priced by TTL bucket (Anthropic): 5-minute writes ×1.25,
  // 1-HOUR writes ×2.0. Buckets come either pre-accumulated (cache_5m/_1h from
  // parseAgentTranscript totals) or raw (usage.cache_creation.ephemeral_*). Any
  // unbucketed remainder falls back to the legacy ×1.25. Verified vs ccusage.
  const cc = usage.cache_creation || null
  const b5 = usage.cache_5m_input_tokens != null ? usage.cache_5m_input_tokens : (cc ? cc.ephemeral_5m_input_tokens || 0 : null)
  const b1h = usage.cache_1h_input_tokens != null ? usage.cache_1h_input_tokens : (cc ? cc.ephemeral_1h_input_tokens || 0 : null)
  let createCost
  if (b5 != null || b1h != null) {
    const rest = Math.max(0, cacheCreate - (b5 || 0) - (b1h || 0))
    createCost = ((b5 || 0) * 1.25 + (b1h || 0) * 2.0 + rest * 1.25) * inRate
  } else {
    createCost = cacheCreate * inRate * 1.25
  }
  // cache_read: 0.10× read discount
  const readCost   = cacheRead   * inRate * 0.10
  // output
  const outputCost = outputTok * outRate

  return +(inputCost + createCost + readCost + outputCost).toFixed(8)
}

// Cost of a parseAgentTranscript result. Mixed-model transcripts (Fable→Opus
// refusal fallbacks, /model switches) carry usageByModel — price each model's
// bucket at its OWN rate and sum. Pricing the whole transcript at the first
// model's rate overcharged fallback sessions (fable in = 2× opus in).
export function costOfParse(parsed, price = PRICE) {
  if (!parsed) return 0
  const byModel = parsed.usageByModel
  const models = byModel ? Object.keys(byModel) : []
  if (models.length > 0) {
    let sum = 0
    for (const m of models) sum += costOfUsage(byModel[m], m === 'unknown' ? parsed.model : m, price)
    return +sum.toFixed(8)
  }
  return costOfUsage(parsed.totalUsage || {}, parsed.model, price)
}

// The model that carries the most cost in a parse — the honest "tier" for a
// mixed-model session (a fable session that spent 80% of its dollars on the
// Opus fallback is an opus session for attribution purposes).
export function dominantModel(parsed, price = PRICE) {
  if (!parsed) return null
  const byModel = parsed.usageByModel
  const models = byModel ? Object.keys(byModel) : []
  if (models.length <= 1) return parsed.model || models[0] || null
  let best = parsed.model, bestCost = -1
  for (const m of models) {
    const c = costOfUsage(byModel[m], m === 'unknown' ? parsed.model : m, price)
    if (c > bestCost) { bestCost = c; best = m === 'unknown' ? parsed.model : m }
  }
  return best
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
