// router.mjs — cost-aware per-agent model router (A4).
//
// WHAT IT DOES
//   Intercepts every agent() call before it hits the real backend. Classifies
//   the task as 'easy' or 'hard' using a fast heuristic on the prompt text, then
//   routes accordingly:
//     easy  -> cheap model (OpenRouter 'openai/gpt-4o-mini' via openrouterBackend,
//               or Anthropic haiku as a fallback if no OpenRouter key)
//     hard  -> strong model (Anthropic sonnet via the given Anthropic backend)
//
//   The caller can also supply an explicit tier in opts.model — the router treats
//   that as an OVERRIDE (pass-through, no reclassification). This means existing
//   workflow files that already label agents are respected; the router adds value
//   only when the label is 'sonnet' (which it reclassifies based on content) or
//   when no label is given.
//
// HEURISTIC (fully deterministic, no LLM call)
//   Classifies 'easy' when the prompt matches any of:
//     - short prompt (<=80 chars after trim)
//     - explicit simple-answer signals: "yes or no", "one word", "just the number",
//       "true or false", "reply with", "single word/letter"
//     - arithmetic-only prompts: digits and operators, no commas/logic words
//   Otherwise 'hard'.
//   The heuristic is intentionally conservative: it only downgrades to cheap when
//   there's a strong signal the task is trivial. Ambiguous -> stays strong.
//
// HONEST SCOPE
//   This is a CLASSIFICATION + ROUTING layer, not a quality judge. It can be wrong
//   on edge cases (a 20-char prompt may be genuinely hard; a 500-char prompt may
//   be a list of facts). The key claim we prove in the POC is: given a fixture
//   with explicitly-labelled easy/hard agents, the router correctly identifies them
//   AND produces a measured total cost that is LESS than the all-strong baseline,
//   with real request-ids from both backends as citations.

// ── Classification ────────────────────────────────────────────────────────────

const EASY_SIGNALS = [
  /\byes or no\b/i,
  /\bone word\b/i,
  /\bjust the number\b/i,
  /\btrue or false\b/i,
  /\breply with\b/i,
  /\bsingle (word|letter|character)\b/i,
  /\banswer with\b/i,
  /\bonly (the )?(number|word|letter)\b/i,
]

// Arithmetic-only: digits, operators, spaces — no alphabetic complexity signals.
const ARITHMETIC_RE = /^[\d\s\+\-\*\/\%\^\(\)\.=\?]+$/

export function classify(prompt) {
  const t = prompt.trim()
  // Very short prompts are almost always simple
  if (t.length <= 80) return 'easy'
  // Explicit simple-answer signals
  for (const sig of EASY_SIGNALS) {
    if (sig.test(t)) return 'easy'
  }
  // Pure arithmetic
  if (ARITHMETIC_RE.test(t)) return 'easy'
  return 'hard'
}

// ── Routing decision ──────────────────────────────────────────────────────────

export function routeTier(prompt, opts = {}, { forceRoute = false } = {}) {
  // If the caller explicitly set a tier AND we're not in force-route mode, respect it.
  const requestedTier = opts.model
  if (requestedTier && !forceRoute) {
    // Pass-through for non-Anthropic tiers (already cheap/specific)
    if (requestedTier !== 'sonnet' && requestedTier !== 'opus') {
      return { tier: requestedTier, decision: 'passthrough', classification: null }
    }
    // For strong tiers, still reclassify in force-route mode; in normal mode respect.
    if (!forceRoute) {
      return { tier: requestedTier, decision: 'passthrough', classification: null }
    }
  }
  const classification = classify(prompt)
  if (classification === 'easy') {
    return { tier: 'cheap', decision: 'routed-down', classification }
  }
  return { tier: requestedTier || 'sonnet', decision: 'kept-strong', classification }
}

// ── Router backend factory ────────────────────────────────────────────────────

// createRouter(strongBackend, cheapBackend, opts?) -> routerBackend
//   strongBackend: Anthropic backend (anthropicBackend(key))
//   cheapBackend:  OpenRouter backend (openrouterBackend(key)) OR null (falls back to haiku)
//   opts.forceRoute: ignore explicit model labels and always reclassify (default false)
//   opts.onRoute: optional callback (prompt, opts, decision) => void — for logging/testing
//
// The returned backend is a drop-in replacement for agent(): same signature, same
// return shape. It adds two extra fields to the result:
//   result.routedTier     — the tier that was actually used
//   result.routeDecision  — 'routed-down' | 'kept-strong' | 'passthrough'
//   result.classification — 'easy' | 'hard' | null (null when passthrough)

export function createRouter(strongBackend, cheapBackend, {
  forceRoute = false,
  onRoute = null,
} = {}) {
  if (typeof strongBackend !== 'function') throw new Error('createRouter: strongBackend must be a function')

  return async function routerBackend(prompt, opts = {}) {
    const { tier, decision, classification } = routeTier(prompt, opts, { forceRoute })

    if (onRoute) onRoute(prompt, opts, { tier, decision, classification })

    let result
    if (tier === 'cheap') {
      // Use cheap backend; if none wired, fall back to haiku on Anthropic
      if (cheapBackend) {
        result = await cheapBackend(prompt, { ...opts, model: 'gpt-4o-mini', max_tokens: opts.max_tokens || 24 })
      } else {
        result = await strongBackend(prompt, { ...opts, model: 'haiku', max_tokens: opts.max_tokens || 24 })
      }
    } else {
      result = await strongBackend(prompt, { ...opts, max_tokens: opts.max_tokens || 64 })
    }

    return {
      ...result,
      routedTier: tier,
      routeDecision: decision,
      classification,
    }
  }
}
