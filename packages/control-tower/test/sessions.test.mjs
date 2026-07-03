// test/sessions.test.mjs — Sessions browser: scan a Claude project dir for ALL
// sessions (including "regular" ones with no workflows/subagents dir) and produce
// per-session stats. Keyless; synthetic fixtures (portable, no real session).

import './_env.mjs' // FIRST: sandbox HOME so the summary disk cache never touches ~/.cache
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanProjectSessions, summarizeSessionFile, listProjects, buildHomeData, aggregateMachine, resetAggregateScan } from '../src/sessions.mjs'
import { scanSubagentTree, MAIN_SESSION } from '../src/subagents.mjs'

const aLine = (ts, model = 'claude-opus-4-8', text = 'ok') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', model, usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'text', text }] } })
const uLine = (ts, text) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } })

const RICH_ID = '11111111-2222-3333-4444-555555555555'
const PLAIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function makeProjectFixture() {
  const proj = mkdtempSync(join(tmpdir(), 'ct-sessions-'))
  // Rich session: jsonl + session dir with 2 workflows and 1 subagent
  writeFileSync(join(proj, `${RICH_ID}.jsonl`), [
    uLine('2026-06-01T00:00:00.000Z', 'build me a rocket'),
    aLine('2026-06-01T00:00:05.000Z'),
    aLine('2026-06-01T00:10:00.000Z'),
  ].join('\n'))
  const richDir = join(proj, RICH_ID)
  mkdirSync(join(richDir, 'workflows'), { recursive: true })
  writeFileSync(join(richDir, 'workflows', 'wf_abc123-def.json'), JSON.stringify({ workflowName: 'x' }))
  writeFileSync(join(richDir, 'workflows', 'wf_zzz999-yyy.json'), JSON.stringify({ workflowName: 'y' }))
  mkdirSync(join(richDir, 'subagents'), { recursive: true })
  writeFileSync(join(richDir, 'subagents', 'agent-ab12cd34.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'sub', toolUseId: 'tX' }))
  writeFileSync(join(richDir, 'subagents', 'agent-ab12cd34.jsonl'), [uLine('2026-06-01T00:01:00.000Z', 'sub task'), aLine('2026-06-01T00:01:10.000Z', 'claude-haiku-4-5')].join('\n'))
  // Plain session: ONLY a jsonl — no dir at all (John's "regular session")
  writeFileSync(join(proj, `${PLAIN_ID}.jsonl`), [
    uLine('2026-06-02T00:00:00.000Z', 'quick question about x'),
    aLine('2026-06-02T00:00:03.000Z', 'claude-sonnet-4-6'),
  ].join('\n'))
  // Noise that must be ignored: non-uuid jsonl + random file + a bare dir
  writeFileSync(join(proj, 'not-a-session.jsonl'), uLine('2026-06-01T00:00:00.000Z', 'noise'))
  writeFileSync(join(proj, 'readme.txt'), 'hi')
  return proj
}

test('scanProjectSessions: finds uuid sessions only, newest-first, with stats + counts', () => {
  const proj = makeProjectFixture()
  try {
    // Make PLAIN the most recently touched file
    const now = Date.now() / 1000
    utimesSync(join(proj, `${PLAIN_ID}.jsonl`), now, now)
    utimesSync(join(proj, `${RICH_ID}.jsonl`), now - 1000, now - 1000)

    const out = scanProjectSessions(proj)
    assert.equal(out.projectDir, proj)
    assert.equal(out.sessions.length, 2) // noise excluded
    assert.equal(out.sessions[0].id, PLAIN_ID) // newest-first by mtime

    const rich = out.sessions.find((s) => s.id === RICH_ID)
    assert.equal(rich.workflows, 2)
    assert.equal(rich.subagents, 1)
    assert.equal(rich.hasDir, true)
    assert.equal(rich.title, 'build me a rocket')
    assert.equal(rich.turns, 2)
    assert.ok(rich.costUsd > 0)
    assert.equal(rich.tokens.in, 200)
    assert.equal(rich.tokens.out, 40)
    assert.equal(rich.model, 'claude-opus-4-8')
    // Timing derives from assistant-turn timestamps (parseAgentTranscript light contract)
    assert.equal(rich.startedAt, '2026-06-01T00:00:05.000Z')
    assert.equal(rich.ms, 10 * 60 * 1000 - 5000)

    const plain = out.sessions.find((s) => s.id === PLAIN_ID)
    assert.equal(plain.workflows, 0)
    assert.equal(plain.subagents, 0)
    assert.equal(plain.hasDir, false)
    assert.equal(plain.title, 'quick question about x')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

test('scanProjectSessions: limit caps the list; summaries are cached by mtime+size', () => {
  const proj = makeProjectFixture()
  try {
    const one = scanProjectSessions(proj, { limit: 1 })
    assert.equal(one.sessions.length, 1)
    assert.equal(one.totalSessions, 2) // reports how many exist beyond the cap

    // Cache: same file → same object identity; touched file → re-summarized
    const a = summarizeSessionFile(proj, PLAIN_ID)
    const b = summarizeSessionFile(proj, PLAIN_ID)
    assert.equal(a, b)
    writeFileSync(join(proj, `${PLAIN_ID}.jsonl`), [uLine('2026-06-02T00:00:00.000Z', 'edited'), aLine('2026-06-02T00:00:03.000Z')].join('\n'))
    const c = summarizeSessionFile(proj, PLAIN_ID)
    assert.notEqual(a, c)
    assert.equal(c.title, 'edited')
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

test('summarizeSessionFile: rejects non-uuid ids (path traversal guard)', () => {
  const proj = makeProjectFixture()
  try {
    assert.equal(summarizeSessionFile(proj, '../../etc/passwd'), null)
    assert.equal(summarizeSessionFile(proj, 'not-a-session'), null)
  } finally { rmSync(proj, { recursive: true, force: true }) }
})

test('listProjects: enumerates project dirs with real cwd, session count, last activity', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-projects-'))
  try {
    // Project A: 2 sessions, cwd recoverable from transcript
    const projA = join(root, '-Users-x-develop-alpha')
    mkdirSync(projA, { recursive: true })
    writeFileSync(join(projA, `${RICH_ID}.jsonl`), [uLine('2026-06-01T00:00:00.000Z', 'hi'), aLine('2026-06-01T00:00:05.000Z')].join('\n'))
    writeFileSync(join(projA, `${PLAIN_ID}.jsonl`), [uLine('2026-06-02T00:00:00.000Z', 'yo'), aLine('2026-06-02T00:00:03.000Z')].join('\n'))
    // Project B: empty project dir (no sessions) — listed with zero count
    mkdirSync(join(root, '-Users-x-develop-beta'), { recursive: true })
    // Noise: a stray file at the root
    writeFileSync(join(root, 'stray.txt'), 'x')

    const projects = listProjects(root)
    assert.equal(projects.length, 2)
    const a = projects.find((p) => p.slug === '-Users-x-develop-alpha')
    assert.equal(a.sessionCount, 2)
    assert.equal(a.cwd, '/repo') // recovered from the newest transcript's cwd field
    assert.ok(a.lastActivityMs > 0)
    const b = projects.find((p) => p.slug === '-Users-x-develop-beta')
    assert.equal(b.sessionCount, 0)
    assert.equal(b.cwd, null)
    // newest-first ordering
    assert.equal(projects[0].slug, '-Users-x-develop-alpha')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('buildHomeData: cross-folder recents + bounded folder spend rollups', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-home-'))
  try {
    const projA = join(root, '-Users-x-develop-alpha')
    mkdirSync(projA, { recursive: true })
    writeFileSync(join(projA, `${RICH_ID}.jsonl`), [uLine('2026-06-01T00:00:00.000Z', 'alpha work'), aLine('2026-06-01T00:00:05.000Z')].join('\n'))
    const projB = join(root, '-Users-x-develop-beta')
    mkdirSync(projB, { recursive: true })
    writeFileSync(join(projB, `${PLAIN_ID}.jsonl`), [uLine('2026-06-02T00:00:00.000Z', 'beta work'), aLine('2026-06-02T00:00:03.000Z')].join('\n'))
    // Pin mtimes explicitly — back-to-back writes can land in the same mtime
    // tick on ext4 (Linux CI), making the newest-first sort order arbitrary.
    const now = Date.now() / 1000
    utimesSync(join(projB, `${PLAIN_ID}.jsonl`), now, now)
    utimesSync(join(projA, `${RICH_ID}.jsonl`), now - 1000, now - 1000)

    const home = buildHomeData(root, { folders: 5, perFolder: 8, recents: 10 })
    assert.ok(home.projects.length >= 2)                       // full picker list
    assert.equal(home.recents.length, 2)                        // merged across folders
    assert.equal(home.recents[0].title, 'beta work')            // newest-first
    assert.ok(home.recents[0].projectSlug.includes('beta'))     // knows its folder
    const ft = home.folderTotals.find((f) => f.slug.includes('alpha'))
    assert.ok(ft && ft.costUsd > 0 && ft.sessions === 1)
    assert.equal(typeof ft.coverage, 'number')                  // honest "N most recent" bound
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('aggregateMachine: machine-wide totals, by-day/by-repo/by-tier, incremental progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-agg-'))
  try {
    const projA = join(root, '-Users-x-develop-alpha')
    mkdirSync(projA, { recursive: true })
    writeFileSync(join(projA, `${RICH_ID}.jsonl`), [uLine('2026-06-01T00:00:00.000Z', 'alpha'), aLine('2026-06-01T00:00:05.000Z')].join('\n'))
    const projB = join(root, '-Users-x-conductor-workspaces-beta-wt1')
    mkdirSync(projB, { recursive: true })
    writeFileSync(join(projB, `${PLAIN_ID}.jsonl`), [uLine('2026-06-02T00:00:00.000Z', 'beta'), aLine('2026-06-02T00:00:03.000Z', 'claude-haiku-4-5')].join('\n'))

    resetAggregateScan()
    const a = aggregateMachine(root, { budgetMs: 5000 })
    assert.equal(a.done, true)
    assert.equal(a.progress.scannedSessions, 2)
    assert.equal(a.totals.sessions, 2)
    assert.ok(a.totals.costUsd > 0)
    assert.ok(a.totals.tokens.out > 0)
    assert.equal(a.byDay.length >= 2, true)                       // one bucket per active day
    assert.ok(a.byDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)))
    // both fixture transcripts carry cwd:'/repo' → grouped under one repo with 2 sessions
    assert.ok(a.byRepo.length >= 1)
    assert.equal(a.byRepo[0].sessions, 2)
    assert.ok(a.byTier.some((t) => t.tier === 'haiku' && t.costUsd > 0))
    // Second call is served from the completed scan (no rescan needed)
    const b = aggregateMachine(root, { budgetMs: 1 })
    assert.equal(b.done, true)
    assert.equal(b.totals.sessions, 2)
  } finally { rmSync(root, { recursive: true, force: true }); resetAggregateScan() }
})

test('scanSubagentTree: a REGULAR session (no subagents dir) still yields a MAIN root with stats', () => {
  const proj = makeProjectFixture()
  try {
    const tree = scanSubagentTree(join(proj, PLAIN_ID)) // dir does not exist; sibling jsonl does
    assert.ok(tree.root, 'root should exist for a plain session')
    assert.equal(tree.root.agentId, MAIN_SESSION)
    assert.equal(tree.root.children.length, 0)
    assert.ok(tree.root.costUsd > 0, 'main stats should be attached')
    assert.equal(tree.rollup.totalSubagents, 0)
    assert.equal(tree.cwd, '/repo')
    assert.equal(tree.sessionId, PLAIN_ID)
  } finally { rmSync(proj, { recursive: true, force: true }) }
})
