// instrument.mjs — configurable workflow rewriter extending inject.mjs.
//
// WHAT IT DOES
//   Builds on the proven inject.mjs offset-splice engine to produce a fully
//   configurable instrumentation pass. The public surface is:
//
//     instrument(src, config) => { instrumentedSource, wrappedCallSites,
//                                  injectedSteps, config, manifest,
//                                  alreadyInstrumented }
//     apply(src, config) => { written:[{path,role}], ...instrument result }
//
// CONFIG MATRIX (every field independently togglable; defaults = no-op parity)
//
//   mode: 'rewrite' | 'sibling'   (default 'sibling')
//
//   channels:
//     logTrace:  true             inject __trace preamble (logTrace-only baseline)
//     beacon: { enabled:false, bridgeUrl, events, model }
//
//   policy:
//     cache:   false              in-run Map dedupe of identical agent() calls
//     callCap: null               integer N — throw WFLENS_CALL_CAP past N calls
//     rerouteModel: null          map {sonnet:'haiku'} — rewrite opts.model tier
//
//   hooks:
//     conditionalShunt: null      { endpoint, decideModel, map, targets }
//     escapeHatch:      null      { flagLabels, provider, model, bridgeUrl, keyEnv }
//
//   emit: 'log', traceFn: '__trace'   (overridable for tests)
//
// HONESTY / CAVEATS
//   - Wall clock is banned in the harness body. __trace records structure and
//     order; timing comes from the external shim/observer.
//   - beacon + escapeHatch inject real subagent() steps (costs one cheap Haiku
//     call each). They are visible to the subagent — benign rewrites only.
//   - rerouteModel and conditionalShunt only accept Anthropic tiers (haiku /
//     sonnet / opus / fable) because in-harness agent(model) is Anthropic-only.
//     Non-Anthropic routing MUST go through escapeHatch (which Bash-curls the
//     provider), never through a bare opts.model rename.
//
// RESUME SAFETY
//   The injected preamble uses ONLY log(), string ops, Map, closure counters,
//   and plain JS — NO Date, Math.random(), new Date(), fetch, require, or import.
//   Instrumented output MUST pass ast.lint() before apply() writes it.

import { writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { transform } from './inject.mjs'
import { lint } from './ast.mjs'

// ── PRELUDE_MARKER (from inject.mjs — must match) ────────────────────────────
// We detect it to skip already-instrumented sources.
const PRELUDE_MARKER = 'auto-instrumentation prelude (injected by inject.mjs)'
// Our own marker for the extended preamble.
const INSTRUMENT_MARKER = 'WFLENS_INSTRUMENT_PRELUDE'

// ── Anthropic tiers: the only tiers in-harness agent(model) accepts ──────────
const ANTHROPIC_TIERS = new Set(['haiku', 'sonnet', 'opus', 'fable'])

// ── config normalization ──────────────────────────────────────────────────────
function normalizeConfig(raw = {}) {
  const channels = raw.channels || {}
  const policy = raw.policy || {}
  const hooks = raw.hooks || {}
  return {
    mode: raw.mode === 'rewrite' ? 'rewrite' : 'sibling',
    channels: {
      logTrace: channels.logTrace !== false,   // default ON
      beacon: channels.beacon
        ? {
            enabled: channels.beacon.enabled !== false,
            bridgeUrl: channels.beacon.bridgeUrl || 'http://localhost:8787',
            events: channels.beacon.events || ['run-start', 'phase', 'run-end'],
            model: channels.beacon.model || 'haiku',
          }
        : { enabled: false, bridgeUrl: 'http://localhost:8787', events: ['run-start', 'phase', 'run-end'], model: 'haiku' },
    },
    policy: {
      cache: !!policy.cache,
      callCap: (typeof policy.callCap === 'number' && policy.callCap > 0) ? policy.callCap : null,
      onCap: policy.onCap === 'skip' ? 'skip' : 'throw',
      rerouteModel: (policy.rerouteModel && typeof policy.rerouteModel === 'object') ? policy.rerouteModel : null,
    },
    hooks: {
      conditionalShunt: hooks.conditionalShunt || null,
      escapeHatch: hooks.escapeHatch || null,
    },
    emit: raw.emit || 'log',
    traceFn: raw.traceFn || '__trace',
  }
}

// ── tiny inline string hash (no crypto — crypto is undefined in the sandbox) ─
// FNV-1a 32-bit over the chars of the string.  Good enough to dedupe prompts.
function inlineHashFn() {
  return `
function __wflensHash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16)
}`
}

// ── deterministic instrumentationId ──────────────────────────────────────────
// Computed at instrument() time (NOT at runtime — no Date/Math.random allowed
// in the workflow body). Uses the same FNV-1a 32-bit hash as the cache wrapper,
// applied to the workflow name + a fixed salt. The result is baked as a string
// literal into the instrumented preamble so the beacon payload can carry it.
const INSTRUMENTATION_ID_SALT = 'wflens-v1'
function computeInstrumentationId(workflowName) {
  const input = INSTRUMENTATION_ID_SALT + ':' + (workflowName || 'unknown')
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ── build the extended preamble ───────────────────────────────────────────────
// The preamble is injected right after the `export const meta` declaration.
// It uses the mutable-globals trick: reassigns `agent` (and conditionally `log`)
// to wrappers at the TOP of the body so every later call site resolves to the
// wrapper — no call-site splice needed for the policy/hook layers.
//
// ORDER of layers (each wraps the previous agent):
//   1. logTrace         — keeps inject.mjs's __trace prelude verbatim
//   2. rerouteModel     — wraps agent to rewrite opts.model before delegating
//   3. cache            — wraps agent with a Map dedupe
//   4. callCap          — wraps agent with a counter that throws/skips past cap
//   5. conditionalShunt — injects a decision agent() before the body runs
//   6. escapeHatch      — for each flagged label, the escapeHatch wrapper checks
//                         opts.label and, if matched, substitutes an inline
//                         Bash-curl call instead of the real backend
//   7. beacon           — run-start / run-end beacons bracket the body;
//                         phase beacons are injected INLINE at each phase() splice
//                         (separate from the preamble)
function buildPreamble(cfg, wrappedCallSites, instrumentationId) {
  const { emit, traceFn, channels, policy, hooks } = cfg
  const parts = []

  // ── 0. INSTRUMENT_MARKER (idempotence) ────────────────────────────────────
  parts.push(`// ── ${INSTRUMENT_MARKER} ── configurable rewriter (instrument.mjs) ──`)

  // ── 0a. Bake the instrumentationId as a const + emit a meta trace ──────────
  // The instrumentationId is computed at instrument() time (deterministic, no
  // Date/random). Baking it as a const lets beacon payloads carry it so the
  // bridge can correlate beacons to runs without requiring a runId (which the
  // workflow body cannot know).
  parts.push(`const __wflensInstrumentationId = ${JSON.stringify(instrumentationId)}`)
  parts.push(`try { ${emit}('WFLENS_TRACE ' + JSON.stringify({ kind: 'meta', ev: 'instrumented', instrumentationId: __wflensInstrumentationId, name: (typeof meta !== 'undefined' && meta && meta.name) || null })) } catch (__e) {}`)

  // ── 1. logTrace (always on unless explicitly disabled) ─────────────────────
  // The __trace prelude from inject.mjs is already injected when we delegate to
  // transform(); we don't re-inject it here — it's IN the instrumentedSource
  // we base our work on.  The mutable-global wrappers below emit WFLENS_TRACE
  // lines using the same seq counter (__traceSeq) + ${traceFn} function that
  // inject already placed.  They call ${traceFn} directly so the trace seq is
  // shared and monotonically increasing across all layers.

  // ── helper: tiny string hash (used by cache) ──────────────────────────────
  if (policy.cache) {
    parts.push(inlineHashFn())
  }

  // ── 2. Save original agent so wrappers can delegate ───────────────────────
  parts.push(`let __wflensAgent = agent`)

  // ── 3. rerouteModel wrapper ───────────────────────────────────────────────
  if (policy.rerouteModel) {
    const mapLit = JSON.stringify(policy.rerouteModel)
    parts.push(`
// policy.rerouteModel — rewrite opts.model tier before delegating
const __wflensRerouteMap = ${mapLit}
const __wflensAgentBeforeReroute = __wflensAgent
__wflensAgent = function __wflensReroutedAgent(prompt, opts) {
  const __fromTier = (opts && opts.model) || 'sonnet'
  const __toTier = __wflensRerouteMap[__fromTier]
  if (__toTier) {
    try { ${emit}('WFLENS_TRACE ' + JSON.stringify({ ev: 'reroute', from: __fromTier, to: __toTier })) } catch (__e) {}
    return __wflensAgentBeforeReroute(prompt, Object.assign({}, opts || {}, { model: __toTier }))
  }
  return __wflensAgentBeforeReroute(prompt, opts)
}`)
  }

  // ── 4. cache wrapper ──────────────────────────────────────────────────────
  if (policy.cache) {
    parts.push(`
// policy.cache — in-run Map dedupe; repeat identical (prompt+model) returns memo
const __wflensCache = new Map()
const __wflensAgentBeforeCache = __wflensAgent
__wflensAgent = function __wflensCachedAgent(prompt, opts) {
  const __cacheKey = __wflensHash(JSON.stringify({ p: prompt, m: (opts && opts.model) || 'sonnet' }))
  if (__wflensCache.has(__cacheKey)) {
    const __memo = __wflensCache.get(__cacheKey)
    try { ${emit}('WFLENS_TRACE ' + JSON.stringify({ ev: 'cache-hit', key: __cacheKey.slice(0, 8), label: (opts && opts.label) || null })) } catch (__e) {}
    return Promise.resolve(__memo)
  }
  const __p = __wflensAgentBeforeCache(prompt, opts)
  if (__p && typeof __p.then === 'function') {
    return __p.then(function(__v) { __wflensCache.set(__cacheKey, __v); return __v })
  }
  __wflensCache.set(__cacheKey, __p)
  return __p
}`)
  }

  // ── 5. callCap wrapper ────────────────────────────────────────────────────
  if (policy.callCap !== null) {
    const onCap = policy.onCap === 'skip' ? 'skip' : 'throw'
    parts.push(`
// policy.callCap — hard ceiling on real agent() calls
let __wflensCallCount = 0
const __wflensCap = ${policy.callCap}
const __wflensOnCap = ${JSON.stringify(onCap)}
const __wflensAgentBeforeCap = __wflensAgent
__wflensAgent = function __wflensCapAgent(prompt, opts) {
  __wflensCallCount++
  if (__wflensCallCount > __wflensCap) {
    try { ${emit}('WFLENS_TRACE ' + JSON.stringify({ ev: 'cap-trip', count: __wflensCallCount, cap: __wflensCap, label: (opts && opts.label) || null })) } catch (__e) {}
    if (__wflensOnCap === 'skip') return Promise.resolve(null)
    throw new Error('WFLENS_CALL_CAP: real agent calls exceeded cap ' + __wflensCap)
  }
  return __wflensAgentBeforeCap(prompt, opts)
}`)
  }

  // ── 6. escapeHatch wrapper ─────────────────────────────────────────────────
  // For calls whose opts.label matches flagLabels, replace with an injected
  // subagent that Bash-curls a non-Anthropic provider.
  // HONEST: in-harness agent(model) only accepts Anthropic tiers; to use a
  // non-Anthropic provider the ONLY faithful path is a subagent that shells out.
  if (hooks.escapeHatch) {
    const esc = hooks.escapeHatch
    const labelsLit = JSON.stringify(esc.flagLabels || [])
    const provider = esc.provider || 'openrouter'
    const model = esc.model || 'openai/gpt-4o-mini'
    const bridgeUrl = esc.bridgeUrl || null
    const keyEnv = esc.keyEnv || 'OPENROUTER_API_KEY'
    // Build the escape block using string concatenation to avoid template-literal
    // escaping issues with nested quotes in the curl command.
    const escProviderLit = JSON.stringify(provider)
    const escModelLit = JSON.stringify(model)
    const escKeyEnvLit = JSON.stringify(keyEnv)
    const escBlock = [
      '// hooks.escapeHatch — route flagged labels to a non-Anthropic provider via Bash subagent',
      '// HONEST: in-harness agent(model) is Anthropic-only; non-Anthropic needs a subagent Bash-curl',
      `const __wflensEscapeLabels = new Set(${labelsLit})`,
      'const __wflensAgentBeforeEscape = __wflensAgent',
      '__wflensAgent = function __wflensEscapeAgent(prompt, opts) {',
      '  const __label = (opts && opts.label) || null',
      '  if (__label && __wflensEscapeLabels.has(__label)) {',
      `    try { ${emit}('WFLENS_TRACE ' + JSON.stringify({ ev: 'escape', provider: ${escProviderLit}, model: ${escModelLit}, label: __label })) } catch (__e) {}`,
      '    const __escModel = ' + escModelLit,
      '    const __escKeyEnv = ' + escKeyEnvLit,
      "    const __escPrompt = 'You have a Bash tool. Run this curl and reply ONLY with the text from choices[0].message.content:\\n' +",
      "      'curl -s -X POST https://openrouter.ai/api/v1/chat/completions' +",
      "      ' -H \"Authorization: Bearer $' + __escKeyEnv + '\"' +",
      "      ' -H \"Content-Type: application/json\"' +",
      "      ' -d \\'{\"model\":\"' + __escModel + '\",\"max_tokens\":64,\"messages\":[{\"role\":\"user\",\"content\":\"' + prompt.replace(/\"/g, '\\\\\"') + '\"}]}\\''",
      "    return agent(__escPrompt, { model: 'haiku', label: '__wflens_escape_' + __label })",
      '  }',
      '  return __wflensAgentBeforeEscape(prompt, opts)',
      '}',
    ].join('\n')
    parts.push(escBlock)
  }

  // ── 7. Re-assign the mutable global ───────────────────────────────────────
  // After all wrappers are built, overwrite `agent` so all subsequent call
  // sites in the body resolve to the fully-stacked wrapper.
  parts.push(`
// Overwrite the mutable injected global so all later call sites use the wrapper stack
agent = __wflensAgent`)

  return parts.join('\n')
}

// ── Beacon injection helpers ─────────────────────────────────────────────────
// A beacon is a dedicated agent() call that Bash-curls POST /v1/observe.
// It is wrapped in try/catch so a downed bridge NEVER fails the workflow.
// The instrumentationId is included in the payload so the bridge can correlate
// beacons to runs without requiring a runId (which the body cannot know).
function beaconAgentCode(ev, bridgeUrl, model, emit, instrumentationId, extraFields = {}) {
  // Build the payload with instrumentationId included as a literal value.
  // We use the baked __wflensInstrumentationId const so the value lives in the
  // instrumented source without relying on any runtime non-determinism.
  // Since the const is baked at instrument() time, we inline it directly.
  const payload = JSON.stringify({ instrumentationId, ev, ...extraFields })
  const curlCmd = `curl -s -X POST ${bridgeUrl}/v1/observe -H 'Content-Type: application/json' -d '${payload.replace(/'/g, "\\'")}' ; echo OK`
  return `try {
  await agent(
    'You have a Bash tool. Run exactly: ${curlCmd.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}\\nReply: OK',
    { model: ${JSON.stringify(model)}, label: '__wflens_beacon_${ev}' }
  )
} catch (__beaconErr) {
  try { ${emit}('WFLENS_TRACE ' + JSON.stringify({ ev: 'beacon-fail', beaconEv: '${ev}', error: String((__beaconErr && __beaconErr.message) || __beaconErr) })) } catch (__e) {}
}`
}

// ── conditionalShunt injection ────────────────────────────────────────────────
// Injects a decision agent that curls an endpoint and returns a tier word,
// then rewrites opts.model for target call sites.
// Mirrors the proven wf_8de34f64-90f pattern.
function buildShuntCode(shunt, emit) {
  const { endpoint, decideModel = 'haiku', map = {}, targets = [] } = shunt
  const mapLit = JSON.stringify(map)
  const targetsLit = JSON.stringify(targets)
  return `
// hooks.conditionalShunt — decision agent curls endpoint -> downstream targets get that tier
// Mirrors proven wf_8de34f64-90f: decision on haiku, work on decided tier
const __wflensShuntDecision = await agent(
  'You have a Bash tool. Run exactly: curl -s ${endpoint} ; Reply with a single lowercase word (one of: haiku, sonnet, opus, fable) for the model tier to use. No other text.',
  { model: ${JSON.stringify(decideModel)}, label: '__wflens_decide' }
)
const __wflensShuntRaw = (typeof __wflensShuntDecision === 'string' ? __wflensShuntDecision : '').trim().toLowerCase()
const __wflensShuntMap = ${mapLit}
const __wflensShuntTier = __wflensShuntMap[__wflensShuntRaw] || __wflensShuntRaw || 'sonnet'
const __wflensShuntTargets = new Set(${targetsLit})
try { ${emit}('WFLENS_TRACE ' + JSON.stringify({ ev: 'shunt', decisionRaw: __wflensShuntRaw, chosenTier: __wflensShuntTier })) } catch (__e) {}
// Wrap agent so target labels get the decided tier
const __wflensAgentPreShunt = agent
agent = function __wflensShuntedAgent(prompt, opts) {
  const __label = (opts && opts.label) || null
  if (__label && __wflensShuntTargets.has(__label)) {
    return __wflensAgentPreShunt(prompt, Object.assign({}, opts || {}, { model: __wflensShuntTier }))
  }
  return __wflensAgentPreShunt(prompt, opts)
}
__wflensAgent = agent
`
}

// ── extract workflow name from source ─────────────────────────────────────────
// Parses `name: '<value>'` from the meta object literal.
// Used to compute a stable instrumentationId at instrument() time.
function extractWorkflowName(src) {
  const m = src.match(/name\s*:\s*['"]([^'"]+)['"]/)
  return m ? m[1] : 'unknown'
}

// ── main instrument() function ────────────────────────────────────────────────
/**
 * instrument(src, config?) => {
 *   instrumentedSource,   // valid workflow string
 *   wrappedCallSites,     // from inject.transform
 *   injectedSteps,        // [{kind, where, model}]
 *   config,               // normalized config applied
 *   manifest,             // {mode, channels, policy, hooks}
 *   alreadyInstrumented,  // idempotence flag
 *   instrumentationId,    // stable id baked into the preamble (for beacon correlation)
 * }
 */
export function instrument(src, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig)

  // Compute a stable instrumentationId from the workflow name.
  // This is done at instrument() time (outside the workflow body) so it is
  // deterministic and safe (no Date/Math.random in the body).
  const workflowName = extractWorkflowName(src)
  const instrumentationId = computeInstrumentationId(workflowName)

  // Idempotence: detect already-instrumented by instrument.mjs.
  if (src.includes(INSTRUMENT_MARKER)) {
    return {
      instrumentedSource: src,
      wrappedCallSites: [],
      injectedSteps: [],
      config: cfg,
      manifest: buildManifest(cfg),
      alreadyInstrumented: true,
      instrumentationId,
    }
  }

  // Step 1: run the base inject.transform() to get the __trace preamble +
  //         call-site wrapping.  This gives us the logTrace baseline for free.
  const { instrumentedSource: baseSource, wrappedCallSites, alreadyInstrumented: baseAlready } = transform(src, {
    emit: cfg.emit,
    traceFn: cfg.traceFn,
  })

  if (baseAlready && !src.includes(INSTRUMENT_MARKER)) {
    // Source was already inject-transformed but not instrument-transformed.
    // We proceed to add our extended preamble on top of it.
  }

  const injectedSteps = []

  // Step 2: find the insertion point — right after the inject-prelude block.
  // The inject prelude ends with:  // ── end auto-instrumentation prelude ───
  // We insert our extended preamble right after it.
  const INJECT_END_MARKER = '// ── end auto-instrumentation prelude ─'
  const injectEndIdx = baseSource.indexOf(INJECT_END_MARKER)
  if (injectEndIdx === -1) {
    throw new Error('instrument: could not locate inject prelude end marker; source may not have been inject-transformed')
  }
  const injectEndLineEnd = baseSource.indexOf('\n', injectEndIdx)
  const insertAfter = injectEndLineEnd + 1  // insert at the start of the next line

  // Step 3: build the extended preamble
  const extPreamble = '\n' + buildPreamble(cfg, wrappedCallSites, instrumentationId) + '\n'

  // Step 4: handle beacon run-start / conditionalShunt / beacon run-end
  // These are body-level injections: they go AFTER the preamble, before the
  // rest of the body.  We find the position after the entire prelude block.
  const afterPreamble = insertAfter

  const bodyInjections = []

  // beacon run-start
  if (cfg.channels.beacon.enabled && cfg.channels.beacon.events.includes('run-start')) {
    bodyInjections.push(beaconAgentCode('run-start', cfg.channels.beacon.bridgeUrl, cfg.channels.beacon.model, cfg.emit, instrumentationId))
    injectedSteps.push({ kind: 'beacon', where: 'run-start', model: cfg.channels.beacon.model })
  }

  // conditionalShunt
  if (cfg.hooks.conditionalShunt) {
    bodyInjections.push(buildShuntCode(cfg.hooks.conditionalShunt, cfg.emit))
    injectedSteps.push({ kind: 'shunt', where: 'run-start', model: cfg.hooks.conditionalShunt.decideModel || 'haiku' })
  }

  // beacon run-end: inject at the VERY END of the body (before final return).
  // We handle this by wrapping the body in a try/finally if beacon is enabled.
  // Actually: simpler — we detect the last return statement and insert before it.
  // Even simpler: append to the end of the source, which works for top-level awaits.
  // The plan says: "run-start/run-end beacons bracket the body".
  // We use a wrapper approach: inject run-end just before the last return,
  // or append a run-end call after the body if there is no explicit return.

  // Step 5: assemble the final source
  // Slice: [0, insertAfter) + extPreamble + bodyInjections + [insertAfter, end)
  let result = baseSource.slice(0, insertAfter) + extPreamble
  if (bodyInjections.length > 0) {
    result += '\n// ── WFLENS body injections ──\n'
    result += bodyInjections.join('\n') + '\n'
  }
  result += baseSource.slice(insertAfter)

  // Step 6: inject run-end beacon at the END of the body
  if (cfg.channels.beacon.enabled && cfg.channels.beacon.events.includes('run-end')) {
    const endBeaconCode = '\n// ── WFLENS run-end beacon ──\n' +
      beaconAgentCode('run-end', cfg.channels.beacon.bridgeUrl, cfg.channels.beacon.model, cfg.emit, instrumentationId) + '\n'
    // Insert BEFORE the last top-level `return` statement so the beacon actually
    // executes (a `return` exits the workflow immediately — anything after it is
    // dead code). Heuristic: last occurrence of `return ` at column 0 (top-level),
    // tolerant of trailing whitespace/newlines (real workflows end with a newline,
    // so anchoring on end-of-string would never match and would append dead code).
    const lastReturnMatch = result.match(/\nreturn (?:[^\n]*)/g)
    if (lastReturnMatch && lastReturnMatch.length > 0) {
      const lastReturnStr = lastReturnMatch[lastReturnMatch.length - 1]
      const lastReturnIdx = result.lastIndexOf(lastReturnStr)
      result = result.slice(0, lastReturnIdx) + endBeaconCode + result.slice(lastReturnIdx)
    } else {
      result += endBeaconCode
    }
    injectedSteps.push({ kind: 'beacon', where: 'run-end', model: cfg.channels.beacon.model })
  }

  // Step 7: lint the output — MUST be clean (no banned globals introduced)
  const lintResult = lint(result)
  if (!lintResult.ok) {
    const errs = lintResult.findings.filter(f => f.severity === 'error')
    if (errs.length > 0) {
      throw new Error('instrument: instrumented output failed lint:\n' + errs.map(f => `  [${f.rule}] ${f.message}`).join('\n'))
    }
  }

  return {
    instrumentedSource: result,
    wrappedCallSites,
    injectedSteps,
    config: cfg,
    manifest: buildManifest(cfg),
    alreadyInstrumented: false,
    instrumentationId,
    lintOk: lintResult.ok,
    lintFindings: lintResult.findings,
  }
}

function buildManifest(cfg) {
  return {
    mode: cfg.mode,
    channels: {
      logTrace: cfg.channels.logTrace,
      beacon: cfg.channels.beacon,
    },
    policy: cfg.policy,
    hooks: {
      conditionalShunt: cfg.hooks.conditionalShunt ? true : false,
      escapeHatch: cfg.hooks.escapeHatch ? true : false,
    },
  }
}

// ── apply(src, config) — write to disk per mode ───────────────────────────────
/**
 * apply(src, config, { filePath }) => { written:[{path,role}], ...instrument result }
 *
 * mode:'rewrite' — copies original to <file>.backup (refuses to clobber existing),
 *                  then overwrites <file> with instrumentedSource.
 * mode:'sibling' — writes <dir>/<name>.instrumented.workflow.js,
 *                  leaves original untouched.
 *
 * filePath is required for write modes.
 */
export function apply(src, rawConfig = {}, { filePath } = {}) {
  const result = instrument(src, rawConfig)
  if (result.alreadyInstrumented) {
    return { written: [], ...result }
  }

  if (!filePath) {
    throw new Error('apply: filePath is required to write output')
  }

  const absPath = resolve(filePath)
  const dir = dirname(absPath)
  const name = basename(absPath).replace(/\.workflow\.js$/, '').replace(/\.js$/, '')
  const written = []

  if (result.config.mode === 'rewrite') {
    const backupPath = absPath + '.backup'
    if (!existsSync(backupPath)) {
      copyFileSync(absPath, backupPath)
      written.push({ path: backupPath, role: 'backup' })
    }
    writeFileSync(absPath, result.instrumentedSource, 'utf8')
    written.push({ path: absPath, role: 'instrumented' })
  } else {
    // sibling
    const sibPath = resolve(dir, name + '.instrumented.workflow.js')
    writeFileSync(sibPath, result.instrumentedSource, 'utf8')
    written.push({ path: sibPath, role: 'instrumented' })
  }

  return { written, ...result }
}

// Re-export as applyInstrument alias
export { apply as applyInstrument }
