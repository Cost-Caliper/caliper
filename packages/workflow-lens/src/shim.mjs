// shim.mjs — the proven Claude Code workflow runtime shim (zero installs).
//
// Loads a Claude-authored workflow .js file UNMODIFIED and runs it under the
// injected-globals contract: agent / parallel / pipeline / phase / log / args /
// budget / workflow. The whole point is to run the file exactly as the real
// harness would, so the AST graph, telemetry and HTML render describe the file
// that will actually ship — no edits, no transpile.
//
// The `agent` backend is PLUGGABLE: pass your own callable (e.g. the cached /
// HITL / fail-closed gate from gate.mjs, or a deterministic stub for tests).
// `runWorkflow` wires the other globals around whatever ledger / budget you give
// it so concurrency (parallel/pipeline) is genuinely exercised and recorded.
import { readFileSync } from 'node:fs'

export const MODELS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-8', fable: 'claude-opus-4-8' }
// $/Mtok. Mirrors the live-measured price table; ledger.mjs derives costUsd from this.
export const PRICE = { haiku: { in: 1.0, out: 5.0 }, sonnet: { in: 3.0, out: 15.0 }, opus: { in: 5.0, out: 25.0 } }

// Strip `export ` off the meta declaration and async-function-wrap the body so a
// top-level `return` / `await` is legal. Returns the raw src + the callable fn.
export function loadWorkflow(path) {
  const src = readFileSync(path, 'utf8')
  return { src, fn: compileWorkflow(src) }
}
export function compileWorkflow(src) {
  const stripped = src.replace(/^export\s+const\s+meta\s*=\s*/m, 'const meta = ')
  const wrapped =
    '(async function(agent, parallel, pipeline, phase, log, args, budget, workflow){\n' +
    stripped +
    '\n})'
  return (0, eval)(wrapped)
}

// A workflow may carry `export const meta = {...}`; pull the literal out cheaply
// for labels without executing the body (ast.mjs does the rigorous version).
export function readMetaName(src) {
  const m = src.match(/name\s*:\s*['"`]([^'"`]+)['"`]/)
  return m ? m[1] : null
}

// ── parallel / pipeline that match the documented semantics ──────────────────
// parallel(thunks) => BARRIER awaiting all; a throwing thunk resolves to null.
export function makeParallel() {
  return (thunks) => Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null)))
}
// pipeline(items, ...stages) => each item flows through every stage with NO
// barrier between stages; stage cb gets (prev, item, index); a throw drops the
// item to null (and short-circuits its remaining stages).
export function makePipeline() {
  return (items, ...stages) =>
    Promise.all(
      (items || []).map(async (item, index) => {
        let prev = item
        for (const stage of stages) {
          try { prev = await stage(prev, item, index) } catch { return null }
        }
        return prev
      }),
    )
}

// ── budget: HARD ceiling. agent() throws once spent() >= total. total:null => Infinity.
export function makeBudget(total = null) {
  let spent = 0
  return {
    get total() { return total },
    spent: () => spent,
    remaining: () => (total == null ? Infinity : total - spent),
    _charge(n) { spent += n },          // ledger/gate call this with real costUsd
    _check() {
      if (total != null && spent >= total) {
        const e = new Error(`BUDGET_EXCEEDED: spent ${spent.toFixed(6)} >= total ${total}`)
        e.code = 'BUDGET_EXCEEDED'
        throw e
      }
    },
  }
}

// Run a workflow file under a supplied agent backend + globals.
//   g.agent     required callable(prompt, opts) -> string | object (schema) | null
//   g.phase/log optional sinks (default no-op collectors)
//   g.args      optional args value
//   g.budget    optional budget (default unbounded)
//   g.parallel/g.pipeline/g.workflow optional overrides
export async function runWorkflow(path, g = {}) {
  const { src, fn } = loadWorkflow(path)
  const phases = []
  const logs = []
  const globals = {
    agent: g.agent,
    parallel: g.parallel || makeParallel(),
    pipeline: g.pipeline || makePipeline(),
    phase: g.phase || ((title) => { phases.push({ title, at: phases.length }) }),
    log: g.log || ((m) => { logs.push(String(m)) }),
    args: g.args ?? {},
    budget: g.budget || makeBudget(null),
    workflow: g.workflow || (async () => null),
  }
  if (typeof globals.agent !== 'function') throw new Error('runWorkflow: g.agent must be a callable backend')
  const ret = await fn(
    globals.agent, globals.parallel, globals.pipeline,
    globals.phase, globals.log, globals.args, globals.budget, globals.workflow,
  )
  return { ret, src, srcBytes: Buffer.byteLength(src, 'utf8'), phases, logs }
}

// Real Anthropic backend: returns {text, usage:{inTok,outTok}, ms, requestId, tier, model}.
// This is the unit gate.mjs wraps for cache / HITL / model-swap.
export function anthropicBackend(apiKey, { maxTokens = 64 } = {}) {
  if (!apiKey) throw new Error('MISSING_CREDENTIAL: ANTHROPIC_API_KEY')
  return async function call(prompt, opts = {}) {
    const tier = opts.model || 'sonnet'
    const model = MODELS[tier] || tier
    const t0 = process.hrtime.bigint()
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: opts.max_tokens || maxTokens, messages: [{ role: 'user', content: prompt }] }),
    })
    const requestId = res.headers.get('request-id') || res.headers.get('anthropic-request-id') || null
    const body = await res.json()
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    if (!res.ok) {
      const e = new Error('anthropic ' + res.status + ' ' + JSON.stringify(body))
      e.status = res.status
      throw e
    }
    const u = body.usage || {}
    const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim()
    return { text, usage: { inTok: u.input_tokens || 0, outTok: u.output_tokens || 0 }, ms: +ms.toFixed(1), requestId, tier, model }
  }
}
