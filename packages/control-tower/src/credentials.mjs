// src/credentials.mjs — boolean presence probe for API keys.
// NEVER reads the value; only checks if the env var is non-empty.
// This is the credential gate: fail-closed on live commands when no key is present.

export function probeCredentials(env = process.env) {
  return {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    openrouter: Boolean(env.OPENROUTER_API_KEY),
  }
}

// Get the key for a given provider. Throws MISSING_CREDENTIAL if absent.
// Called only when a live run is about to start — not during health checks.
export function requireKey(provider, env = process.env) {
  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) {
      const e = new Error('MISSING_CREDENTIAL: ANTHROPIC_API_KEY is not set. Set it before starting the server.')
      e.code = 'MISSING_CREDENTIAL'
      e.envVar = 'ANTHROPIC_API_KEY'
      e.provider = 'anthropic'
      throw e
    }
    return env.ANTHROPIC_API_KEY
  }
  if (provider === 'openrouter') {
    if (!env.OPENROUTER_API_KEY) {
      const e = new Error('MISSING_CREDENTIAL: OPENROUTER_API_KEY is not set.')
      e.code = 'MISSING_CREDENTIAL'
      e.envVar = 'OPENROUTER_API_KEY'
      e.provider = 'openrouter'
      throw e
    }
    return env.OPENROUTER_API_KEY
  }
  throw new Error(`Unknown provider: ${provider}`)
}
