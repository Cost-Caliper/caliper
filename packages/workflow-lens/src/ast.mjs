// ast.mjs — static analysis of a Claude-authored workflow file WITHOUT executing it.
//
// Two products:
//   1) buildGraph(src) -> {metaName, phaseNodes[], agentNodes[], edges[]}
//      a node/edge graph of phase()/agent() calls and the parallel|pipeline|workflow
//      structures that wire them, recovered purely from the syntax tree.
//   2) lint(src) -> {ok, findings[]} flagging the three resume-safety violations:
//        (a) `meta` not a pure object literal,
//        (b) the three BANNED non-deterministic globals in the body
//            (Date.now(), Math.random(), new Date() with no args),
//        (c) any import / require.
//
// Parsing: strip the leading `export ` off meta (the harness wraps the body in an
// async function, so top-level return/await must be tolerated), then acorn-parse
// as a module with return/await allowed outside a function.
import { parse } from 'acorn'

const PARSE_OPTS = { ecmaVersion: 2022, sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }

export function stripExportMeta(src) {
  return src.replace(/^export\s+const\s+meta\s*=\s*/m, 'const meta = ')
}

export function parseWorkflow(src) {
  return parse(stripExportMeta(src), PARSE_OPTS)
}

// Parse the ORIGINAL source WITHOUT stripping export (offsets stay in original-source coordinates).
// Used by the Control Tower editor to splice prompt/model literals in place.
export function parseSource(src) { return parse(src, PARSE_OPTS) }

// ── tiny recursive walker (no deps) ─────────────────────────────────────────
function walk(node, visit, parent = null, key = null) {
  if (!node || typeof node.type !== 'string') return
  visit(node, parent, key)
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
    const v = node[k]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, node, k))
    else if (v && typeof v.type === 'string') walk(v, visit, node, k)
  }
}

const calleeName = (n) =>
  n && n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier' ? n.callee.name : null

// Pull a string literal arg (phase title / first agent arg is a prompt string).
const litString = (n) => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : null)

// Read label/model out of an agent() opts object literal (2nd arg).
function readOpts(optsNode) {
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

// Build the node/edge graph. agentNodes get their nearest enclosing parallel /
// pipeline / workflow container recorded as an inbound edge so the graph shows
// concurrency structure, not just a flat call list.
export function buildGraph(src) {
  const ast = parseWorkflow(src)
  const metaName = readMetaName(ast)
  const phaseNodes = []
  const agentNodes = []
  const edges = []
  let agentSeq = 0
  let containerSeq = 0

  // Map every node to its ancestor chain so we can find the enclosing container.
  const parents = new Map()
  walk(ast, (node, parent) => { if (parent) parents.set(node, parent) })

  function enclosingContainer(node) {
    let cur = parents.get(node)
    while (cur) {
      if (cur.type === 'CallExpression') {
        const nm = calleeName(cur)
        if (nm === 'parallel' || nm === 'pipeline' || nm === 'workflow') return { node: cur, kind: nm }
      }
      cur = parents.get(cur)
    }
    return null
  }

  // Stable ids for containers so multiple agents under the same parallel share an edge source.
  const containerId = new Map()
  function idFor(containerNode, kind) {
    if (!containerId.has(containerNode)) containerId.set(containerNode, `${kind}#${++containerSeq}`)
    return containerId.get(containerNode)
  }

  walk(ast, (node) => {
    const nm = calleeName(node)
    if (nm === 'phase') {
      const title = litString(node.arguments[0])
      phaseNodes.push({ id: `phase:${phaseNodes.length}`, title: title ?? '(dynamic)' })
    } else if (nm === 'agent') {
      const opts = readOpts(node.arguments[1])
      const id = `agent:${++agentSeq}`
      agentNodes.push({ id, label: opts.label ?? null, model: opts.model ?? 'sonnet', phase: opts.phase ?? null, agentType: opts.agentType ?? null, hasSchema: !!opts.hasSchema })
      const c = enclosingContainer(node)
      if (c) edges.push({ from: idFor(c.node, c.kind), to: id, kind: c.kind })
      else edges.push({ from: 'root', to: id, kind: 'sequential' })
    }
  })

  return { metaName, phaseNodes, agentNodes, edges }
}

// ── meta-name extraction from the AST (rigorous; used by lint + graph) ───────
function findMetaDeclarator(ast) {
  let found = null
  walk(ast, (node) => {
    if (found) return
    if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'Identifier' && node.id.name === 'meta') found = node
  })
  return found
}
export function readMetaName(ast) {
  const d = findMetaDeclarator(ast)
  if (!d || !d.init || d.init.type !== 'ObjectExpression') return null
  for (const p of d.init.properties) {
    if (p.type === 'Property' && !p.computed) {
      const key = p.key.type === 'Identifier' ? p.key.name : litString(p.key)
      if (key === 'name') return litString(p.value)
    }
  }
  return null
}

// ── linter ───────────────────────────────────────────────────────────────────
// A "pure literal" meta = ObjectExpression whose values are recursively literals,
// arrays of literals, or nested pure-literal objects. A variable / call / template
// with an expression / spread makes it impure (resume-unsafe meta).
function isPureLiteralExpr(node) {
  if (!node) return false
  switch (node.type) {
    case 'Literal': return true
    case 'TemplateLiteral': return node.expressions.length === 0
    case 'UnaryExpression': return (node.operator === '-' || node.operator === '+') && isPureLiteralExpr(node.argument)
    case 'ArrayExpression': return node.elements.every((e) => e == null || (e.type !== 'SpreadElement' && isPureLiteralExpr(e)))
    case 'ObjectExpression':
      return node.properties.every((p) => p.type === 'Property' && !p.computed && !p.method && isPureLiteralExpr(p.value))
    default: return false
  }
}

export function lint(src) {
  const findings = []
  const stripped = stripExportMeta(src)   // node positions reference the stripped source
  let ast
  try {
    ast = parse(stripped, PARSE_OPTS)
  } catch (e) {
    return { ok: false, findings: [{ rule: 'parse', severity: 'error', message: 'parse failed: ' + e.message }] }
  }
  const lineOf = (pos) => (pos == null ? null : stripped.slice(0, pos).split('\n').length)

  // (a) meta must be a pure object literal.
  const metaDecl = findMetaDeclarator(ast)
  if (!metaDecl) {
    findings.push({ rule: 'meta-literal', severity: 'error', message: 'no `meta` declaration found' })
  } else if (!metaDecl.init || metaDecl.init.type !== 'ObjectExpression') {
    findings.push({ rule: 'meta-literal', severity: 'error', message: '`meta` is not an object literal' })
  } else if (!isPureLiteralExpr(metaDecl.init)) {
    // pinpoint the first impure property for a useful message
    const bad = metaDecl.init.properties.find((p) => p.type !== 'Property' || p.computed || !isPureLiteralExpr(p.value))
    const key = bad && bad.key ? (bad.key.name || bad.key.value) : '?'
    findings.push({ rule: 'meta-literal', severity: 'error', message: `meta must be a PURE literal; property "${key}" contains a non-literal expression`, line: lineOf(bad && bad.start) })
  }

  // (b) banned non-deterministic globals + (c) import/require.
  walk(ast, (node) => {
    // import declarations
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') {
      findings.push({ rule: 'no-import', severity: 'error', message: 'static/dynamic import is banned in a workflow body', line: lineOf(node.start) })
    }
    if (node.type === 'CallExpression') {
      // require(...)
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        findings.push({ rule: 'no-import', severity: 'error', message: 'require() is banned in a workflow body', line: lineOf(node.start) })
      }
      // Date.now()
      if (isMember(node.callee, 'Date', 'now')) {
        findings.push({ rule: 'no-nondeterminism', severity: 'error', message: 'Date.now() is banned (resume-unsafe ms clock)', line: lineOf(node.start) })
      }
      // Math.random()
      if (isMember(node.callee, 'Math', 'random')) {
        findings.push({ rule: 'no-nondeterminism', severity: 'error', message: 'Math.random() is banned (resume-unsafe RNG)', line: lineOf(node.start) })
      }
    }
    // new Date()  with ZERO args (argless Date construction). new Date(x) is fine.
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) {
      findings.push({ rule: 'no-nondeterminism', severity: 'error', message: 'argless new Date() is banned (resume-unsafe wall clock)', line: lineOf(node.start) })
    }
  })

  return { ok: findings.length === 0, findings }
}

function isMember(callee, obj, prop) {
  return (
    callee && callee.type === 'MemberExpression' && !callee.computed &&
    callee.object.type === 'Identifier' && callee.object.name === obj &&
    callee.property.type === 'Identifier' && callee.property.name === prop
  )
}
