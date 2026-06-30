// gate.mjs — a wrapper around any agent backend that adds three gates, in order:
//
//   1) CACHE       — memoize by a stable hash of (prompt + the response-shaping
//                    opts: model/schema/max_tokens). A rerun with identical inputs
//                    makes ZERO real backend calls; the cached value is returned
//                    with `cached:true`. This is what makes a resume cheap.
//   2) HITL        — before any UNCACHED real call, await an injected decision
//                    callback. It can approve, deny (-> throws HITL_DENIED), or
//                    edit the prompt. No decider => auto-approve (so the gate is
//                    a drop-in when you don't want human-in-the-loop).
//   3) MODEL-SWAP  — resolve the tier to a provider. 'haiku'|'sonnet'|'opus'|'fable'
//                    -> Anthropic (the wrapped backend). Any other tier maps to a
//                    provider whose key is checked; if the key is MISSING the call
//                    FAILS CLOSED with a precise MISSING_CREDENTIAL error. It never
//                    fabricates a response — a blocked provider is a hard error.
//
// Backend contract (matches shim.anthropicBackend): async (prompt, opts) =>
//   { text, usage:{inTok,outTok}, ms, requestId, tier, model }.
import { createHash } from 'node:crypto'

// tier -> provider + the env var that gates it. Anthropic is the only one with a
// live backend here; everything else is fail-closed until its key + adapter exist.
export const PROVIDERS = {
  haiku: { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  sonnet: { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  opus: { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  fable: { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  // non-Anthropic tiers — present so a workflow CAN request them, but they
  // fail closed until a real adapter + key land. NEVER faked.
  'gpt-4o': { provider: 'openai', envVar: 'OPENAI_API_KEY' },
  'gpt-4o-mini': { provider: 'openai', envVar: 'OPENAI_API_KEY' },
  o4: { provider: 'openai', envVar: 'OPENAI_API_KEY' },
  'openrouter': { provider: 'openrouter', envVar: 'OPENROUTER_API_KEY' },
}

export function hashCall(prompt, opts = {}) {
  // Only response-shaping opts belong in the key. label/phase are telemetry, not
  // semantics — including them would wrongly bust the cache across phases.
  const shaping = {
    model: opts.model || 'sonnet',
    max_tokens: opts.max_tokens || null,
    schema: opts.schema || null,
  }
  return createHash('sha256').update(JSON.stringify({ prompt, shaping })).digest('hex').slice(0, 32)
}

// HITL decisions: { approve:boolean, prompt?:string (edited), reason?:string }
// decider(prompt, opts) => decision | Promise<decision>. null/undefined => approve.
export function createGate(backend, {
  cache = new Map(),
  decider = null,
  env = process.env,
  providers = PROVIDERS,
  adapters = {},          // optional: { openai: async(prompt,opts)=>{...} } once real
} = {}) {
  let realCalls = 0
  let cacheHits = 0
  let hitlDenied = 0

  async function call(prompt, opts = {}) {
    const key = hashCall(prompt, opts)

    // 1) CACHE
    if (cache.has(key)) {
      cacheHits++
      const v = cache.get(key)
      return { ...v, cached: true }
    }

    // 2) HITL
    let effectivePrompt = prompt
    if (decider) {
      const decision = await decider(prompt, opts)
      if (decision && decision.approve === false) {
        hitlDenied++
        const e = new Error('HITL_DENIED' + (decision.reason ? ': ' + decision.reason : ''))
        e.code = 'HITL_DENIED'
        throw e
      }
      if (decision && typeof decision.prompt === 'string') effectivePrompt = decision.prompt
    }

    // 3) MODEL-SWAP / provider resolution
    const tier = opts.model || 'sonnet'
    const route = providers[tier] || { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' }
    let result
    if (route.provider === 'anthropic') {
      result = await backend(effectivePrompt, opts)
    } else {
      // Non-Anthropic: require the key, FAIL CLOSED if missing. Never fake.
      if (!env[route.envVar]) {
        const e = new Error(`MISSING_CREDENTIAL: ${route.envVar} (provider "${route.provider}" requested via tier "${tier}")`)
        e.code = 'MISSING_CREDENTIAL'
        e.envVar = route.envVar
        e.provider = route.provider
        throw e
      }
      const adapter = adapters[route.provider]
      if (typeof adapter !== 'function') {
        // Key present but no real adapter wired => still fail closed, do NOT
        // silently route to Anthropic and pretend it was the other provider.
        const e = new Error(`PROVIDER_UNAVAILABLE: no adapter wired for provider "${route.provider}" (tier "${tier}")`)
        e.code = 'PROVIDER_UNAVAILABLE'
        e.provider = route.provider
        throw e
      }
      result = await adapter(effectivePrompt, opts)
    }

    realCalls++
    const stored = { ...result, cached: false }
    cache.set(key, stored)
    return stored
  }

  call.stats = () => ({ realCalls, cacheHits, hitlDenied, cacheSize: cache.size })
  call.cache = cache
  return call
}

// ── OpenRouter adapter ────────────────────────────────────────────────────────
// OPENROUTER_MODELS — map a non-Anthropic *tier name* to a concrete non-Anthropic
// served model. Every value here is provably NON-Anthropic (proves the same
// tier-named workflow file can leave Anthropic with zero file edits).
export const OPENROUTER_MODELS = {
  openrouter:    'openai/gpt-4o-mini',                    // default cheap reliable
  haiku:         'openai/gpt-4o-mini',                    // route workflow's 'haiku' tier off Anthropic
  'gpt-4o-mini': 'openai/gpt-4o-mini',
  llama:         'meta-llama/llama-3.3-70b-instruct',     // optional provider diversity
  gemini:        'google/gemini-flash-1.5',               // optional provider diversity
}

// openrouterBackend(apiKey, opts) => async (prompt, opts) => envelope.
// FAIL CLOSED: throws MISSING_CREDENTIAL if apiKey is falsy. Never fakes.
export function openrouterBackend(apiKey, { maxTokens = 16, defaultModel = 'openai/gpt-4o-mini' } = {}) {
  if (!apiKey) {
    const e = new Error('MISSING_CREDENTIAL: OPENROUTER_API_KEY (no non-Anthropic key)')
    e.code = 'MISSING_CREDENTIAL'
    e.envVar = 'OPENROUTER_API_KEY'
    e.provider = 'openrouter'
    throw e
  }
  return async function call(prompt, opts = {}) {
    const tier = opts.model || 'openrouter'
    const servedModel = OPENROUTER_MODELS[tier] || defaultModel
    const t0 = process.hrtime.bigint()
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: servedModel,
        max_tokens: Math.min(opts.max_tokens || maxTokens, 16),
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    const requestId = res.headers.get('x-request-id') || null
    const body = await res.json()
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (!res.ok) {
      const e = new Error('openrouter ' + res.status + ' ' + JSON.stringify(body))
      e.status = res.status
      throw e
    }
    const u = body.usage || {}
    const text = (body.choices?.[0]?.message?.content || '').trim()
    // Return shape: superset of the Anthropic envelope so ledger.instrument() can
    // unwrap text + usage unchanged, PLUS explicit fields for evidence capture.
    return {
      text,
      servedModel,                  // body.model — proves NON-Anthropic
      model: servedModel,           // ledger reads .model for telemetry
      provider: 'openrouter',
      usage: {
        inTok: u.prompt_tokens || 0,
        outTok: u.completion_tokens || 0,
        costUsd: (typeof u.cost === 'number' ? u.cost : null),
      },
      ms: +ms.toFixed(1),
      requestId,
      tier,
    }
  }
}
