// test/codegen.test.mjs — keyless codegen (emit) round-trip tests.
// Ported from capstone test-codegen.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { emit } from '../src/codegen.mjs'
import { buildGraph, lint } from '../src/ast.mjs'
import { compileWorkflow, makeParallel, makePipeline, makeBudget } from '../src/shim.mjs'

// Canonicalize a graph ignoring synthetic container-id numbering but preserving:
// metaName, phase titles in order, each agent's props + container kind.
function canon(g) {
  const edgeFor = new Map()
  for (const e of g.edges) edgeFor.set(e.to, e)
  const memberIndex = new Map()
  g.agentNodes.forEach((a, i) => {
    const e = edgeFor.get(a.id)
    if (e && e.from !== 'root') {
      if (!memberIndex.has(e.from)) memberIndex.set(e.from, [])
      memberIndex.get(e.from).push(i)
    }
  })
  const containerSig = new Map()
  for (const [cid, idxs] of memberIndex) {
    const e = g.edges.find(x => x.from === cid)
    containerSig.set(cid, `${e.kind}:[${idxs.join(',')}]`)
  }
  const agents = g.agentNodes.map((a) => {
    const e = edgeFor.get(a.id) || { from: 'root', kind: 'sequential' }
    const container = e.from === 'root' ? 'root:sequential' : containerSig.get(e.from)
    return { label: a.label ?? null, model: a.model ?? 'sonnet', phase: a.phase ?? null, agentType: a.agentType ?? null, hasSchema: !!a.hasSchema, container }
  })
  return JSON.stringify({ metaName: g.metaName, phases: g.phaseNodes.map(p => p.title), agents })
}

const graphA = {
  metaName: 'gen-single',
  description: 'one agent',
  phaseNodes: [{ title: 'Greet' }],
  agentNodes: [{ id: 'a1', label: 'greeter', model: 'haiku', phase: 'Greet' }],
  edges: [{ from: 'root', to: 'a1', kind: 'sequential' }],
}

const graphB = {
  metaName: 'gen-fanout',
  description: 'parallel of 3 then a 2-stage pipeline',
  phaseNodes: [{ title: 'Fan-out' }, { title: 'Refine' }],
  agentNodes: [
    { id: 'p1', label: 'fact-a', model: 'haiku', phase: 'Fan-out' },
    { id: 'p2', label: 'fact-b', model: 'haiku', phase: 'Fan-out' },
    { id: 'p3', label: 'fact-c', model: 'haiku', phase: 'Fan-out' },
    { id: 's1', label: 'draft', model: 'haiku', phase: 'Refine' },
    { id: 's2', label: 'polish', model: 'sonnet', phase: 'Refine', hasSchema: true },
  ],
  edges: [
    { from: 'parallel#1', to: 'p1', kind: 'parallel' },
    { from: 'parallel#1', to: 'p2', kind: 'parallel' },
    { from: 'parallel#1', to: 'p3', kind: 'parallel' },
    { from: 'pipeline#1', to: 's1', kind: 'pipeline' },
    { from: 'pipeline#1', to: 's2', kind: 'pipeline' },
  ],
}

const graphC = {
  metaName: 'gen-mixed',
  phaseNodes: [],
  agentNodes: [
    { id: 'x1', label: 'prep', model: 'sonnet' },
    { id: 'x2', label: 'finish', model: 'opus' },
  ],
  edges: [
    { from: 'root', to: 'x1', kind: 'sequential' },
    { from: 'root', to: 'x2', kind: 'sequential' },
  ],
}

test('emit(graphA): emitted source lints clean', () => {
  const src = emit(graphA)
  const result = lint(src)
  assert.equal(result.ok, true, 'findings: ' + JSON.stringify(result.findings))
})

test('emit(graphA): round-trips — canon(graph) === canon(buildGraph(emit(graph)))', () => {
  const src = emit(graphA)
  const reparsed = buildGraph(src)
  assert.equal(canon(graphA), canon(reparsed))
})

test('emit(graphB): emitted source lints clean', () => {
  const src = emit(graphB)
  const result = lint(src)
  assert.equal(result.ok, true, 'findings: ' + JSON.stringify(result.findings))
})

test('emit(graphB): round-trips', () => {
  const src = emit(graphB)
  const reparsed = buildGraph(src)
  assert.equal(canon(graphB), canon(reparsed))
})

test('emit(graphB): emitted workflow runs under stub and returns {ok:true,agents:5}', async () => {
  const src = emit(graphB)
  const stub = async (p, o = {}) => `[${o.model || 'sonnet'}] ok`
  const fn = compileWorkflow(src)
  const ret = await fn(stub, makeParallel(), makePipeline(), () => {}, () => {}, {}, makeBudget(null), async () => null)
  assert.ok(ret && ret.ok === true && ret.agents === 5, 'got: ' + JSON.stringify(ret))
})

test('emit(graphC): emitted source lints clean', () => {
  const src = emit(graphC)
  const result = lint(src)
  assert.equal(result.ok, true, 'findings: ' + JSON.stringify(result.findings))
})

test('emit(graphC): round-trips', () => {
  const src = emit(graphC)
  const reparsed = buildGraph(src)
  assert.equal(canon(graphC), canon(reparsed))
})

test('emit -> parse -> emit is a fixed point', () => {
  const once = emit(graphB)
  const g1 = buildGraph(once)
  const twice = emit({ metaName: g1.metaName, phaseNodes: g1.phaseNodes, agentNodes: g1.agentNodes, edges: g1.edges })
  const g2 = buildGraph(twice)
  assert.equal(canon(g1), canon(g2))
  assert.equal(lint(twice).ok, true)
})
