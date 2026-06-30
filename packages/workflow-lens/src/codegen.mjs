// codegen.mjs — graph -> a valid Claude Code workflow JS string, via TEMPLATING.
//
// This is the inverse of ast.buildGraph: a structural graph in, a runnable
// workflow .js source out. The A2 "visual editor" emits a graph the user has
// drawn; the A8 "optimizer" emits a graph it has rewritten (e.g. re-tiered a
// node haiku->opus, or moved three sequential agents into one parallel barrier).
// Both reuse THIS module so they never hand-concatenate JS.
//
// ROUND-TRIP CONTRACT
//   parse(emit(graph)) yields the SAME structural graph (same metaName, same
//   phase titles in order, same agent count + each agent's label/model/phase/
//   hasSchema, same edge kinds wiring agents to their parallel/pipeline/workflow
//   container or to root). test-codegen.mjs proves it by round-tripping fixtures
//   AND ast.buildGraph(emit(parse-derived graph)) === the original graph.
//
// HONEST SCOPE
//   This handles the STRUCTURED SUBSET the editor/optimizer manipulate:
//     - a pure-literal `meta` (name, description, phases[].title),
//     - phase() calls,
//     - agent() calls with literal prompt + literal opts (label/model/phase/
//       agentType/schema-presence),
//     - parallel() of N agents (a barrier),
//     - pipeline() over a literal item list with N agent stages.
//   workflow(name,args) is the documented one-level SUB-INVOCATION — it takes a
//   name + args, NOT a thunk of agents, so it is NOT an agent container and is
//   out of scope here (a 'workflow'-kind edge degrades to a sequential agent).
//   It does NOT round-trip arbitrary author-written JS (loops, helper vars,
//   dynamic prompts, .map() thunks). Those survive ast.buildGraph's STATIC view
//   but are out of scope for re-emission — the editor/optimizer work on the
//   normalized graph, not raw source. The emitted file is plain, canonical, and
//   always passes ast.lint (pure-literal meta, no banned globals, no imports).
//
// The emitted source uses ONLY the injected globals and is resume-safe by
// construction: no Date/clock/random, no import, meta is a pure literal.

// ── graph shape (input) ──────────────────────────────────────────────────────
//   {
//     metaName: string,
//     description?: string,
//     phaseNodes: [{ id?, title }],            // ordered; emitted as phase() calls
//     agentNodes: [{ id, label?, model?, phase?, agentType?, hasSchema?, prompt? }],
//     edges: [{ from, to, kind }],             // from='root'|containerId, to=agentId,
//                                              // kind='sequential'|'parallel'|'pipeline'|'workflow'
//   }
// Containers are recovered from edges: every edge whose `from` is not 'root'
// names a container (id like 'parallel#1'); its kind is the edge kind. Agents
// sharing a container id are grouped under one parallel()/pipeline()/workflow().

const VALID_MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable'])

// Identifier-or-quoted key for an object literal property.
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
function key(k) {
  return IDENT_RE.test(k) ? k : JSON.stringify(k)
}
// A JS string literal (single-quoted to match the toolkit's house style),
// JSON.stringify then swap the outer quotes safely.
function str(s) {
  // JSON.stringify gives a valid double-quoted JS string literal; that is itself
  // valid JS, so just use it (avoids manual escaping bugs). House style is
  // single quotes but double quotes are equally valid and round-trip identically.
  return JSON.stringify(String(s))
}

function indent(lines, pad = '  ') {
  return lines.map((l) => (l ? pad + l : l)).join('\n')
}

// Build the canonical default prompt for an agent that has none specified, so
// the emitted file is runnable. The editor/optimizer normally supply prompts.
function promptFor(agent) {
  if (typeof agent.prompt === 'string' && agent.prompt.length) return agent.prompt
  const who = agent.label || agent.id || 'agent'
  return `TODO(${who}): describe this step.`
}

// opts object literal for an agent() call, in a STABLE key order so the emitted
// text is deterministic (label, model, phase, agentType, schema).
function agentOptsLiteral(agent) {
  const parts = []
  if (agent.label != null) parts.push(`${key('label')}: ${str(agent.label)}`)
  // model: only emit if non-default. ast.buildGraph defaults a missing model to
  // 'sonnet', so to round-trip we EMIT model whenever it is set on the node;
  // if it's 'sonnet' we may omit it (buildGraph re-derives 'sonnet'). To be
  // safe + explicit we emit it whenever provided.
  if (agent.model != null) {
    if (!VALID_MODELS.has(agent.model)) {
      // tolerate custom tiers (gate.mjs supports non-Anthropic tier names)
    }
    parts.push(`${key('model')}: ${str(agent.model)}`)
  }
  if (agent.phase != null) parts.push(`${key('phase')}: ${str(agent.phase)}`)
  if (agent.agentType != null) parts.push(`${key('agentType')}: ${str(agent.agentType)}`)
  if (agent.hasSchema) {
    // A real schema object is opaque to the graph; emit a minimal non-null
    // schema literal so ast.readOpts records hasSchema:true and the emitted
    // workflow still parses + lints. The editor can replace it with a real one.
    parts.push(`${key('schema')}: { type: 'object' }`)
  }
  if (!parts.length) return ''
  return `{ ${parts.join(', ')} }`
}

// agent(...) call expression source.
function agentCall(agent) {
  const opts = agentOptsLiteral(agent)
  return opts ? `agent(${str(promptFor(agent))}, ${opts})` : `agent(${str(promptFor(agent))})`
}

// ── grouping: recover containers from edges ──────────────────────────────────
// Returns an ORDERED list of "units" to emit:
//   { kind:'sequential', agents:[a] }                 (one root agent)
//   { kind:'parallel',   id, agents:[a,a,...] }
//   { kind:'pipeline',   id, agents:[a,a,...] }
//   { kind:'workflow',   id, agents:[a,a,...] }
// Order follows agentNodes order; a container is placed at the position of its
// first member agent.
function planUnits(graph) {
  const byId = new Map(graph.agentNodes.map((a) => [a.id, a]))
  const edgeFor = new Map() // agentId -> {from, kind}
  for (const e of graph.edges || []) {
    if (e.to != null) edgeFor.set(e.to, { from: e.from, kind: e.kind })
  }

  const units = []
  const containerUnit = new Map() // containerId -> unit (so members append)
  for (const agent of graph.agentNodes) {
    const e = edgeFor.get(agent.id) || { from: 'root', kind: 'sequential' }
    if (e.from === 'root' || e.kind === 'sequential') {
      units.push({ kind: 'sequential', agents: [agent] })
    } else {
      // 'workflow' is a sub-invocation, NOT an agent container (see header).
      // Degrade such an edge to a sequential agent so the agent node survives
      // the round-trip honestly rather than vanishing into a workflow() call.
      if (e.kind === 'workflow') {
        units.push({ kind: 'sequential', agents: [agent] })
        continue
      }
      let unit = containerUnit.get(e.from)
      if (!unit) {
        unit = { kind: e.kind, id: e.from, agents: [] }
        containerUnit.set(e.from, unit)
        units.push(unit) // placed at first-member position
      }
      unit.agents.push(agent)
    }
  }
  return units
}

// ── emit one unit ─────────────────────────────────────────────────────────────
function emitUnit(unit, varSeq) {
  const v = `r${varSeq}`
  if (unit.kind === 'sequential') {
    const a = unit.agents[0]
    return { code: `const ${v} = await ${agentCall(a)}`, varName: v }
  }
  if (unit.kind === 'parallel') {
    const thunks = unit.agents.map((a) => `() => ${agentCall(a)}`)
    const body = thunks.length
      ? `await parallel([\n${indent(thunks.map((t, i) => t + (i < thunks.length - 1 ? ',' : '')))}\n])`
      : `await parallel([])`
    return { code: `const ${v} = ${body}`, varName: v }
  }
  if (unit.kind === 'pipeline') {
    // pipeline(items, ...stages): one stage per agent; stage cb gets (prev).
    const items = unit.agents.map((_, i) => str(`item-${i + 1}`))
    const stages = unit.agents.map((a) => `(prev) => ${agentCall(a)}`)
    const itemsLit = `[${items.join(', ')}]`
    const body =
      `await pipeline(\n` +
      indent([itemsLit + ',', ...stages.map((s, i) => s + (i < stages.length - 1 ? ',' : ''))]) +
      `\n)`
    return { code: `const ${v} = ${body}`, varName: v }
  }
  // 'workflow' is degraded to sequential in planUnits (see header); any unknown
  // kind -> emit as a sequential agent (defensive)
  const a = unit.agents[0]
  return { code: `const ${v} = await ${agentCall(a)}`, varName: v }
}

// ── meta literal ──────────────────────────────────────────────────────────────
function emitMeta(graph) {
  const lines = [`name: ${str(graph.metaName || 'generated-workflow')},`]
  if (graph.description != null) lines.push(`description: ${str(graph.description)},`)
  const phases = (graph.phaseNodes || []).map((p) => `{ title: ${str(p.title)} }`)
  if (phases.length) {
    lines.push(`phases: [`)
    lines.push(...indent(phases.map((p, i) => p + (i < phases.length - 1 ? ',' : ''))).split('\n'))
    lines.push(`],`)
  }
  return `export const meta = {\n${indent(lines)}\n}`
}

// ── top-level emit ────────────────────────────────────────────────────────────
// emit(graph) => workflow source string. Round-trips through ast.buildGraph.
export function emit(graph) {
  if (!graph || typeof graph !== 'object') throw new Error('emit: graph must be an object')
  if (!Array.isArray(graph.agentNodes)) graph = { ...graph, agentNodes: [] }
  if (!Array.isArray(graph.phaseNodes)) graph = { ...graph, phaseNodes: [] }
  if (!Array.isArray(graph.edges)) graph = { ...graph, edges: [] }

  const out = []
  out.push(emitMeta(graph))
  out.push('')

  // Emit phase() calls + the agent/parallel/pipeline units, interleaving phases
  // in declaration order. We group units by their agents' `phase` so that a
  // phase()'s agents are emitted right after its phase() call. Agents with no
  // phase are emitted first, under no phase() header.
  const units = planUnits(graph)

  // Determine the phase order: meta phases first (in order), then any phase that
  // appears on an agent but not in meta (appended).
  const phaseOrder = []
  const seen = new Set()
  for (const p of graph.phaseNodes) {
    if (p.title != null && !seen.has(p.title)) { phaseOrder.push(p.title); seen.add(p.title) }
  }
  for (const a of graph.agentNodes) {
    if (a.phase != null && !seen.has(a.phase)) { phaseOrder.push(a.phase); seen.add(a.phase) }
  }

  // unit -> representative phase = its first agent's phase (containers are
  // single-phase by construction in the editor model).
  const unitPhase = (u) => (u.agents[0] && u.agents[0].phase != null ? u.agents[0].phase : null)

  let varSeq = 0
  const emitUnits = (us) => {
    for (const u of us) {
      const { code } = emitUnit(u, ++varSeq)
      out.push(code)
    }
  }

  // 1) no-phase units first
  emitUnits(units.filter((u) => unitPhase(u) == null))

  // 2) each phase: phase() header then its units
  for (const title of phaseOrder) {
    out.push('')
    out.push(`phase(${str(title)})`)
    emitUnits(units.filter((u) => unitPhase(u) === title))
  }

  // A workflow body should produce a value; return a small structured result so
  // the file is a complete, runnable workflow.
  out.push('')
  out.push(`return { ok: true, agents: ${graph.agentNodes.length} }`)
  out.push('')

  return out.join('\n')
}

export default { emit }
