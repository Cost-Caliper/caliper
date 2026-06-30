// render.mjs — turn a captured run into ONE self-contained .html file.
//
// renderRun({ meta, graph, telemetry }) -> an HTML string that opens with NO
// server (file://). It contains, all inline:
//   - the run + per-phase rollups as a table,
//   - a Mermaid graph of the workflow structure (phases -> parallel/pipeline
//     containers -> agent nodes), rendered from the AST graph,
//   - a timeline of concurrent agent bars (positioned by startMs/endMs) with
//     per-call cost / latency / tokens, so overlap is visually obvious and the
//     "wall-clock != sum" gap is legible,
//   - the raw run JSON embedded in a <script type="application/json"> block.
//
// Mermaid is loaded from a CDN <script>; if offline the graph degrades to a
// labeled placeholder but the table + timeline (pure SVG/CSS) still work.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtUsd = (n) => '$' + Number(n || 0).toFixed(6)
const fmtMs = (n) => Number(n || 0).toFixed(0) + 'ms'

const TIER_COLOR = { haiku: '#3b8e6e', sonnet: '#9c6b2e', opus: '#a33', fable: '#6a4ca3' }

// Build Mermaid `flowchart` text from the AST graph. Containers (parallel/pipeline/
// workflow) become subgraph-ish hubs; phases become top nodes; agents hang off
// their container (or root).
export function mermaidFrom(graph) {
  const lines = ['flowchart TD']
  lines.push('  root([start])')
  for (const p of graph.phaseNodes || []) lines.push(`  ${idSafe(p.id)}["phase: ${mmEsc(p.title)}"]:::phase`)
  const containers = new Set()
  for (const e of graph.edges || []) if (e.from !== 'root' && e.from !== 'sequential') containers.add(e.from)
  for (const c of containers) lines.push(`  ${idSafe(c)}{{"${mmEsc(c)}"}}:::container`)
  for (const a of graph.agentNodes || []) {
    const tag = a.label ? `${a.label}` : a.id
    const sub = `${a.model}${a.hasSchema ? ' · schema' : ''}`
    lines.push(`  ${idSafe(a.id)}["${mmEsc(tag)} · ${mmEsc(sub)}"]:::agent`)
  }
  // phase chain (sequential order)
  const ph = graph.phaseNodes || []
  for (let i = 0; i < ph.length; i++) {
    const from = i === 0 ? 'root' : idSafe(ph[i - 1].id)
    lines.push(`  ${from} --> ${idSafe(ph[i].id)}`)
  }
  // container -> agent + container fed from its phase (best-effort by agent.phase)
  for (const e of graph.edges || []) {
    if (e.from === 'root') lines.push(`  root --> ${idSafe(e.to)}`)
    else lines.push(`  ${idSafe(e.from)} -->|${e.kind}| ${idSafe(e.to)}`)
  }
  lines.push('  classDef phase fill:#f3ead9,stroke:#9c6b2e,color:#5b4326;')
  lines.push('  classDef container fill:#e7eef4,stroke:#3a6ea5,color:#22435e;')
  lines.push('  classDef agent fill:#fff,stroke:#888,color:#222;')
  return lines.join('\n')
}
const idSafe = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_')
// Mermaid label sanitizer: strip every char that breaks the flowchart parser —
// `#` (Mermaid reads it as an entity-code start, e.g. `parallel#1` -> error), quotes,
// angle brackets, and the node-shape delimiters. Collapse whitespace. ALWAYS wrap the
// result in "..." at the call site so colons/dots/slashes survive as plain text.
const mmEsc = (s) => String(s == null ? '' : s).replace(/[#"'<>\[\]{}|]/g, ' ').replace(/\s+/g, ' ').trim()

// graphSvg(graph) -> a SELF-CONTAINED inline SVG of the workflow graph: NO Mermaid, NO
// CDN, NO client-side JS. Left spine = start -> phases; each phase fans right to its
// agents, the connector labeled with its container (parallel/pipeline) + kind. This is
// the "self-contained, opens in any browser with no server / offline" guarantee — the
// CDN+client-render approach failed when the CDN was blocked and dumped raw source.
export function graphSvg(graph) {
  const phases = graph.phaseNodes || []
  const agents = graph.agentNodes || []
  const edges = graph.edges || []
  const edgeToAgent = new Map()
  for (const e of edges) { if (e.from !== 'root' && e.from !== 'sequential') edgeToAgent.set(e.to, e) }
  const cleanCont = (c) => String(c).replace(/#/g, ' ').replace(/\s+/g, ' ').trim()
  const aLabel = (a) => (a.label || a.id) + ' · ' + (a.model || '?') + (a.hasSchema ? ' · schema' : '')
  const titles = phases.map((p) => p.title)
  const lanesSrc = phases.map((p) => ({ title: p.title, agents: agents.filter((a) => a.phase === p.title) }))
  const orphans = agents.filter((a) => !titles.includes(a.phase))
  if (orphans.length) lanesSrc.push({ title: null, agents: orphans })

  const PX = 16, PW = 150, AX = 380, AW = 230, BOXH = 38, VGAP = 14, LANEGAP = 30, startY = 14
  let y = startY + BOXH + 34
  const lanes = []
  for (const l of lanesSrc) {
    const n = Math.max(1, l.agents.length)
    const h = n * BOXH + (n - 1) * VGAP
    lanes.push({ ...l, y, h, cy: y + h / 2 })
    y += h + LANEGAP
  }
  const totalH = Math.max(y, startY + BOXH + 40), W = AX + AW + 16
  const box = (x, yy, w, h, label, fill, stroke, fs) =>
    `<rect x="${x}" y="${yy}" width="${w}" height="${h}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>` +
    `<text x="${x + w / 2}" y="${yy + h / 2 + 4}" text-anchor="middle" font-size="${fs || 12.5}" fill="#333">${esc(label)}</text>`
  const arrow = (x1, y1, x2, y2) => {
    const vert = Math.abs(x2 - x1) < Math.abs(y2 - y1)
    const c = vert ? `${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2}` : `${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2}`
    return `<path d="M${x1},${y1} C${c} ${x2},${y2}" fill="none" stroke="#9a9a9a" stroke-width="1.3" marker-end="url(#ah)"/>`
  }
  const parts = [`<defs><marker id="ah" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#9a9a9a"/></marker></defs>`]
  parts.push(box(PX, startY, PW, BOXH, 'start', '#ede7f6', '#7e57c2'))
  let prevCx = PX + PW / 2, prevBottom = startY + BOXH
  for (const lane of lanes) {
    const py = lane.cy - BOXH / 2
    parts.push(arrow(prevCx, prevBottom, PX + PW / 2, py))
    parts.push(box(PX, py, PW, BOXH, lane.title ? 'phase: ' + lane.title : 'agents', '#f3ead9', '#9c6b2e'))
    prevCx = PX + PW / 2; prevBottom = py + BOXH
    let ay = lane.y
    for (const a of lane.agents) {
      const e = edgeToAgent.get(a.id)
      parts.push(arrow(PX + PW, lane.cy, AX, ay + BOXH / 2))
      if (e) parts.push(`<text x="${(PX + PW + AX) / 2}" y="${ay + BOXH / 2 - 5}" text-anchor="middle" font-size="9.5" fill="#3a6ea5">${esc(cleanCont(e.from) + ' · ' + e.kind)}</text>`)
      parts.push(box(AX, ay, AW, BOXH, aLabel(a), '#fff', '#888'))
      ay += BOXH + VGAP
    }
  }
  return `<svg viewBox="0 0 ${W} ${totalH}" width="100%" style="max-width:${W}px;height:auto" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,-apple-system">${parts.join('')}</svg>`
}

// SVG timeline: one row per call, x mapped from [minStart,maxEnd] -> [0,W].
function timelineSvg(calls) {
  if (!calls.length) return '<p class="muted">no calls</p>'
  const minStart = Math.min(...calls.map((c) => c.startMs))
  const maxEnd = Math.max(...calls.map((c) => c.endMs))
  const span = Math.max(1, maxEnd - minStart)
  const W = 920, padL = 160, padR = 20, rowH = 26, top = 28
  const innerW = W - padL - padR
  const H = top + calls.length * rowH + 16
  const x = (ms) => padL + ((ms - minStart) / span) * innerW
  const parts = [`<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;font:12px ui-sans-serif,system-ui">`]
  // axis ticks (5)
  for (let i = 0; i <= 5; i++) {
    const ms = minStart + (span * i) / 5
    const px = x(ms)
    parts.push(`<line x1="${px}" y1="${top - 6}" x2="${px}" y2="${H - 8}" stroke="#eee"/>`)
    parts.push(`<text x="${px}" y="${top - 10}" fill="#999" font-size="10" text-anchor="middle">${(ms - minStart).toFixed(0)}ms</text>`)
  }
  calls.forEach((c, i) => {
    const y = top + i * rowH
    const bx = x(c.startMs), bw = Math.max(2, x(c.endMs) - x(c.startMs))
    const fill = TIER_COLOR[c.tier] || '#777'
    const label = `${c.label || c.id} · ${c.tier}`
    const tip = `${label} | ${fmtMs(c.ms)} | ${c.inTok}in/${c.outTok}out | ${fmtUsd(c.costUsd)}${c.requestId ? ' | ' + c.requestId : ''}${c.error ? ' | ERROR' : ''}`
    parts.push(`<text x="${padL - 8}" y="${y + 14}" text-anchor="end" fill="#444">${esc(label)}</text>`)
    parts.push(`<rect x="${bx}" y="${y + 4}" width="${bw}" height="${rowH - 10}" rx="3" fill="${c.error ? '#c0392b' : fill}" opacity="0.85"><title>${esc(tip)}</title></rect>`)
    parts.push(`<text x="${bx + bw + 6}" y="${y + 14}" fill="#666" font-size="10">${fmtMs(c.ms)} · ${fmtUsd(c.costUsd)}</text>`)
  })
  parts.push('</svg>')
  return parts.join('')
}

function phaseRows(perPhase) {
  return (perPhase || []).map((p) =>
    `<tr><td>${esc(p.phase)}</td><td>${p.calls}</td><td>${p.inTok}</td><td>${p.outTok}</td><td>${fmtUsd(p.costUsd)}</td><td>${fmtMs(p.sumMs)}</td><td>${fmtMs(p.wallMs)}</td></tr>`,
  ).join('')
}
function callRows(calls) {
  return (calls || []).map((c) =>
    `<tr><td>${c.id}</td><td>${esc(c.label || '')}</td><td>${esc(c.tier)}</td><td>${esc(c.phase || '')}</td><td>${fmtMs(c.ms)}</td><td>${c.inTok}</td><td>${c.outTok}</td><td>${fmtUsd(c.costUsd)}</td><td class="mono">${esc(c.requestId || '')}</td></tr>`,
  ).join('')
}

export function renderRun({ meta = {}, graph = {}, telemetry = {} } = {}) {
  const run = telemetry.run || {}
  const perPhase = telemetry.perPhase || []
  const calls = telemetry.calls || []
  const mermaid = mermaidFrom(graph)
  const dataJson = JSON.stringify({ meta, graph, telemetry }, null, 2)
  const title = meta.name || graph.metaName || 'workflow run'

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — run report</title>
<style>
  :root{color-scheme:light}
  body{margin:0;font:14px ui-sans-serif,system-ui,-apple-system;color:#222;background:#faf8f4}
  header{padding:18px 24px;background:#f3ead9;border-bottom:1px solid #e3d6bd}
  h1{margin:0 0 4px;font-size:18px;color:#5b4326}
  .sub{color:#7a6a4d;font-size:13px}
  main{padding:18px 24px;max-width:980px;margin:0 auto}
  section{margin:0 0 26px}
  h2{font-size:15px;border-bottom:1px solid #eadfc9;padding-bottom:4px;color:#5b4326}
  .cards{display:flex;gap:12px;flex-wrap:wrap}
  .card{background:#fff;border:1px solid #e7ddc7;border-radius:8px;padding:10px 14px;min-width:120px}
  .card .n{font-size:20px;font-weight:600}
  .card .l{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.04em}
  .savings{background:#eef6ef;border-color:#c8e2cc}
  table{border-collapse:collapse;width:100%;font-size:12.5px;background:#fff}
  th,td{border:1px solid #eee;padding:5px 8px;text-align:left}
  th{background:#f7f1e6;color:#5b4326}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#666}
  .muted{color:#999}
  .graph{background:#fff;border:1px solid #e7ddc7;border-radius:8px;padding:12px;overflow:auto}
  .mmsrc{background:#faf6ee;border:1px solid #eadfc9;border-radius:6px;padding:8px;font-size:11px;white-space:pre-wrap;color:#7a6a4d;overflow:auto}
  details summary{cursor:pointer;font-size:12px;color:#999;margin-top:6px}
  .legend span{display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:12px}
  .swatch{width:12px;height:12px;border-radius:3px;display:inline-block}
</style></head><body>
<header>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(meta.description || '')}</div>
  <div class="sub" style="margin-top:6px;font-size:12px;color:#8a7a5c">Every ms / speedup below is measured by the external <strong>shim ledger</strong> (a real monotonic clock), <strong>not</strong> the in-harness tracer (the harness bans <code>Date.now()</code> for resume-safety). Cost is metered from provider price tables, not a live billing API.</div>
</header>
<main>
  <section>
    <div class="cards">
      <div class="card"><div class="n">${run.calls || 0}</div><div class="l">agent calls</div></div>
      <div class="card"><div class="n">${fmtUsd(run.costUsd)}</div><div class="l">total cost</div></div>
      <div class="card"><div class="n">${run.inTok || 0}/${run.outTok || 0}</div><div class="l">tok in/out</div></div>
      <div class="card"><div class="n">${fmtMs(run.wallMs)}</div><div class="l">wall-clock</div></div>
      <div class="card"><div class="n">${fmtMs(run.sumMs)}</div><div class="l">naive sum</div></div>
      <div class="card savings"><div class="n">${run.speedup || 1}×</div><div class="l">concurrency speedup<br/>(${fmtMs(run.concurrencySavingMs)} saved)</div></div>
    </div>
  </section>

  <section>
    <h2>Workflow graph</h2>
    <div class="graph">${graphSvg(graph)}</div>
    <details><summary class="muted">Mermaid source (reference)</summary><pre class="mmsrc">${esc(mermaid)}</pre></details>
  </section>

  <section>
    <h2>Timeline (concurrent agent bars)</h2>
    <div class="legend">
      <span><span class="swatch" style="background:#3b8e6e"></span>haiku</span>
      <span><span class="swatch" style="background:#9c6b2e"></span>sonnet</span>
      <span><span class="swatch" style="background:#a33"></span>opus</span>
      <span><span class="swatch" style="background:#c0392b"></span>error</span>
    </div>
    ${timelineSvg(calls)}
  </section>

  <section>
    <h2>Per-phase rollup</h2>
    <table><thead><tr><th>phase</th><th>calls</th><th>in</th><th>out</th><th>cost</th><th>sum ms</th><th>wall ms</th></tr></thead>
    <tbody>${phaseRows(perPhase) || '<tr><td colspan="7" class="muted">none</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>Per-call</h2>
    <table><thead><tr><th>#</th><th>label</th><th>tier</th><th>phase</th><th>ms</th><th>in</th><th>out</th><th>cost</th><th>request id</th></tr></thead>
    <tbody>${callRows(calls) || '<tr><td colspan="9" class="muted">none</td></tr>'}</tbody></table>
  </section>
</main>
<script type="application/json" id="run-data">${dataJson.replace(/</g, '\\u003c')}</script>
</body></html>`
}
