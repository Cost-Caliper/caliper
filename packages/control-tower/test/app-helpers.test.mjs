// test/app-helpers.test.mjs — unit tests for the pure helpers inside public/app.js.
// app.js is a browser script (not a module), so we extract the helper source by
// anchored regex and evaluate it in a vm context. Extraction THROWS if a helper
// disappears/renames — a refactor must fail this suite loudly, never skip silently.
//
// Headline: fmtUsdShort's thousands separators ($16,965 not $16965) — the launch-
// number formatting fix. It hardcodes en-US so we pin exact output; genuinely
// locale/TZ-dependent helpers (fmtN, fmtWhen, ...) are NOT pinned here.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

// Helpers block: esc, fmtUsd, fmtMs, fmtN, fmtNshort, fmtUsdShort (the `$` helper
// inside only references `document` lazily — safe to evaluate without a DOM).
const helpersStart = src.indexOf('// ── Helpers')
const helpersEnd = src.indexOf('// ── State')
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'app.js Helpers block markers not found')
const helpersBlock = src.slice(helpersStart, helpersEnd)

// Remaining declarations, each anchored at column 0. Three shapes in app.js:
// one-line `function name(...) { ... }`, multi-line closing with `}` at column 0,
// and `const NAME = ...;` (possibly spanning lines, ending `;` at end-of-line).
function extract(name) {
  let m = src.match(new RegExp(`^function ${name}\\s*\\(.*\\}\\s*$`, 'm'))       // one-liner
  if (m) return m[0]
  m = src.match(new RegExp(`^function ${name}\\s*\\([\\s\\S]*?^\\}`, 'm'))       // multi-line
  if (m) return m[0]
  m = src.match(new RegExp(`^const ${name}\\s*=[\\s\\S]*?;$`, 'm'))              // const
  if (m) return m[0]
  throw new Error(`helper "${name}" not found in public/app.js — update the extraction in app-helpers.test.mjs`)
}

const NAMES = [
  'TIER_COLORS', 'tierColor', 'statusClass', 'traceChipClass', 'tierBadge',
  'homeAbbrev', 'abbrevDir', 'obsDistinct', 'truncTxt', 'walkForest', 'allSubNodes',
  'siDur', 'modelTier', 'modelColor', 'repoLabel', 'projectGroupKey', 'parseNavHash',
  'JS_KEYWORDS', 'highlightJs', 'highlightJson',
]

const MAIN_SESSION_ID = '__MAIN_SESSION__' // allSubNodes' only external binding
const ctx = vm.createContext({ MAIN_SESSION_ID })
vm.runInContext([helpersBlock, ...NAMES.map(extract)].join('\n'), ctx)
// Objects/arrays created inside the vm realm carry that realm's prototypes, which
// strict deepEqual rejects — round-trip through JSON to compare structure only.
const plain = (v) => v === null ? null : JSON.parse(JSON.stringify(v))

const H = vm.runInContext(`({
  esc, fmtUsd, fmtMs, fmtNshort, fmtUsdShort,
  tierColor, statusClass, traceChipClass, tierBadge, homeAbbrev, abbrevDir,
  obsDistinct, truncTxt, walkForest, allSubNodes, siDur, modelTier, modelColor,
  repoLabel, projectGroupKey, parseNavHash, highlightJs, highlightJson,
})`, ctx)

// ── fmtUsdShort — the launch-number formatter ────────────────────────────────

// MUTATION-PROVED: removed `.toLocaleString('en-US')` from fmtUsdShort in
// public/app.js → this test failed with '$16965' !== '$16,965'; restored → green.
test('fmtUsdShort: >= $100 rounds to whole dollars WITH thousands separators', () => {
  assert.equal(H.fmtUsdShort(16965), '$16,965')   // the headline number
  assert.equal(H.fmtUsdShort(100), '$100')        // boundary: exactly 100
  assert.equal(H.fmtUsdShort(1234567.89), '$1,234,568')
})

test('fmtUsdShort: $1–$100 uses 2 decimals, < $1 uses 3 decimals', () => {
  assert.equal(H.fmtUsdShort(5.678), '$5.68')
  assert.equal(H.fmtUsdShort(1), '$1.00')         // boundary: exactly 1
  assert.equal(H.fmtUsdShort(0.1234), '$0.123')
  assert.equal(H.fmtUsdShort(0), '$0.000')
})

test('fmtUsdShort: boundary rounding and degenerate inputs (pins current behavior)', () => {
  assert.equal(H.fmtUsdShort(0.9995), '$1.000')   // <1 branch, toFixed(3) rounds up
  assert.equal(H.fmtUsdShort(99.999), '$100.00')  // <100 branch, toFixed(2) rounds up
  assert.equal(H.fmtUsdShort(-5), '$-5.000')      // negatives fall to the 3-decimal branch
  assert.equal(H.fmtUsdShort(null), '$0.000')
  assert.equal(H.fmtUsdShort(undefined), '$0.000')
})

// ── esc ───────────────────────────────────────────────────────────────────────

// MUTATION-PROVED: dropped the `'"': '&quot;'` map entry in public/app.js esc →
// failed with '&amp;&lt;&gt;undefined&#39;' !== expected; restored → green.
test('esc: escapes all five HTML entities; nullish → empty string', () => {
  assert.equal(H.esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
  assert.equal(H.esc('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;')
  assert.equal(H.esc(null), '')
  assert.equal(H.esc(undefined), '')
})

// ── fmtMs / fmtNshort / fmtUsd ────────────────────────────────────────────────

// MUTATION-PROVED: changed fmtMs's `ms < 1000` threshold to `ms < 100` in
// public/app.js → failed with '0.5 s' !== '500 ms'; restored → green.
test('fmtMs: ms / seconds / minutes / hours thresholds', () => {
  assert.equal(H.fmtMs(500), '500 ms')
  assert.equal(H.fmtMs(5500), '5.5 s')      // < 10s keeps one decimal
  assert.equal(H.fmtMs(30000), '30 s')
  assert.equal(H.fmtMs(65000), '1m 5s')
  assert.equal(H.fmtMs(3723000), '1h 2m 3s')
  assert.equal(H.fmtMs(3720000), '1h 2m')   // zero seconds elided in hour form
})

test('fmtNshort: compact K/M notation', () => {
  assert.equal(H.fmtNshort(999), '999')
  assert.equal(H.fmtNshort(1500), '2K')     // K variant rounds, no decimal
  assert.equal(H.fmtNshort(2.5e6), '2.5M')  // < 1e7 keeps one decimal
  assert.equal(H.fmtNshort(1.2e7), '12M')
  assert.equal(H.fmtNshort(0), '0')
})

test('fmtUsd: full 6-decimal form', () => {
  assert.equal(H.fmtUsd(0), '$0.000000')
  assert.equal(H.fmtUsd(1.5), '$1.500000')
})

// ── truncTxt / siDur ──────────────────────────────────────────────────────────

test('truncTxt: exact-length contract — result never exceeds n chars', () => {
  assert.equal(H.truncTxt('abcde', 5), 'abcde')       // fits: untouched
  assert.equal(H.truncTxt('abcdef', 5), 'abcd…')      // over: n-1 chars + ellipsis
  assert.equal(H.truncTxt('abcdef', 5).length, 5)
  assert.equal(H.truncTxt(null, 5), '')
})

test('siDur: null for zero/negative, s/m/h+m/d+h buckets', () => {
  assert.equal(H.siDur(0), null)
  assert.equal(H.siDur(-100), null)
  assert.equal(H.siDur(30000), '30s')
  assert.equal(H.siDur(3900000), '1h 5m')
  assert.equal(H.siDur(90000000), '1d 1h')
})

// ── model tiers & colors ──────────────────────────────────────────────────────

test('modelTier: fable outranks opus in the substring priority; unknown → other', () => {
  assert.equal(H.modelTier('claude-fable-opus'), 'fable') // fable checked first
  assert.equal(H.modelTier('claude-opus-4-1'), 'opus')
  assert.equal(H.modelTier('claude-sonnet-4-5'), 'sonnet')
  assert.equal(H.modelTier('claude-haiku-4-5'), 'haiku')
  assert.equal(H.modelTier('gpt-4'), 'other')
  assert.equal(H.modelTier(null), 'other')
})

test('tierColor / modelColor: known tiers, unknown falls back to #666 / #8a8f98', () => {
  assert.equal(H.tierColor('haiku'), '#2fb888')
  assert.equal(H.tierColor('fable'), '#8b5cf6')
  assert.equal(H.tierColor('nope'), '#666')
  assert.equal(H.modelColor('other'), '#8a8f98')
  assert.equal(H.modelColor('opus'), H.tierColor('opus'))
})

test('tierBadge / statusClass / traceChipClass mappings', () => {
  assert.equal(H.tierBadge('haiku'), 'badge-green')
  assert.equal(H.tierBadge('sonnet'), 'badge-amber')
  assert.equal(H.tierBadge('opus'), 'badge-red')
  assert.equal(H.tierBadge('fable'), 'badge-gray')     // no fable case → default
  assert.equal(H.statusClass('completed'), 'obs-run-status-completed')
  assert.equal(H.statusClass('OK'), 'obs-run-status-completed') // case-insensitive
  assert.equal(H.statusClass('running'), 'obs-run-status-running')
  assert.equal(H.statusClass('error'), 'obs-run-status-error')
  assert.equal(H.statusClass('???'), 'obs-run-status-unknown')
  assert.equal(H.traceChipClass('cache-hit'), 'trace-cache-hit')
  assert.equal(H.traceChipClass('enter'), 'trace-enter')
  assert.equal(H.traceChipClass('return'), 'trace-enter') // return shares enter's chip
  assert.equal(H.traceChipClass('bogus'), 'trace-enter')  // unknown falls back too
})

// ── paths ─────────────────────────────────────────────────────────────────────

test('homeAbbrev / abbrevDir: home folding and deep-path elision', () => {
  assert.equal(H.homeAbbrev('/Users/x/dev/proj'), '~/dev/proj')
  assert.equal(H.homeAbbrev('/home/x/dev/proj'), '~/dev/proj')
  assert.equal(H.homeAbbrev('/opt/thing'), '/opt/thing')
  assert.equal(H.abbrevDir('/Users/x/a/b/c/d/e'), '~/…/d/e')
  assert.equal(H.abbrevDir('/Users/x/dev'), '~/dev') // <= 3 segments: untouched
  assert.equal(H.abbrevDir(''), '')
})

test('repoLabel: conductor worktrees read as "repo · wt"; others as dir name', () => {
  assert.deepEqual(plain(H.repoLabel('/Users/x/conductor/workspaces/myrepo/mywt')),
    { repo: 'myrepo', wt: 'mywt', text: 'myrepo · mywt' })
  assert.deepEqual(plain(H.repoLabel('/Users/x/dev/proj')),
    { repo: 'proj', wt: null, text: 'proj' })
})

test('projectGroupKey: conductor workspaces group under the repo; others under parent', () => {
  assert.deepEqual(plain(H.projectGroupKey({ cwd: '/Users/x/conductor/workspaces/repo/wt' })),
    { key: '/Users/x/conductor/workspaces/repo', label: 'repo — conductor worktrees' })
  assert.deepEqual(plain(H.projectGroupKey({ cwd: '/Users/x/dev/proj' })),
    { key: '/Users/x/dev', label: '~/dev/' })
})

// ── obsDistinct / forest walking ──────────────────────────────────────────────

test('obsDistinct: dedupes, drops falsy, sorts', () => {
  assert.deepEqual(plain(H.obsDistinct(['b', 'a', 'b', null, '', undefined, 'a'])), ['a', 'b'])
  assert.deepEqual(plain(H.obsDistinct([])), [])
})

test('walkForest / allSubNodes: visits whole tree, excludes the main session', () => {
  const tree = {
    agentId: MAIN_SESSION_ID,
    children: [
      { agentId: 'a', children: [{ agentId: 'b' }] },
      { agentId: 'c' },
    ],
  }
  const visited = []
  H.walkForest(tree, (n) => visited.push(n.agentId))
  assert.deepEqual(visited, [MAIN_SESSION_ID, 'a', 'b', 'c'])
  assert.deepEqual(plain(H.allSubNodes(tree).map((n) => n.agentId)), ['a', 'b', 'c'])
  assert.deepEqual(plain(H.allSubNodes(null)), []) // null root: walkForest bails
})

// ── nav hash ──────────────────────────────────────────────────────────────────

test('parseNavHash: full hash, tab-only, and garbage', () => {
  const uuid = '123e4567-e89b-12d3-a456-426614174000'
  assert.deepEqual(plain(H.parseNavHash(`#/subagents/${uuid}/sub-1`)),
    { tab: 'subagents', sessionId: uuid, sub: 'sub-1' })
  assert.deepEqual(plain(H.parseNavHash('#/home')), { tab: 'home', sessionId: null, sub: null })
  assert.equal(H.parseNavHash('garbage'), null)
  assert.equal(H.parseNavHash(''), null)
  assert.equal(H.parseNavHash(null), null)
})

// ── syntax highlighters ───────────────────────────────────────────────────────

test('highlightJson: keys vs string values, and HTML is escaped', () => {
  const out = H.highlightJson('{"name": "<b>"}')
  assert.ok(out.includes('<span class="hl-key">&quot;name&quot;</span>'), `key span missing in: ${out}`)
  assert.ok(out.includes('<span class="hl-string">&quot;&lt;b&gt;&quot;</span>'), `string span missing in: ${out}`)
  assert.ok(!out.includes('<b>'), 'raw HTML leaked through highlightJson')
  const lit = H.highlightJson('[true, 42]')
  assert.ok(lit.includes('<span class="hl-kw">true</span>'), `literal span missing in: ${lit}`)
  assert.ok(lit.includes('<span class="hl-num">42</span>'), `number span missing in: ${lit}`)
})

test('highlightJs: keywords, strings, numbers, comments; HTML escaped', () => {
  const out = H.highlightJs("const x = 'a<b' // note")
  assert.ok(out.includes('<span class="hl-kw">const</span>'), `kw span missing in: ${out}`)
  assert.ok(out.includes(`<span class="hl-string">&#39;a&lt;b&#39;</span>`), `string span missing in: ${out}`)
  assert.ok(out.includes('<span class="hl-comment">// note</span>'), `comment span missing in: ${out}`)
  assert.ok(H.highlightJs('42').includes('<span class="hl-num">42</span>'))
})
