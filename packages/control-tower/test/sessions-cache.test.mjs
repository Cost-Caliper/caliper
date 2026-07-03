// test/sessions-cache.test.mjs — Disk-backed summary cache round-trip in
// src/sessions.mjs (saveDiskCache / loadDiskCache). loadDiskCache runs ONCE per
// process (diskCacheLoaded flag), so every cross-process assertion here spawns a
// real child `node` process that imports src/sessions.mjs with HOME pointed at a
// per-test sandbox. Wire shapes (uLine/aLine) copied from test/sessions.test.mjs,
// which copies real Claude Code transcript structure. No mocks: real parser, real
// files, real child processes.
//
// The "did it re-parse?" discriminator: corrupt the transcript body with a
// SAME-LENGTH edit ('alpha one' → 'alpha two') and pin mtime back with utimesSync
// to a fixed whole-second epoch (set BEFORE the first summarize, so restore is
// exact — no sub-ms rounding fragility). A cache hit serves the OLD title; a
// fresh parse sees the NEW title. This is provable and pinned exactly.

import './_env.mjs' // FIRST: sandbox HOME for THIS process (we import sessions.mjs transitively via nothing here, but the rule is binding and cheap)
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, renameSync, readdirSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'sessions.mjs')

// Pin the cache filename to the CURRENT version constant (survives future bumps;
// still asserts the versioned-filename contract).
const CACHE_VERSION = (() => {
  const m = readFileSync(SRC, 'utf8').match(/const CACHE_VERSION = (\d+)/)
  assert.ok(m, 'CACHE_VERSION constant not found in src/sessions.mjs')
  return Number(m[1])
})()
const cacheFileOf = (home) => join(home, '.cache', 'workflow-lens', `session-summaries-v${CACHE_VERSION}.json`)

// Real wire shapes — copied from test/sessions.test.mjs (which documents them as
// copies of real Claude Code transcript structure; synthetic content only).
const aLine = (ts, model = 'claude-opus-4-8', text = 'ok') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', model, usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text }] } })
const uLine = (ts, text) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })

const ID = '12345678-9abc-4def-8123-456789abcdef'
const T = 1750000000 // fixed whole-second mtime — utimesSync restore is exact

const transcript = (ask) => [
  uLine('2026-06-01T00:00:00.000Z', ask),
  aLine('2026-06-01T00:00:05.000Z'),
].join('\n')

// One sandbox per test: HOME + project dir + child script, all under one mkdtemp.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ct-sessions-cache-'))
  const home = join(root, 'home')
  const proj = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(proj, { recursive: true })
  const jsonl = join(proj, `${ID}.jsonl`)
  writeFileSync(jsonl, transcript('alpha one'))
  utimesSync(jsonl, T, T) // deterministic mtime, set BEFORE any summarize
  // Child: import the REAL module fresh (per-process diskCacheLoaded flag),
  // summarize, persist, print the summary as JSON.
  const script = join(root, 'child.mjs')
  writeFileSync(script, [
    `import { summarizeSessionFile, saveDiskCache } from ${JSON.stringify(pathToFileURL(SRC).href)}`,
    `const [projDir, id] = process.argv.slice(2)`,
    `const s = summarizeSessionFile(projDir, id)`,
    `saveDiskCache()`,
    `process.stdout.write(JSON.stringify(s))`,
  ].join('\n'))
  return { root, home, proj, jsonl, script }
}

function runChild({ script, home, proj }) {
  const out = execFileSync(process.execPath, [script, proj, ID], {
    env: { ...process.env, HOME: home, USERPROFILE: home }, // explicit sandbox HOME for the child
    encoding: 'utf8',
  })
  return JSON.parse(out)
}

// Same-length corruption + exact mtime restore: cache sees identical (mtimeMs, size).
function corruptSameSize(jsonl) {
  const before = statSync(jsonl)
  writeFileSync(jsonl, transcript('alpha two')) // 'one' → 'two': same byte length
  utimesSync(jsonl, T, T)
  const after = statSync(jsonl)
  assert.equal(after.size, before.size, 'corruption must keep size identical')
  assert.equal(after.mtimeMs, before.mtimeMs, 'corruption must keep mtimeMs identical')
}

// (a) Round-trip across processes: A parses + saves; B (same HOME, fresh process)
// serves the SAME summary from disk WITHOUT re-parsing — proven by corrupting the
// transcript body (mtime+size pinned identical) between A and B: B still reports
// the pre-corruption title, which only the cache can know.
// MUTATION-PROVED: gutted loadDiskCache (added early `return` before diskCacheLoaded
// check body reads the file) → RED: "B must serve the cached summary … 'alpha two' !==
// 'alpha one'". Restored → GREEN.
test('disk cache round-trip: process B serves process A summary without re-parsing', () => {
  const fx = setup()
  try {
    const a = runChild(fx)
    assert.equal(a.title, 'alpha one')
    // Cache file exists under <HOME>/.cache/workflow-lens with the versioned name…
    const cacheFile = cacheFileOf(fx.home)
    assert.ok(existsSync(cacheFile), `expected cache file at ${cacheFile}`)
    // …and is keyed by the absolute transcript path with the (mtimeMs, size) envelope.
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
    assert.ok(fx.jsonl in raw, 'cache must contain the fixture transcript path as a key')
    assert.equal(raw[fx.jsonl].size, statSync(fx.jsonl).size)
    assert.equal(raw[fx.jsonl].summary.title, 'alpha one')

    corruptSameSize(fx.jsonl)
    const b = runChild(fx)
    assert.equal(b.title, 'alpha one', 'B must serve the cached summary (no re-parse of the corrupted body)')
    assert.deepEqual(b, a, 'cached summary must round-trip value-identical across processes')
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})

// (b) Staleness: transcript changes (content + mtime + size) → next process
// re-parses and REPLACES the cache entry.
// MUTATION-PROVED: made the hit check accept stale entries — changed
//   `if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size)` to `if (hit)`
// in summarizeSessionFile → RED: "stale entry must be re-parsed: 'alpha one' !==
// 'a brand new question'". Restored via git checkout → GREEN.
test('disk cache staleness: touched transcript is re-parsed and the entry replaced', () => {
  const fx = setup()
  try {
    const a = runChild(fx)
    assert.equal(a.title, 'alpha one')

    writeFileSync(fx.jsonl, transcript('a brand new question')) // content + size change
    utimesSync(fx.jsonl, T + 500, T + 500)                      // + distinct mtime

    const b = runChild(fx)
    assert.equal(b.title, 'a brand new question', 'stale entry must be re-parsed')
    const raw = JSON.parse(readFileSync(cacheFileOf(fx.home), 'utf8'))
    assert.equal(raw[fx.jsonl].summary.title, 'a brand new question', 'cache entry must be replaced on save')
    assert.equal(raw[fx.jsonl].mtimeMs, statSync(fx.jsonl).mtimeMs)
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})

// (c) Corrupt cache file (invalid JSON) → next process loads fine (catch path),
// re-parses, and can save a valid cache again.
// MUTATION-PROVED: made loadDiskCache rethrow (`catch (e) { throw e }`) → RED: the
// child process dies on the invalid JSON (and, in the other tests, on first-run
// ENOENT — the same catch guards both), execFileSync throws "Command failed".
// Restored via git checkout → GREEN.
test('corrupt disk cache: invalid JSON is ignored, session re-parsed, cache saved again', () => {
  const fx = setup()
  try {
    runChild(fx) // create a real cache first, then trash it
    const cacheFile = cacheFileOf(fx.home)
    writeFileSync(cacheFile, 'this is {not] json') // invalid JSON

    const b = runChild(fx)
    assert.equal(b.title, 'alpha one', 'corrupt cache must not break summarization')
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8')) // valid JSON again
    assert.ok(fx.jsonl in raw, 'save after corrupt load must rewrite a valid cache')
    assert.equal(raw[fx.jsonl].summary.title, 'alpha one')
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})

// (d) CACHE_VERSION isolation, pinned via FILENAME (no permanent mutation of the
// constant): a cache written under a different version's filename is ignored —
// proven with the same corruption discriminator as (a): if the old-version file
// WERE loaded, B would report 'alpha one'; a fresh parse reports 'alpha two'.
// MUTATION-PROVED: made loadDiskCache accept a stale old-version file — replaced
//   const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
// with a try/catch fallback to `session-summaries-v0.json` → RED on exactly this
// test: "different-version cache file must be ignored: 'alpha one' !== 'alpha two'"
// (other three stayed green — targeted kill). Restored via git checkout → GREEN.
test('CACHE_VERSION isolation: a different-version cache file is ignored (fresh parse)', () => {
  const fx = setup()
  try {
    runChild(fx) // writes session-summaries-v<N>.json
    const cacheFile = cacheFileOf(fx.home)
    const oldVersionFile = join(dirname(cacheFile), 'session-summaries-v0.json')
    renameSync(cacheFile, oldVersionFile) // same content, WRONG version filename
    assert.ok(!existsSync(cacheFile))

    corruptSameSize(fx.jsonl) // discriminator: cache hit ⇒ 'alpha one', re-parse ⇒ 'alpha two'
    const b = runChild(fx)
    assert.equal(b.title, 'alpha two', 'different-version cache file must be ignored')
    // B saved under the CURRENT version filename; the old file is untouched.
    assert.ok(existsSync(cacheFile), 'save must recreate the current-version cache file')
    const names = readdirSync(dirname(cacheFile)).sort()
    assert.deepEqual(names, [`session-summaries-v0.json`, `session-summaries-v${CACHE_VERSION}.json`])
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8'))
    assert.equal(raw[fx.jsonl].summary.title, 'alpha two')
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})
