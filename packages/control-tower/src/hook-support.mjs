// src/hook-support.mjs — plumbing shared by the three Claude Code plugin hooks
// (scripts/hooks/session-start.mjs, stop.mjs, session-end.mjs; wired in
// hooks/hooks.json at the plugin root). Two independent concerns live here:
//
// 1. Recap math (computeRecap/shouldShow/format*): pure reuse of the SAME cost
//    reconstruction the dashboard already shows — summarizeSessionFile (main
//    transcript) + scanSubagentTree (subagents/workflow agents) — so the number a
//    hook prints can never drift from the number the dashboard prints for the same
//    session. No new dependency, no second cost model (see CHANGELOG 0.29.0).
//
// 2. Shared-server bookkeeping (state/lock helpers + checkHealth): the Control Tower
//    background server is a MACHINE-WIDE singleton, not one per Claude Code session
//    (it already browses every session via the Home/Sessions views). SessionStart
//    reuses it if alive, else starts one; each active session holds a "lock" file;
//    SessionEnd removes its own lock and only kills the server once no locks remain,
//    so one session ending never yanks the dashboard out from under another
//    still-active concurrent session.
//
// All state/lock functions take an explicit `root` directory rather than reading
// homedir() themselves — callers pass defaultCacheRoot() in production and a fresh
// mkdtemp per test, so tests never share global state and never touch the real
// ~/.cache/workflow-lens. (computeRecap's transitive call into sessions.mjs still
// uses that module's own homedir()-derived disk cache — tests sandbox HOME for that,
// same as every other test file that touches src/sessions.mjs; see AGENTS.md rule 5.)

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import http from 'node:http'
import { summarizeSessionFile } from './sessions.mjs'
import { scanSubagentTree } from './subagents.mjs'

export function defaultCacheRoot() {
  return join(homedir() || tmpdir(), '.cache', 'workflow-lens')
}

// ── recap math ────────────────────────────────────────────────────────────────
// Total session spend = main transcript cost (summarizeSessionFile) + every
// subagent/workflow-agent under it (scanSubagentTree's rollup) — summarizeSessionFile
// alone only covers the main transcript, per its own costUsd comment.
export function computeRecap(projectDir, sessionId) {
  const main = summarizeSessionFile(projectDir, sessionId)
  if (!main) return { costUsd: 0, agentTypeCounts: {}, turns: 0 }
  const { rollup } = scanSubagentTree(join(projectDir, sessionId))
  const costUsd = +((main.costUsd || 0) + (rollup?.totalCostUsd || 0)).toFixed(6)
  return { costUsd, agentTypeCounts: { ...(rollup?.agentTypeCounts || {}) }, turns: main.turns || 0 }
}

// Throttle: only re-show the reminder once spend has grown by >= thresholdUsd since
// it was last shown. Missing/null lastShownCostUsd is treated as 0 (never shown yet).
export function shouldShow(currentCostUsd, lastShownCostUsd, thresholdUsd) {
  const last = lastShownCostUsd || 0
  return (currentCostUsd - last) >= thresholdUsd
}

export function formatAgentCounts(agentTypeCounts) {
  const entries = Object.entries(agentTypeCounts || {})
  if (!entries.length) return null
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return entries.map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join(', ')
}

export function formatReminder({ costUsd, agentTypeCounts }, dashboardUrl) {
  let line = `💰 Session spend: $${(costUsd || 0).toFixed(4)}`
  const agents = formatAgentCounts(agentTypeCounts)
  if (agents) line += ` · agents: ${agents}`
  if (dashboardUrl) line += ` · dashboard: ${dashboardUrl}`
  return line
}

export function formatSessionStartMessage(dashboardUrl, lastSession) {
  const parts = []
  if (lastSession && (lastSession.costUsd || 0) > 0) {
    const agents = formatAgentCounts(lastSession.agentTypeCounts)
    parts.push(`Last session: $${lastSession.costUsd.toFixed(4)}${agents ? ` · ${agents}` : ''}.`)
  }
  parts.push(`📊 Caliper dashboard: ${dashboardUrl} — monitor spend anytime this session.`)
  return parts.join(' ')
}

// ── server state (machine-wide singleton) ───────────────────────────────────────
const serverStateFile = (root) => join(root, 'hook-server.json')

export function readServerState(root) {
  try { return JSON.parse(readFileSync(serverStateFile(root), 'utf8')) } catch { return null }
}
export function writeServerState(root, state) {
  mkdirSync(root, { recursive: true })
  writeFileSync(serverStateFile(root), JSON.stringify(state))
}
export function clearServerState(root) {
  try { unlinkSync(serverStateFile(root)) } catch { /* already gone */ }
}

export function isPidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// ── session locks (reference count for the shared server) ──────────────────────
const locksDir = (root) => join(root, 'hook-locks')

export function addSessionLock(root, sessionId) {
  mkdirSync(locksDir(root), { recursive: true })
  writeFileSync(join(locksDir(root), sessionId), '')
}
export function removeSessionLock(root, sessionId) {
  try { unlinkSync(join(locksDir(root), sessionId)) } catch { /* never held one */ }
}
export function hasAnyLocks(root) {
  try { return readdirSync(locksDir(root)).length > 0 } catch { return false }
}

// ── per-session recap state + last-session handoff ──────────────────────────────
const stateDir = (root) => join(root, 'hook-state')
const sessionStateFile = (root, sessionId) => join(stateDir(root), `${sessionId}.json`)
const lastSessionFile = (root) => join(stateDir(root), 'last-session.json')

export function readSessionState(root, sessionId) {
  try { return JSON.parse(readFileSync(sessionStateFile(root, sessionId), 'utf8')) } catch { return null }
}
export function writeSessionState(root, sessionId, data) {
  mkdirSync(stateDir(root), { recursive: true })
  writeFileSync(sessionStateFile(root, sessionId), JSON.stringify(data))
}
export function readLastSession(root) {
  try { return JSON.parse(readFileSync(lastSessionFile(root), 'utf8')) } catch { return null }
}
// Copies the already-computed per-session state (written by the Stop hook) into the
// single "last session" slot for the NEXT SessionStart to read — no re-parsing, so
// SessionEnd stays well inside its tight 1.5s default timeout. Returns false (no-op)
// when the session never had any recorded state (e.g. it ended before any Stop fired).
export function writeLastSessionFrom(root, sessionId) {
  const state = readSessionState(root, sessionId)
  if (!state) return false
  mkdirSync(stateDir(root), { recursive: true })
  writeFileSync(lastSessionFile(root), JSON.stringify(state))
  return true
}

// ── liveness probe (real network, short timeout) ────────────────────────────────
export function checkHealth(port, { timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/v1/health', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 300)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}
