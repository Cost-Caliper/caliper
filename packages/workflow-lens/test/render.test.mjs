// test/render.test.mjs — keyless render/mermaid self-contained tests.
// Guards the two real browser failures:
//   1) invalid Mermaid `#` in node/edge lines (entity-code trap)
//   2) CDN-blocked raw-source dump (the graph must be a self-contained inline SVG)
// Ported from capstone test-render-mermaid.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mermaidFrom, graphSvg, renderRun } from '../src/render.mjs'

const graph = {
  metaName: 'regression',
  phaseNodes: [
    { id: 'phase:0', title: 'Fan-out' },
    { id: 'phase:1', title: 'Refine' },
  ],
  agentNodes: [
    { id: 'agent:1', label: null, model: 'haiku', phase: 'Fan-out' },
    { id: 'agent:2', label: 'draft', model: 'haiku', phase: 'Refine' },
  ],
  edges: [
    { from: 'parallel#1', to: 'agent:1', kind: 'parallel' },
    { from: 'pipeline#2', to: 'agent:2', kind: 'pipeline' },
  ],
}

// ── mermaidFrom ───────────────────────────────────────────────────────────────

test('mermaidFrom: no bare # in node/edge lines (entity-code trap)', () => {
  const mm = mermaidFrom({ ...graph, edges: [{ from: 'root', to: 'parallel#1', kind: 'root' }, ...graph.edges] })
  const nodeLines = mm.split('\n').filter(l => l.trim() && !l.includes('classDef'))
  const bad = nodeLines.filter(l => l.includes('#'))
  assert.equal(bad.length, 0, 'lines with bare #: ' + JSON.stringify(bad))
})

test('mermaidFrom: every {{container}} label is double-quoted', () => {
  const mm = mermaidFrom(graph)
  // Pattern {{...}} without a leading " is the bug; after fix all are {{"..."}}
  assert.ok(!/\{\{(?!")/.test(mm), 'found unquoted {{...}} in mermaid output')
})

// ── graphSvg ──────────────────────────────────────────────────────────────────

test('graphSvg: returns an inline <svg>', () => {
  const svg = graphSvg(graph)
  assert.ok(svg.startsWith('<svg'), 'should start with <svg')
  assert.ok(svg.includes('</svg>'), 'should end with </svg>')
})

test('graphSvg: NO CDN or script dependency', () => {
  const svg = graphSvg(graph)
  assert.ok(!/cdn|mermaid\.min|<script/i.test(svg), 'found CDN/script in SVG: ' + svg.slice(0, 200))
})

test('graphSvg: embeds real node labels (start, phases, agent id)', () => {
  const svg = graphSvg(graph)
  assert.ok(svg.includes('start'), 'missing "start" in SVG')
  assert.ok(svg.includes('phase: Fan-out'), 'missing "phase: Fan-out" in SVG')
  assert.ok(svg.includes('agent:1 · haiku'), 'missing agent:1 label in SVG')
})

test('graphSvg: labels the container edges', () => {
  const svg = graphSvg(graph)
  // Container label format: cleanCont(e.from) + ' · ' + e.kind
  // parallel#1 -> 'parallel 1 · parallel', pipeline#2 -> 'pipeline 2 · pipeline'
  assert.ok(svg.includes('parallel 1 · parallel'), 'missing parallel container edge label: ' + svg.slice(0, 300))
  assert.ok(svg.includes('pipeline 2 · pipeline'), 'missing pipeline container edge label: ' + svg.slice(0, 300))
})

// ── renderRun ─────────────────────────────────────────────────────────────────

test('renderRun: NO external script src / CDN reference', () => {
  const html = renderRun({ meta: { name: 'regression' }, graph, telemetry: { run: {}, perPhase: [], calls: [] } })
  assert.ok(!/cdn\.|<script\s+src=/i.test(html), 'found CDN/external script in run.html')
})

test('renderRun: embeds the inline SVG graph', () => {
  const html = renderRun({ meta: { name: 'regression' }, graph, telemetry: { run: {}, perPhase: [], calls: [] } })
  assert.ok(html.includes('class="graph"'), 'missing graph section')
  assert.ok(html.includes('<svg'), 'missing <svg in run.html')
})

test('renderRun: has the timing caveat note (honest scope)', () => {
  // The report header must state that ms/speedup come from the external shim ledger,
  // NOT the in-harness tracer (the README promises "the report header says so").
  // It must also embed the data JSON.
  const html = renderRun({ meta: { name: 'regression' }, graph, telemetry: { run: {}, perPhase: [], calls: [] } })
  assert.ok(html.includes('application/json'), 'embedded run data JSON tag missing')
  assert.ok(/shim ledger/i.test(html), 'missing the shim-ledger timing-source caveat in the report header')
  assert.ok(/not.{0,40}in-harness tracer/is.test(html), 'caveat must contrast shim ledger vs in-harness tracer')
})
