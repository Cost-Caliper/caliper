// inject.mjs — transparent auto-instrumentation of a Claude-authored workflow (A1).
//
// WHAT IT DOES
//   Given a workflow's SOURCE STRING, it wraps every agent() / parallel() /
//   pipeline() CALL SITE so that — when the file later runs UNDER THE REAL
//   HARNESS — each call emits a structured trace record through log() (the only
//   harness-safe output channel from inside a workflow body). The original call
//   still runs and still returns exactly what it returned before, so behavior is
//   unchanged; only observability is added.
//
// HOW IT DOES IT (offset-splicing, NOT a codegen library)
//   1. acorn-parse the source (meta stripped, return/await tolerated) into an AST
//      that carries byte offsets on every node.
//   2. Collect the CallExpression nodes whose callee is the bare identifier
//      `agent` / `parallel` / `pipeline` (the injected globals — a member call
//      like foo.agent() is intentionally ignored).
//   3. For each, rewrite it in place by splicing text at the call's [start,end):
//        agent(P, OPTS)  ->  __trace('agent', {…static meta…}, agent, [P, OPTS])
//      The real callee + the real argument array are passed BY REFERENCE, so the
//      arguments are evaluated EXACTLY ONCE (inside the array literal) — no
//      double-evaluation, no side-effect risk. __trace then performs the actual
//      call via realFn(...realArgs) and returns its value unchanged.
//      Matches are processed LAST-TO-FIRST so earlier splices never invalidate
//      the offsets of later (earlier-in-file) ones.
//   4. Prepend a small prelude that defines __trace using ONLY log() — no clock,
//      no Date, no random, no Node API — so the instrumented file is STILL a
//      valid resume-safe workflow that passes ast.lint().
//
// HONEST SCOPE — WALL CLOCK CANNOT BE CAPTURED HERE
//   Inside a real harness body the millisecond clock, argless Date construction
//   and the RNG all THROW (resume-safety). So __trace can record call STRUCTURE,
//   ORDER, COUNTS, the static call-site meta (label/model/phase), the runtime
//   arg shape (arg count, prompt preview, the # of thunks/items a barrier
//   wrapped), and success/failure/null — but it CANNOT time anything. Per-call
//   wall-clock and the concurrency-saving gap require the EXTERNAL shim wrapper
//   (ledger.mjs), which runs the same file under a real clock OUTSIDE the
//   harness. The trace and the shim ledger are complementary, not redundant:
//   trace = structure that survives a real harness run; ledger = timing that
//   needs the external runner.
import { parse } from 'acorn'

const PARSE_OPTS = {
  ecmaVersion: 2022,
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
}

const META_RE = /^export\s+const\s+meta\s*=\s*/m
const WRAP_CALLEES = new Set(['agent', 'parallel', 'pipeline'])

// Names chosen to be vanishingly unlikely to collide with authored identifiers.
const DEFAULT_TRACE_FN = '__trace'
const DEFAULT_EMIT = 'log' // the harness-safe sink; can be redirected for tests

// Marker the prelude carries so transform() is idempotent (re-instrumenting an
// already-instrumented file is a no-op rather than a duplicate-declaration error).
const PRELUDE_MARKER = 'auto-instrumentation prelude (injected by inject.mjs)'

// ── tiny recursive AST walker (no deps; mirrors ast.mjs) ─────────────────────
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
    const v = node[k]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit))
    else if (v && typeof v.type === 'string') walk(v, visit)
  }
}

const calleeName = (n) =>
  n && n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier' ? n.callee.name : null

const litString = (n) => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : null)

// Recover static label/model/phase from an agent() opts object literal (arg 1).
// Only literal values are recoverable statically; dynamic values are left out
// (the runtime arg-shape captured by __trace fills the gap where it can).
function readAgentOpts(optsNode) {
  const out = {}
  if (!optsNode || optsNode.type !== 'ObjectExpression') return out
  for (const p of optsNode.properties) {
    if (p.type !== 'Property' || p.computed) continue
    const key = p.key.type === 'Identifier' ? p.key.name : litString(p.key)
    if (key === 'label') out.label = litString(p.value)
    else if (key === 'model') out.model = litString(p.value)
    else if (key === 'phase') out.phase = litString(p.value)
    else if (key === 'agentType') out.agentType = litString(p.value)
    else if (key === 'schema') out.hasSchema = true
  }
  return out
}

// Static meta for a call site — built only from string/boolean literals so it
// can be JSON.stringify'd and spliced verbatim.
function staticMetaFor(kind, node) {
  const meta = { kind }
  if (kind === 'agent') {
    const opts = readAgentOpts(node.arguments[1])
    if (opts.label != null) meta.label = opts.label
    if (opts.model != null) meta.model = opts.model
    if (opts.phase != null) meta.phase = opts.phase
    if (opts.agentType != null) meta.agentType = opts.agentType
    if (opts.hasSchema) meta.hasSchema = true
  }
  return meta
}

// The injected prelude. CRITICAL CONSTRAINTS:
//   - uses ONLY the emit sink (log) — no Date / clock / random / Node API,
//     so the instrumented file still passes ast.lint() and is resume-safe;
//   - __trace runs the ORIGINAL call (realFn(...realArgs)) and returns its value
//     (or rethrows) unchanged, so workflow behavior is identical;
//   - args are evaluated once at the CALL SITE (inside the array literal); the
//     prelude only READS realArgs to derive shape, never re-invokes anything;
//   - it counts calls with a closure counter (deterministic; no clock) and emits
//     structured TRACE lines via the sink so a post-run reader can grep the
//     harness log stream for trace records.
function preludeSource(traceFn, emit) {
  return `
// ── auto-instrumentation prelude (injected by inject.mjs) ──────────────────
// Emits structured TRACE lines per agent/parallel/pipeline call via ${emit}()
// — the ONLY harness-safe channel. Records STRUCTURE (kind, order, static
// label/model/phase, arg shape, ok/err/null) — NOT wall-clock (the clock is
// banned under the real harness; timing comes from the external shim ledger).
let __traceSeq = 0
function ${traceFn}(__kind, __meta, __realFn, __args) {
  const __seq = ++__traceSeq
  const __a0 = __args && __args.length ? __args[0] : undefined
  const __shape =
    __kind === 'parallel'
      ? { thunks: Array.isArray(__a0) ? __a0.length : null }
      : __kind === 'pipeline'
        ? { items: Array.isArray(__a0) ? __a0.length : null, stages: Math.max(0, (__args ? __args.length : 0) - 1) }
        : { promptPreview: typeof __a0 === 'string' ? __a0.slice(0, 80) : null, argc: __args ? __args.length : 0 }
  const __base = { t: 'TRACE', seq: __seq, kind: __kind }
  for (const __k of Object.keys(__meta || {})) __base[__k] = __meta[__k]
  const __emit = (__ev, __extra) => {
    try { ${emit}('TRACE ' + JSON.stringify({ ...__base, ...__shape, ev: __ev, ...(__extra || {}) })) } catch (__e) {}
  }
  __emit('enter')
  let __r
  try { __r = __realFn(...(__args || [])) } catch (__e) { __emit('throw', { error: String((__e && __e.message) || __e) }); throw __e }
  if (__r && typeof __r.then === 'function') {
    return __r.then(
      (__v) => { __emit('resolve', { ok: true, nullResult: __v === null }); return __v },
      (__e) => { __emit('reject', { error: String((__e && __e.message) || __e) }); throw __e },
    )
  }
  __emit('return', { ok: true, nullResult: __r === null })
  return __r
}
// ── end auto-instrumentation prelude ───────────────────────────────────────
`
}

// End offset of the `export const meta = {...}` declaration, from the AST.
function metaEndOffset(ast) {
  let end = null
  walk(ast, (node) => {
    if (end != null) return
    if (
      node.type === 'VariableDeclaration' &&
      node.declarations.some((d) => d.id && d.id.type === 'Identifier' && d.id.name === 'meta')
    ) {
      end = node.end
    }
  })
  return end
}

// ── main transform ───────────────────────────────────────────────────────────
// transform(source, opts?) => { instrumentedSource, wrappedCallSites }
//   wrappedCallSites: [{ kind, label?, model?, phase?, start, end, line }]
export function transform(source, opts = {}) {
  const traceFn = opts.traceFn || DEFAULT_TRACE_FN
  const emit = opts.emit || DEFAULT_EMIT

  // Idempotence: never double-instrument (would duplicate the prelude's
  // declarations). Return the source unchanged with an empty wrap list.
  if (source.includes(PRELUDE_MARKER)) {
    return { instrumentedSource: source, wrappedCallSites: [], alreadyInstrumented: true }
  }

  // Parse the meta-stripped source so node offsets line up with what we splice.
  const stripped = source.replace(META_RE, 'const meta = ')
  let ast
  try {
    ast = parse(stripped, PARSE_OPTS)
  } catch (e) {
    const err = new Error('inject.transform: parse failed: ' + e.message)
    err.cause = e
    throw err
  }

  const lineOf = (pos) => stripped.slice(0, pos).split('\n').length

  // 1) Collect wrap targets (bare-identifier calls to the injected globals),
  //    in source order. Targets can NEST (an agent() inside a parallel()'s
  //    thunk), so we cannot naively splice — slicing a parent's args from the
  //    original string would discard a child's already-wrapped form. Instead we
  //    render recursively (below), bottom-up.
  const targets = []
  const targetSet = new Set()
  walk(ast, (node) => {
    const nm = calleeName(node)
    if (nm && WRAP_CALLEES.has(nm)) {
      targets.push({ node, kind: nm, meta: staticMetaFor(nm, node), start: node.start, end: node.end })
      targetSet.add(node)
    }
  })

  // renderRange(lo, hi): return the source text of [lo,hi) from `stripped` with
  // every wrap-target CallExpression that STARTS within it rewritten to its
  // __trace(...) form. Children are rendered via recursion, so a parent's arg
  // text already contains the wrapped children — args still evaluate exactly
  // once because we never duplicate an argument expression.
  const childrenSorted = targets.slice().sort((a, b) => a.start - b.start)
  function renderRange(lo, hi) {
    // wrap targets that start within [lo,hi) and are NOT nested inside another
    // target that also starts within [lo,hi)
    const here = childrenSorted.filter((t) => t.start >= lo && t.end <= hi)
    const topLevel = here.filter(
      (t) => !here.some((o) => o !== t && o.start <= t.start && o.end >= t.end && (o.start !== t.start || o.end !== t.end)),
    )
    topLevel.sort((a, b) => a.start - b.start)
    let cursor = lo
    let buf = ''
    for (const t of topLevel) {
      buf += stripped.slice(cursor, t.start)
      buf += renderCall(t)
      cursor = t.end
    }
    buf += stripped.slice(cursor, hi)
    return buf
  }
  function renderCall(t) {
    const argsSrc = t.node.arguments.map((a) => renderRange(a.start, a.end)).join(', ')
    const metaLit = JSON.stringify(t.meta)
    return `${traceFn}(${JSON.stringify(t.kind)}, ${metaLit}, ${t.kind}, [${argsSrc}])`
  }

  // 2) Inject the prelude right after the meta declaration, then render the rest
  //    of the body (everything after meta) with the recursive rewriter. meta is
  //    a pure literal — it contains no wrap targets — so we leave [0,metaEnd)
  //    untouched and rewrite [metaEnd, end).
  const mEnd = metaEndOffset(ast)
  if (mEnd == null) {
    throw new Error('inject.transform: no `meta` declaration found (not a valid workflow)')
  }
  const body = renderRange(mEnd, stripped.length)
  const out = stripped.slice(0, mEnd) + '\n' + preludeSource(traceFn, emit) + body

  // 4) Re-attach `export ` so the file STILL starts with `export const meta`.
  const instrumentedSource = out.replace(/^const\s+meta\s*=\s*/m, 'export const meta = ')

  const wrappedCallSites = targets
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((t) => ({
      kind: t.kind,
      ...(t.meta.label != null ? { label: t.meta.label } : {}),
      ...(t.meta.model != null ? { model: t.meta.model } : {}),
      ...(t.meta.phase != null ? { phase: t.meta.phase } : {}),
      start: t.start,
      end: t.end,
      line: lineOf(t.start),
    }))

  return { instrumentedSource, wrappedCallSites }
}
