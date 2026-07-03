#!/usr/bin/env node
// scripts/demo-data.mjs — generate a synthetic ~/.claude/projects tree so README
// screenshots and local demos never leak real prompts, paths, or spend.
// Usage: node scripts/demo-data.mjs [outRoot]   (default /tmp/caliper-demo/projects)
import { mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2] || '/tmp/caliper-demo/projects'
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

const MODELS = { fable: 'claude-fable-5', opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5' }
let seed = 42
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
const uuid = () => 'de300000-de30-4de3-8de3-' + String(Math.floor(rnd() * 1e12)).padStart(12, '0').replace(/[^0-9a-f]/g, '0')
const hex = () => Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0') + Math.floor(rnd() * 0xffffffff).toString(16).padStart(8, '0')

function usageLine(ts, model, req, { inTok, out, cw, cr }) {
  return JSON.stringify({ type: 'assistant', requestId: req, timestamp: ts, cwd: CUR.cwd, gitBranch: 'main', message: { role: 'assistant', model, usage: { input_tokens: inTok, output_tokens: out, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, cache_creation: { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 } }, content: [{ type: 'text', text: 'Done — see the diff above.' }] } })
}
const userLine = (ts, text) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })

// A Fable refusal row (stop_reason:refusal) — the safety classifier declined. The
// streamed partial is billed. `cat` is the stop_details category (cyber/bio/null).
const refusalLine = (ts, req, cat) => JSON.stringify({ type: 'assistant', requestId: req, timestamp: ts, cwd: CUR.cwd, gitBranch: 'main',
  message: { role: 'assistant', model: MODELS.fable, stop_reason: 'refusal', stop_details: { type: 'refusal', category: cat || null, explanation: null },
    usage: { input_tokens: 680, output_tokens: 240, cache_creation_input_tokens: 0, cache_read_input_tokens: 90000 },
    content: [{ type: 'thinking', thinking: '' }] } })
// A server-side fallback SWITCH — Fable declined, Claude Code re-served on Opus; the
// row carries a fallback content block + fallback_message usage iteration.
const switchLine = (ts, req) => JSON.stringify({ type: 'assistant', requestId: req, timestamp: ts, cwd: CUR.cwd, gitBranch: 'main',
  message: { role: 'assistant', model: MODELS.opus, stop_reason: 'end_turn',
    usage: { input_tokens: 2000, output_tokens: 260, cache_creation_input_tokens: 0, cache_read_input_tokens: 120000, iterations: [{ type: 'message', model: MODELS.fable }, { type: 'fallback_message', model: MODELS.opus }] },
    content: [{ type: 'fallback', from: { model: MODELS.fable }, to: { model: MODELS.opus } }, { type: 'text', text: 'Continuing on the fallback model.' }] } })

let CUR = null
function session(projDir, { title, tier, daysAgo, mins, turns, scale, subs = [], live = false, mainRefusals = 0, mainSwitches = 0, wfFallbacks = 0 }) {
  const id = uuid()
  const start = Date.now() - daysAgo * 86400000 - Math.floor(rnd() * 6) * 3600000
  const lines = [userLine(new Date(start).toISOString(), title)]
  for (let t = 0; t < turns; t++) {
    const ts = new Date(start + ((t + 1) / turns) * mins * 60000).toISOString()
    lines.push(usageLine(ts, MODELS[tier], 'req_' + t, {
      inTok: Math.floor((800 + rnd() * 3000) * scale), out: Math.floor((300 + rnd() * 1500) * scale),
      cw: Math.floor((4000 + rnd() * 30000) * scale), cr: Math.floor((30000 + rnd() * 250000) * scale),
    }))
  }
  // Main-chat Fable fallbacks (refusals + switches) interleaved near the end.
  for (let r = 0; r < mainRefusals; r++) lines.push(refusalLine(new Date(start + mins * 60000 + (r + 1) * 1000).toISOString(), 'req_mref_' + r, r % 2 ? 'cyber' : null))
  for (let w = 0; w < mainSwitches; w++) lines.push(switchLine(new Date(start + mins * 60000 + (w + 1) * 1500).toISOString(), 'req_msw_' + w))
  const p = join(projDir, id + '.jsonl')
  writeFileSync(p, lines.join('\n'))
  if (subs.length || wfFallbacks) {
    const sd = join(projDir, id)
    if (subs.length) {
      mkdirSync(join(sd, 'subagents'), { recursive: true })
      for (const desc of subs) {
        const aid = hex()
        writeFileSync(join(sd, 'subagents', `agent-${aid}.meta.json`), JSON.stringify({ agentType: 'Explore', description: desc, toolUseId: 'tu_' + aid.slice(0, 6) }))
        const s0 = start + 60000
        writeFileSync(join(sd, 'subagents', `agent-${aid}.jsonl`), [userLine(new Date(s0).toISOString(), desc), usageLine(new Date(s0 + 90000).toISOString(), MODELS.haiku, 'req_s', { inTok: 900, out: 2200, cw: 9000, cr: 140000 })].join('\n'))
      }
    }
    // Workflow agent() fan-out: N parallel Fable agents, each declined by the classifier
    // then re-served on Opus — the real story is that MOST switches live here.
    if (wfFallbacks) {
      const wfd = join(sd, 'subagents', 'workflows', 'wf_' + hex().slice(0, 11))
      mkdirSync(wfd, { recursive: true })
      for (let i = 0; i < wfFallbacks; i++) {
        const aid = hex(); const s0 = start + 120000 + i * 2000
        const streamed = i % 3 === 0 // some are streamed refusals (partial row first)
        const rows = [userLine(new Date(s0).toISOString(), 'Build POC ' + (i + 1))]
        if (streamed) rows.push(JSON.stringify({ type: 'assistant', requestId: 'req_wf_' + i, timestamp: new Date(s0 + 500).toISOString(), cwd: CUR.cwd, message: { role: 'assistant', model: MODELS.fable, stop_reason: null, usage: { input_tokens: 400, output_tokens: 30 }, content: [{ type: 'thinking', thinking: '' }] } }))
        // even i → a switch (re-served), odd i → a bare refusal
        rows.push(i % 2 === 0 ? switchLine(new Date(s0 + 1200).toISOString(), 'req_wf_' + i) : refusalLine(new Date(s0 + 1200).toISOString(), 'req_wf_' + i, i % 4 === 1 ? 'cyber' : null))
        writeFileSync(join(wfd, `agent-${aid}.jsonl`), rows.join('\n'))
      }
    }
  }
  const m = live ? Date.now() / 1000 : (start + mins * 60000) / 1000
  utimesSync(p, m, m)
  return id
}

const projects = [
  ['-Users-demo-dev-shopfront', '/Users/demo/dev/shopfront', [
    { title: 'Add rate limiting to the checkout API and write tests', tier: 'opus', daysAgo: 0, mins: 42, turns: 30, scale: 4, subs: ['Explore the payments module', 'Audit error handling in checkout'], live: true },
    { title: 'why is the cart total wrong when a coupon is stacked?', tier: 'sonnet', daysAgo: 1, mins: 18, turns: 12, scale: 1.5 },
    { title: 'Refactor ProductCard to server components', tier: 'fable', daysAgo: 2, mins: 55, turns: 26, scale: 3, subs: ['Map all ProductCard usages'], wfFallbacks: 8, mainRefusals: 1 },
    { title: 'Write release notes for v2.3', tier: 'haiku', daysAgo: 2, mins: 6, turns: 5, scale: 0.6 },
    { title: 'Migrate the orders table to the new schema', tier: 'opus', daysAgo: 4, mins: 70, turns: 40, scale: 5, subs: ['Verify the migration on a copy'] },
    { title: 'Fix flaky checkout e2e test', tier: 'sonnet', daysAgo: 5, mins: 25, turns: 15, scale: 1.2 },
  ]],
  ['-Users-demo-dev-api-server', '/Users/demo/dev/api-server', [
    { title: 'Profile the /search endpoint and cut p95 latency', tier: 'opus', daysAgo: 1, mins: 60, turns: 35, scale: 4.5, subs: ['Trace slow queries in the search path'] },
    { title: 'Add OpenAPI docs for the webhooks API', tier: 'sonnet', daysAgo: 3, mins: 30, turns: 18, scale: 1.4 },
    { title: 'Upgrade to Node 24 and fix breakage', tier: 'fable', daysAgo: 6, mins: 45, turns: 22, scale: 2.6, wfFallbacks: 5, mainSwitches: 1 },
    { title: 'quick: what does this regex do?', tier: 'haiku', daysAgo: 6, mins: 3, turns: 3, scale: 0.3 },
  ]],
  ['-Users-demo-dev-data-pipeline', '/Users/demo/dev/data-pipeline', [
    { title: 'Backfill June events into the warehouse', tier: 'opus', daysAgo: 3, mins: 90, turns: 45, scale: 5.5, subs: ['Validate row counts per day', 'Check dedup keys'], wfFallbacks: 6, mainRefusals: 1 },
    { title: 'Add alerting when the nightly job is late', tier: 'sonnet', daysAgo: 7, mins: 20, turns: 12, scale: 1.1 },
    { title: 'Document the ingestion retry policy', tier: 'haiku', daysAgo: 9, mins: 8, turns: 6, scale: 0.5 },
  ]],
]
for (const [slug, cwd, sessions] of projects) {
  const dir = join(ROOT, slug)
  mkdirSync(dir, { recursive: true })
  CUR = { cwd }
  for (const s of sessions) session(dir, s)
}
console.log('demo data written to', ROOT)
