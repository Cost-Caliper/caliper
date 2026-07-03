// test/app-fallback-banner.test.mjs — the CLIENT-SIDE re-computation of the fallback
// headline in public/app.js: the last unguarded hop between correct API data and the
// number that gets screenshotted. Three duplicated/re-derived computations are pinned:
//
//   1. renderSessionInsight's fbAgg forest re-sum (~app.js:2786) — must handle BOTH
//      the observer field name (`stickyTurns`, src/observer.mjs:294) and the session-
//      summary field name (`sticky`, src/sessions.mjs:100). Past shape drift is real.
//   2. renderAggregate's machine banner arithmetic (~app.js:3607) — the "nerfed by
//      Fable N times" headline must satisfy subTotal + mainTotal === switches + refusals
//      and surface the server's total, on the NEW shape (subTotal/mainTotal) and the
//      legacy one (subSwitches/mainSwitches).
//   3. The per-session ⇄ badge sum (switches + refusals — NOT switches only, NOT
//      + sticky), duplicated verbatim at three sites (~app.js:3202/3369/3467).
//
// app.js is a browser script, so (same technique as test/app-helpers.test.mjs) the
// units under test are extracted by ANCHORED regex and evaluated in a vm context;
// every extraction THROWS if its anchor stops matching — refactors fail loudly.
// Inline blocks (fbAgg rollup, banner arithmetic) are wrapped into named functions
// with their real free variables as parameters; nothing is re-implemented.
//
// Fixture shapes mirror the REAL API payloads the code consumes:
//   - /v1/subagents forest nodes: src/subagents.mjs buildForest root + lightNode
//     (fallbacks = the observer per-transcript shape, observer.mjs:294).
//   - /v1/sessions rows: src/sessions.mjs summarizeSessionFile summary
//     (fallbacks = { switches, refusals, sticky, main, sub, categories, from, to }).
//   - /v1/aggregate totals.fallbacks: src/sessions.mjs:221
//     ({ switches, sticky, refusals, mainSwitches, subSwitches, mainTotal, subTotal,
//        wfAgents, sessionsAffected, categories }).
//
// All fixture counts are < 1000 and banner expectations are built with the vm's own
// fmtN, so nothing here pins locale-dependent thousands-separator output.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

// ── Extraction (fail-loud; same pattern as app-helpers.test.mjs) ──────────────

const helpersStart = src.indexOf('// ── Helpers')
const helpersEnd = src.indexOf('// ── State')
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'app.js Helpers block markers not found')
const helpersBlock = src.slice(helpersStart, helpersEnd)

function extract(name) {
  let m = src.match(new RegExp(`^function ${name}\\s*\\(.*\\}\\s*$`, 'm'))       // one-liner
  if (m) return m[0]
  m = src.match(new RegExp(`^function ${name}\\s*\\([\\s\\S]*?^\\}`, 'm'))       // multi-line
  if (m) return m[0]
  m = src.match(new RegExp(`^const ${name}\\s*=[\\s\\S]*?;$`, 'm'))              // const
  if (m) return m[0]
  throw new Error(`helper "${name}" not found in public/app.js — update the extraction in app-fallback-banner.test.mjs`)
}

function extractBlock(re, what) {
  const m = src.match(re)
  if (!m) throw new Error(`${what} not found in public/app.js — update the anchors in app-fallback-banner.test.mjs`)
  return m[0]
}

// renderSessionInsight's inline fbAgg rollup (start + end lines anchored; the
// stickyTurns/sticky line in the middle is deliberately NOT part of the anchor so
// a mutation to it is caught by assertions, not by a failed extraction).
const fbAggBlock = extractBlock(
  /^ {2}const fbAgg = \{ refusals: 0, switches: 0, sticky: 0 \};\n {2}\{\n[\s\S]*?\n {4}if \(sub && sub\.root\) \{ collectFb\(sub\.root\); for \(const c of allSubNodes\(sub\.root\)\) collectFb\(c\); \}\n {2}\}/m,
  "renderSessionInsight's fbAgg rollup block")

// renderAggregate's banner arithmetic: from `const fbAgg = t.fallbacks || {};`
// through the end of the fbBanner ternary (`: '';`). Free variables: t, a, fmtN, esc.
const bannerBlock = extractBlock(
  /^ {2}const fbAgg = t\.fallbacks \|\| \{\};\n[\s\S]*?\n {4}: '';/m,
  "renderAggregate's fb-banner block")

// The ⇄ badge line, duplicated verbatim at sessRowHtml / refreshSessionStrip /
// homeSessRowHtml. Match ALL occurrences so each site is executed below.
const badgeLines = src.match(
  /if \(s\.fallbacks && \(s\.fallbacks\.switches \|\| s\.fallbacks\.refusals\)\) badges\.push\(`[^\n]*`\);/g) || []

const sessionsSortDecl = extractBlock(/^let sessionsSort = '[^']*';/m, 'sessionsSort declaration')

const ctx = vm.createContext({})
vm.runInContext([
  helpersBlock,
  extract('MAIN_SESSION_ID'),
  extract('TIER_COLORS'), extract('tierColor'),
  extract('walkForest'), extract('allSubNodes'),
  extract('SESSION_KIND_COLOR'),
  extract('truncTxt'), extract('repoLabel'),
  extract('sessDayLabel'), extract('sessClock'),
  sessionsSortDecl,
  extract('sessRowHtml'), extract('homeSessRowHtml'),
  // Wrap the two inline blocks into callable units, real free vars as params.
  `function computeSessionFbAgg(sub) {\n${fbAggBlock}\n  return fbAgg;\n}`,
  `function computeFbBanner(a) {\n  const t = a.totals;\n${bannerBlock}\n  return { subTotal, mainTotal, totalSwitches, subShare, fbBanner };\n}`,
  `const BADGE_SITES = [\n${badgeLines.map((l) => `  function (s) { const badges = []; ${l} return badges[0] || ''; },`).join('\n')}\n];`,
].join('\n'), ctx)

const A = vm.runInContext('({ computeSessionFbAgg, computeFbBanner, BADGE_SITES, sessRowHtml, homeSessRowHtml, fmtN })', ctx)
const plain = (v) => v === null ? null : JSON.parse(JSON.stringify(v))
const fmtN = (n) => A.fmtN(n) // the app's own formatter — expectations stay locale-proof

// ── Fixtures (shapes copied from the real producers, see header) ──────────────

// Observer per-transcript fallbacks shape (src/observer.mjs:294) — `stickyTurns`.
const obsFb = (over) => ({
  refusals: 0, switches: 0, stickyTurns: 0, refusalOutputTokens: 0,
  from: 'claude-fable-5', to: 'claude-opus-4-8', firstAt: null, lastAt: null,
  categories: {}, events: [], ...over,
})

// /v1/subagents forest node (src/subagents.mjs lightNode + buildForest decoration).
const subNode = (agentId, fallbacks, children = []) => ({
  agentId, agentType: 'subagent', description: 'synthetic fan-out agent',
  parentToolUseId: 'toolu_01' + agentId, model: 'claude-fable-5', tier: 'fable',
  tokens: { in: 10, out: 20, cacheWr: 0, cacheRd: 0 }, costUsd: 0.01,
  fallbacks, ms: 1000, startedAt: null, startedAtMs: 0, endedAt: null,
  toolCalls: 0, tools: [], turns: 1, status: 'done',
  depth: 1, children, childCount: children.length, orphan: false,
})

const mkSub = (rootFallbacks, children) => ({
  sessionId: '99999999-9999-9999-9999-999999999999',
  root: {
    agentId: '__MAIN_SESSION__', isMain: true, agentType: 'session',
    description: 'main session', depth: 0, children, childCount: children.length,
    orphan: false, fallbacks: rootFallbacks, status: 'session',
  },
  rollup: null, cwd: '/x/alpha', gitBranch: 'main',
})

// /v1/aggregate result (src/sessions.mjs aggregateMachine return shape).
const mkAgg = (fallbacks, done = true) => ({
  done,
  progress: { scannedSessions: 40, totalSessions: 40 },
  totals: {
    sessions: 40, folders: 4, costUsd: 812.5,
    tokens: { in: 1000, out: 2000, cacheRd: 3000, cacheWr: 400 },
    fallbacks,
  },
  byDay: [], byRepo: [], byTier: [],
})

// /v1/sessions row (src/sessions.mjs summarizeSessionFile summary shape).
const mkSessionRow = (fallbacks) => ({
  id: '11111111-1111-1111-1111-111111111111',
  title: 'synthetic session prompt', startedAt: null, endedAt: null,
  ms: 65000, turns: 12, toolCalls: 3,
  tokens: { in: 100, out: 200, cacheWr: 0, cacheRd: 0 },
  costUsd: 1.25, model: 'claude-fable-5', tier: 'fable',
  ...(fallbacks ? { fallbacks } : {}),
  cwd: '/x/alpha', gitBranch: 'main', workflows: 3, subagents: 5,
  hasDir: true, mtimeMs: 0,
})
// Session-summary fallbacks: switches 5 + refusals 4 = 9; sticky 7 must NOT count.
const sessFb = {
  switches: 5, refusals: 4, sticky: 7,
  main: { switches: 1, refusals: 1, sticky: 2 },
  sub: { switches: 4, refusals: 3, sticky: 5, agents: 3, wfAgents: 2 },
  categories: { cyber: 3 }, from: 'claude-fable-5', to: 'claude-opus-4-8',
}
const notEmpty = () => false // sessRowHtml's isEmpty param — rows render non-ghost

// ── 1. fbAgg forest re-sum (session insight) ──────────────────────────────────

// MUTATION-PROVED: changed app.js:2793 to `fbAgg.sticky += n.fallbacks.sticky || 0;`
// (dropped the stickyTurns/sticky dual-name handling) → failed with
// "sticky must roll up across BOTH field names: 13 !== 12"; restored → green.
test('fbAgg rollup: sums refusals/switches/sticky across the whole forest under BOTH sticky field names', () => {
  const grandchild = subNode('agent-cccc3333', obsFb({ refusals: 1, switches: 0, stickyTurns: 0, sticky: 9 })) // both names: stickyTurns wins
  const childA = subNode('agent-aaaa1111', obsFb({ refusals: 1, switches: 2, stickyTurns: 5, categories: { harmful: 1 } }), [grandchild])
  // Legacy/summary-shaped node: `sticky`, no `stickyTurns` key (the past shape drift).
  const childB = subNode('agent-bbbb2222', { switches: 1, refusals: 0, sticky: 4, categories: {}, from: 'claude-fable-5', to: 'claude-opus-4-8' })
  const sub = mkSub(obsFb({ refusals: 2, switches: 1, stickyTurns: 3, categories: { cyber: 2 } }), [childA, childB])
  const agg = plain(A.computeSessionFbAgg(sub))
  assert.equal(agg.refusals, 4, 'refusals: 2 (main) + 1 + 0 + 1 across the forest')
  assert.equal(agg.switches, 4, 'switches: 1 (main) + 2 + 1 + 0 across the forest')
  // 3 (main) + 5 (A) + 4 (B, legacy `sticky`) + 0 (C: stickyTurns=0 beats sticky=9)
  assert.equal(agg.sticky, 12, 'sticky must roll up across BOTH field names: ' + agg.sticky + ' !== 12')
})

test('fbAgg rollup: stickyTurns=0 is a real value — never falls through to a stale sticky field', () => {
  const sub = mkSub(obsFb({ refusals: 1, switches: 1, stickyTurns: 0, sticky: 9 }), [])
  assert.equal(plain(A.computeSessionFbAgg(sub)).sticky, 0, 'stickyTurns != null must take precedence over sticky')
})

test('fbAgg rollup: null sub / fallbacks-less nodes contribute nothing', () => {
  assert.deepEqual(plain(A.computeSessionFbAgg(null)), { refusals: 0, switches: 0, sticky: 0 })
  const clean = mkSub(null, [subNode('agent-dddd4444', null)])
  assert.deepEqual(plain(A.computeSessionFbAgg(clean)), { refusals: 0, switches: 0, sticky: 0 })
})

// ── 2. Machine-banner arithmetic (Home aggregate) ─────────────────────────────

// The real launch shape: mainTotal/subTotal INCLUDE refusals, so the two location
// pills add up to the headline (server invariant, aggregate-fallbacks.test.mjs).
const NEW_SHAPE = {
  switches: 96, sticky: 41, refusals: 8,
  mainSwitches: 2, subSwitches: 94, mainTotal: 3, subTotal: 101,
  wfAgents: 70, sessionsAffected: 23,
  categories: { cyber: 5, harmful: 2, unspecified: 1 },
}

// MUTATION-PROVED: changed app.js:3614 to `const totalSwitches = fbAgg.switches || 0;`
// (client re-derives the headline from switches only, dropping refusals) → failed with
// "headline total = subTotal + mainTotal: 96 !== 104"; restored → green.
test('banner arithmetic: subTotal + mainTotal === switches + refusals, and the banner surfaces the server total', () => {
  const r = A.computeFbBanner(mkAgg(NEW_SHAPE))
  assert.equal(r.subTotal, 101, 'subTotal comes straight from the server field')
  assert.equal(r.mainTotal, 3, 'mainTotal comes straight from the server field')
  assert.equal(r.totalSwitches, 104, 'headline total = subTotal + mainTotal')
  assert.equal(r.totalSwitches, NEW_SHAPE.switches + NEW_SHAPE.refusals,
    `headline must equal switches + refusals: ${r.totalSwitches} !== ${NEW_SHAPE.switches + NEW_SHAPE.refusals}`)
  assert.equal(r.subShare, Math.round((101 / 104) * 100), 'subagent share of the headline')
  // The rendered numbers are the SAME numbers (via the app's own fmtN — locale-proof).
  assert.ok(r.fbBanner.includes(`nerfed by Fable ${fmtN(104)} time`), `headline count missing in: ${r.fbBanner}`)
  assert.ok(r.fbBanner.includes(`<strong>${fmtN(101)}</strong> in subagents`), 'subagent pill count')
  assert.ok(r.fbBanner.includes(`<strong>${fmtN(3)}</strong> in main chat`), 'main-chat pill count')
  assert.ok(r.fbBanner.includes(`<strong>${fmtN(101)} + ${fmtN(3)} = ${fmtN(104)}</strong>`), 'the honest-arithmetic note shows the same sum')
  assert.ok(r.fbBanner.includes(`across <strong>${fmtN(23)}</strong> sessions`), 'sessionsAffected pill')
  assert.ok(r.fbBanner.includes(`${fmtN(8)} were outright refusals`), 'refusal count in the note')
  assert.ok(r.fbBanner.includes('why: cyber ×5 · harmful ×2'), 'categories sorted desc, "unspecified" excluded')
  assert.ok(!r.fbBanner.includes('fb-banner-scanning'), 'done scan is not marked scanning')
})

// MUTATION-PROVED: changed app.js:3612 to `const subTotal = (fbAgg.subSwitches || 0);`
// (dropped the new-shape field, always using the legacy fallback) → failed with
// "subTotal comes straight from the server field: 94 !== 101"; restored → green.
test('banner arithmetic: legacy shape (no subTotal/mainTotal) falls back to subSwitches/mainSwitches', () => {
  const legacy = { switches: 5, sticky: 2, refusals: 0, mainSwitches: 2, subSwitches: 3, sessionsAffected: 4, categories: {} }
  const r = A.computeFbBanner(mkAgg(legacy))
  assert.equal(r.subTotal, 3)
  assert.equal(r.mainTotal, 2)
  assert.equal(r.totalSwitches, 5)
  assert.ok(!r.fbBanner.includes('outright refusals'), 'no refusal clause when refusals=0')
})

test('banner arithmetic: an explicit subTotal of 0 is respected (not treated as missing)', () => {
  const r = A.computeFbBanner(mkAgg({ switches: 4, refusals: 0, sticky: 0, mainSwitches: 4, subSwitches: 9, mainTotal: 4, subTotal: 0, sessionsAffected: 1, categories: {} }))
  assert.equal(r.subTotal, 0, 'subTotal=0 must not fall through to subSwitches')
  assert.equal(r.totalSwitches, 4)
  assert.equal(r.subShare, 0)
})

test('banner arithmetic: zero events → no banner; unfinished scan is marked scanning', () => {
  const none = A.computeFbBanner(mkAgg({ switches: 0, sticky: 0, refusals: 0, mainSwitches: 0, subSwitches: 0, mainTotal: 0, subTotal: 0, wfAgents: 0, sessionsAffected: 0, categories: {} }))
  assert.equal(none.totalSwitches, 0)
  assert.equal(none.fbBanner, '', 'no fallback events → banner suppressed entirely')
  const scanning = A.computeFbBanner(mkAgg(NEW_SHAPE, false))
  assert.ok(scanning.fbBanner.includes('fb-banner-scanning'), 'in-progress scan gets the scanning class')
  assert.ok(scanning.fbBanner.includes('(scanning…)'), 'in-progress scan says so next to the headline')
})

// ── 3. Per-session ⇄ badge sums (three duplicated sites) ─────────────────────

// MUTATION-PROVED: changed the sessRowHtml badge (app.js:3202) to
// `⇄ ${(s.fallbacks.switches || 0)} fallback` (dropped `+ refusals`) → failed with
// "badge site #1 must show switches+refusals" ('⇄ 5 fallback' rendered); restored → green.
test('⇄ badge: all three duplicated sites render switches + refusals — not switches only, not + sticky', () => {
  assert.equal(A.BADGE_SITES.length, 3,
    'expected the ⇄ badge at exactly 3 sites (sessRowHtml, refreshSessionStrip, homeSessRowHtml) — update app-fallback-banner.test.mjs if a site moved')
  const s = mkSessionRow(sessFb)
  A.BADGE_SITES.forEach((site, i) => {
    const badge = site(s)
    assert.ok(badge.includes('⇄ 9 fallback'), `badge site #${i + 1} must show switches+refusals (5+4=9), got: ${badge}`)
    assert.ok(!badge.includes('⇄ 5 '), `badge site #${i + 1} must not count switches only`)
    assert.ok(!badge.includes('⇄ 16 '), `badge site #${i + 1} must not add sticky turns (9+7=16)`)
    assert.ok(badge.includes('4 refusal(s), 5 switch(es)'), `badge site #${i + 1} title breaks down the sum`)
    assert.ok(badge.includes('7 turn(s) served on it'), `badge site #${i + 1} title reports sticky separately`)
  })
})

test('sessRowHtml: session row carries the ⇄ 9 badge (plus wf/sub badges); refusal-only sessions still badge; clean rows never do', () => {
  const html = A.sessRowHtml(mkSessionRow(sessFb), 'some-other-session-id', notEmpty)
  assert.ok(html.includes('⇄ 9 fallback'), `row badge must be switches+refusals, got: ${html}`)
  assert.ok(html.includes('sess-badge-fallback'), 'fallback badge class present')
  assert.ok(html.includes('>3 wf<') && html.includes('>5 sub<'), 'wf/sub badges unaffected')
  // refusal-only (switches=0): the badge must still appear, counting the refusals.
  const refusalOnly = A.sessRowHtml(mkSessionRow({ ...sessFb, switches: 0, refusals: 2 }), 'x', notEmpty)
  assert.ok(refusalOnly.includes('⇄ 2 fallback'), `refusal-only session must badge its 2 refusals, got: ${refusalOnly}`)
  const clean = A.sessRowHtml(mkSessionRow(null), 'x', notEmpty)
  assert.ok(!clean.includes('sess-badge-fallback'), 'clean session renders no ⇄ badge')
})

test('homeSessRowHtml: machine-wide row uses the same switches + refusals badge sum', () => {
  const s = { ...mkSessionRow(sessFb), projectSlug: '-x-alpha', projectCwd: '/x/alpha' }
  const html = A.homeSessRowHtml(s)
  assert.ok(html.includes('⇄ 9 fallback'), `home row badge must be switches+refusals, got: ${html}`)
  assert.ok(!html.includes('⇄ 16 fallback'), 'home row must not add sticky turns')
  const clean = A.homeSessRowHtml({ ...mkSessionRow(null), projectSlug: '-x-alpha', projectCwd: '/x/alpha' })
  assert.ok(!clean.includes('sess-badge-fallback'), 'clean home row renders no ⇄ badge')
})
