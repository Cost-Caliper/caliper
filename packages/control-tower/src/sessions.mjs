// src/sessions.mjs — Sessions browser: enumerate EVERY session in a Claude project
// dir (~/.claude/projects/<slug>/), including "regular" sessions that never ran a
// workflow or spawned a subagent (those have only a <uuid>.jsonl and no session dir).
//
// Per-session stats are reconstructed from the transcript with the same light parser
// the subagents view uses, so cost/tokens/turns are consistent across the app.
// Summaries are cached by (mtime, size) — a big project re-lists instantly.

import { readdirSync, statSync, existsSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { parseAgentTranscript } from './observer.mjs'
import { costOfUsage, tierFromModel } from './observe-cost.mjs'

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

const summaryCache = new Map() // absolute jsonl path -> { mtimeMs, size, summary }

// ── Disk-backed summary cache ─────────────────────────────────────────────────
// Machine-wide aggregation summarizes EVERY session once (multi-GB of transcripts) —
// persisting summaries makes that a one-time cost across restarts. Versioned: bump
// CACHE_VERSION whenever the cost model or summary shape changes (v2 = TTL-bucketed
// cache pricing + requestId dedup of 2026-07-01).
const CACHE_VERSION = 2
const CACHE_FILE = join(homedir() || tmpdir(), '.cache', 'workflow-lens', `session-summaries-v${CACHE_VERSION}.json`)
let diskCacheLoaded = false
let unsavedSummaries = 0
function loadDiskCache() {
  if (diskCacheLoaded) return
  diskCacheLoaded = true
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    for (const [path, entry] of Object.entries(raw)) if (!summaryCache.has(path)) summaryCache.set(path, entry)
  } catch { /* first run / unreadable — fine */ }
}
export function saveDiskCache() {
  try {
    mkdirSync(join(homedir() || tmpdir(), '.cache', 'workflow-lens'), { recursive: true })
    const tmp = CACHE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(summaryCache)))
    renameSync(tmp, CACHE_FILE)
    unsavedSummaries = 0
  } catch { /* cache is best-effort */ }
}

const trunc = (s, n) => (s == null ? null : String(s).length > n ? String(s).slice(0, n) + '…' : String(s))

// First user messages often open with harness tag blocks (<local-command-caveat>…,
// <command-name>…, system reminders) — strip leading well-formed blocks so the session
// title shows the human ask. Falls back to the raw text when nothing survives.
function cleanTitle(raw) {
  let t = String(raw || '')
  for (let i = 0; i < 4; i++) {
    const next = t.replace(/^\s*<([a-z][\w-]*)>[\s\S]*?<\/\1>\s*/i, '')
    if (next === t) break
    t = next
  }
  t = t.replace(/^\s*<[^>\n]{1,80}>\s*/, '')
  t = t.replace(/\s+/g, ' ').trim()
  return t || String(raw || '').replace(/\s+/g, ' ').trim()
}

function countDir(dir, re) {
  try { return readdirSync(dir).filter((f) => re.test(f)).length } catch { return 0 }
}

// Summarize ONE session by id. Returns the cached summary object when the transcript
// is unchanged (callers may rely on identity for cheap change detection). Returns
// null for invalid ids (path-traversal guard) or missing transcripts.
export function summarizeSessionFile(projectDir, id) {
  if (!SESSION_ID_RE.test(String(id))) return null
  loadDiskCache()
  const path = join(projectDir, `${id}.jsonl`)
  let st
  try { st = statSync(path) } catch { return null }
  const hit = summaryCache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary

  const parsed = parseAgentTranscript(path, { light: true, titleChars: 400 })
  if (!parsed) return null
  const sessDir = join(projectDir, id)
  const hasDir = existsSync(sessDir)
  const u = parsed.totalUsage
  const startMs = parsed.firstTimestamp ? (Date.parse(parsed.firstTimestamp) || 0) : 0
  const endMs = parsed.lastTimestamp ? (Date.parse(parsed.lastTimestamp) || 0) : 0
  const summary = {
    id,
    title: trunc(cleanTitle(parsed.task), 140) || null,
    startedAt: parsed.firstTimestamp || null,
    endedAt: parsed.lastTimestamp || null,
    ms: endMs > startMs ? endMs - startMs : 0,
    turns: parsed.assistantTurns || 0,
    toolCalls: parsed.toolCalls || 0,
    tokens: {
      in: u.input_tokens, out: u.output_tokens,
      cacheWr: u.cache_creation_input_tokens, cacheRd: u.cache_read_input_tokens,
    },
    costUsd: +costOfUsage(u, parsed.model).toFixed(6),
    model: parsed.model || null,
    tier: tierFromModel(parsed.model),
    cwd: parsed.cwd || null,
    gitBranch: parsed.gitBranch || null,
    workflows: hasDir ? countDir(join(sessDir, 'workflows'), /^wf_.*\.json$/) : 0,
    subagents: hasDir ? countDir(join(sessDir, 'subagents'), /^agent-[0-9a-f]+\.meta\.json$/) : 0,
    hasDir,
    sizeBytes: st.size,
    mtimeMs: st.mtimeMs,
  }
  summaryCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, summary })
  if (++unsavedSummaries >= 200) saveDiskCache() // checkpoint long scans
  return summary
}

// Every session on the machine, newest-first, with its folder attached. Cheap once
// the aggregate scan has warmed the disk cache (summaries are mtime-cached).
export function listAllSessions(projectsRoot, { limit = 2000 } = {}) {
  const rows = []
  for (const p of listProjects(projectsRoot)) {
    let files = []
    try { files = readdirSync(p.dir).filter((f) => SESSION_FILE_RE.test(f)) } catch { /* unreadable */ }
    for (const f of files) {
      const s = summarizeSessionFile(p.dir, f.replace(/\.jsonl$/, ''))
      if (s) rows.push({ ...s, projectSlug: p.slug, projectCwd: p.cwd })
    }
  }
  rows.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
  return { total: rows.length, sessions: rows.slice(0, Math.max(1, limit)) }
}

// ── Machine-wide aggregation (incremental, disk-cached) ───────────────────────
// Scans EVERY session in EVERY folder, but only up to `budgetMs` per call — callers
// poll until `done`. Summaries are mtime-cached (memory + disk), so the first scan
// pays the parse cost once and later calls are effectively instant.
let aggState = null
export function resetAggregateScan() { aggState = null }
function repoOfCwd(cwd) {
  const m = String(cwd || '').match(/\/conductor\/workspaces\/([^/]+)\/[^/]+\/?$/)
  if (m) return m[1] + ' (worktrees)'
  return String(cwd || '').split('/').filter(Boolean).pop() || String(cwd || 'unknown')
}
export function aggregateMachine(projectsRoot, { budgetMs = 1500 } = {}) {
  if (!aggState || aggState.root !== projectsRoot) {
    const queue = []
    for (const p of listProjects(projectsRoot)) {
      let files = []
      try { files = readdirSync(p.dir).filter((f) => SESSION_FILE_RE.test(f)) } catch { /* unreadable */ }
      for (const f of files) queue.push({ dir: p.dir, id: f.replace(/\.jsonl$/, ''), cwd: p.cwd || p.slug })
    }
    aggState = {
      root: projectsRoot, queue, idx: 0,
      totals: { sessions: 0, costUsd: 0, tokens: { in: 0, out: 0, cacheRd: 0, cacheWr: 0 }, folders: new Set() },
      byDay: new Map(), byRepo: new Map(), byTier: new Map(),
    }
  }
  const s = aggState
  const t0 = Date.now()
  while (s.idx < s.queue.length && Date.now() - t0 < budgetMs) {
    const item = s.queue[s.idx++]
    const sum = summarizeSessionFile(item.dir, item.id)
    if (!sum) continue
    s.totals.sessions++
    s.totals.costUsd += sum.costUsd || 0
    s.totals.tokens.in += sum.tokens?.in || 0
    s.totals.tokens.out += sum.tokens?.out || 0
    s.totals.tokens.cacheRd += sum.tokens?.cacheRd || 0
    s.totals.tokens.cacheWr += sum.tokens?.cacheWr || 0
    s.totals.folders.add(item.dir)
    const tier = sum.tier || 'other'
    const ms = sum.startedAt ? Date.parse(sum.startedAt) : sum.mtimeMs
    if (ms) {
      const d = new Date(ms); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const b = s.byDay.get(day) || { day, costUsd: 0, sessions: 0, tiers: {} }
      b.costUsd += sum.costUsd || 0; b.sessions++
      b.tiers[tier] = (b.tiers[tier] || 0) + (sum.costUsd || 0)
      s.byDay.set(day, b)
    }
    const repo = repoOfCwd(sum.cwd || item.cwd)
    const r = s.byRepo.get(repo) || { repo, costUsd: 0, sessions: 0, tiers: {} }
    r.costUsd += sum.costUsd || 0; r.sessions++
    r.tiers[tier] = (r.tiers[tier] || 0) + (sum.costUsd || 0)
    s.byRepo.set(repo, r)
    s.byTier.set(tier, (s.byTier.get(tier) || 0) + (sum.costUsd || 0))
  }
  const done = s.idx >= s.queue.length
  if (done && unsavedSummaries > 0) saveDiskCache()
  const round = (x) => +x.toFixed(6)
  return {
    done,
    progress: { scannedSessions: s.idx, totalSessions: s.queue.length },
    totals: { sessions: s.totals.sessions, folders: s.totals.folders.size, costUsd: round(s.totals.costUsd), tokens: { ...s.totals.tokens } },
    byDay: [...s.byDay.values()].sort((a, b) => a.day < b.day ? -1 : 1).map((d) => ({ ...d, costUsd: round(d.costUsd) })),
    byRepo: [...s.byRepo.values()].sort((a, b) => b.costUsd - a.costUsd).map((r) => ({ ...r, costUsd: round(r.costUsd) })),
    byTier: [...s.byTier.entries()].map(([tier, costUsd]) => ({ tier, costUsd: round(costUsd) })).sort((a, b) => b.costUsd - a.costUsd),
  }
}

// Read a transcript's `cwd` field cheaply: scan only the first few lines — every harness
// entry carries cwd, so the first parseable line usually has it. Never loads big files.
function cwdFromTranscriptHead(path, maxBytes = 64 * 1024) {
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    closeSync(fd)
    for (const line of buf.toString('utf8', 0, n).split('\n').slice(0, 20)) {
      try { const j = JSON.parse(line); if (j && j.cwd) return j.cwd } catch { /* partial/invalid line */ }
    }
  } catch { /* unreadable */ }
  return null
}

const projectCwdCache = new Map() // projectDir -> { newestMtimeMs, cwd }

// Enumerate every Claude project dir under the projects root (~/.claude/projects),
// newest-activity-first, with the REAL working directory recovered from the newest
// transcript (the slug is lossy — hyphenated dir names can't be decoded from it).
export function listProjects(projectsRoot) {
  if (!projectsRoot || !existsSync(projectsRoot)) return []
  let entries
  try { entries = readdirSync(projectsRoot, { withFileTypes: true }) } catch { return [] }
  const projects = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(projectsRoot, e.name)
    let files = []
    try { files = readdirSync(dir).filter((f) => SESSION_FILE_RE.test(f)) } catch { /* unreadable */ }
    const stats = []
    for (const f of files) {
      try { stats.push({ path: join(dir, f), mtimeMs: statSync(join(dir, f)).mtimeMs }) } catch { /* vanished */ }
    }
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const newestMtimeMs = stats[0]?.mtimeMs || 0
    let cwd = null
    if (stats.length) {
      const hit = projectCwdCache.get(dir)
      if (hit && hit.newestMtimeMs === newestMtimeMs) { cwd = hit.cwd }
      else {
        // Newest transcript may be an empty stub with no cwd line — probe a few.
        for (const s of stats.slice(0, 4)) { cwd = cwdFromTranscriptHead(s.path); if (cwd) break }
        projectCwdCache.set(dir, { newestMtimeMs, cwd })
      }
    }
    projects.push({ slug: e.name, dir, cwd, sessionCount: files.length, lastActivityMs: newestMtimeMs || null })
  }
  projects.sort((a, b) => (b.lastActivityMs || 0) - (a.lastActivityMs || 0))
  return projects
}

// Home dashboard data: the full folder list (picker), recent sessions ACROSS the most
// recently active folders, live-now sessions, and per-folder spend rollups. Work is
// BOUNDED (top `folders` folders × newest `perFolder` sessions each; mtime-cached), so
// the home never scans a whole multi-GB history — rollups say how many sessions they
// cover (`coverage`) instead of pretending to be all-time totals.
export function buildHomeData(projectsRoot, { folders = 8, perFolder = 10, recents = 12 } = {}) {
  const projects = listProjects(projectsRoot)
  const active = projects.filter((p) => p.sessionCount > 0).slice(0, folders)
  const all = []
  const folderTotals = []
  for (const p of active) {
    const scan = scanProjectSessions(p.dir, { limit: perFolder })
    let cost = 0
    for (const s of scan.sessions) { cost += s.costUsd || 0; all.push({ ...s, projectSlug: p.slug, projectCwd: p.cwd }) }
    folderTotals.push({ slug: p.slug, cwd: p.cwd, costUsd: +cost.toFixed(6), sessions: scan.totalSessions, coverage: scan.sessions.length, lastActivityMs: p.lastActivityMs })
  }
  all.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
  const now = Date.now()
  return {
    projects,
    recents: all.slice(0, recents),
    live: all.filter((s) => now - (s.mtimeMs || 0) < 120000),
    folderTotals,
  }
}

// List every session in the project dir, newest-first by transcript mtime.
// `limit` caps how many are SUMMARIZED (big transcripts parse once then cache);
// totalSessions reports how many exist beyond the cap.
export function scanProjectSessions(projectDir, { limit = 40 } = {}) {
  const empty = { projectDir: projectDir || null, totalSessions: 0, sessions: [] }
  if (!projectDir || !existsSync(projectDir)) return empty
  let files
  try { files = readdirSync(projectDir) } catch { return empty }
  const candidates = []
  for (const f of files) {
    const m = f.match(SESSION_FILE_RE)
    if (!m) continue
    try { candidates.push({ id: m[1], mtimeMs: statSync(join(projectDir, f)).mtimeMs }) } catch { /* vanished mid-scan */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const sessions = []
  for (const c of candidates.slice(0, Math.max(1, limit))) {
    const s = summarizeSessionFile(projectDir, c.id)
    if (s) sessions.push(s)
  }
  return { projectDir, totalSessions: candidates.length, sessions }
}
