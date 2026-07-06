// src/launch-support.mjs — pure/testable pieces of launching a Control Tower server:
// free-port selection, first-run dependency install, and Claude Code session-dir
// discovery. Extracted out of scripts/launch-control-tower.mjs so the manual `/caliper`
// command and the automatic SessionStart hook (scripts/hooks/session-start.mjs) share
// ONE implementation instead of two copies that could drift.
//
// Functions here take their inputs explicitly (projectsRoot, cwd, …) rather than
// reading homedir()/process.cwd()/env themselves, so callers control production
// defaults and tests can pass an isolated mkdtemp root — no shared global state.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

// ── port selection ──────────────────────────────────────────────────────────────
export function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

// Random high port (40000–59999), probed until free, so the dashboard never collides
// with common dev ports (3000/5173/8080/8787/…).
export async function pickFreePort() {
  for (let i = 0; i < 50; i++) {
    const port = 40000 + Math.floor(Math.random() * 20000)
    if (await probePort(port)) return port
  }
  return 0 // last resort: let the OS assign an ephemeral port
}

// ── dependency bootstrap ────────────────────────────────────────────────────────
// --ignore-scripts: never run third-party install hooks on the user's machine.
// npm ci needs a lockfile in sync with package.json; fall back to install otherwise.
//
// stdio defaults to 'inherit' (the manual /caliper command wants npm's own progress
// output on the user's terminal). Hook scripts MUST override this to 'ignore' —
// Claude Code hook contract requires a hook's stdout contain ONLY its final JSON
// output, and 'inherit' would splice raw npm chatter into that same stream.
export function ensureDeps(dir, label, { stdio = 'inherit' } = {}) {
  if (existsSync(join(dir, 'node_modules'))) return
  console.error(`[launch] installing deps for ${label} …`)
  const flags = ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']
  let r = spawnSync('npm', ['ci', ...flags], { cwd: dir, stdio })
  if (r.status !== 0) r = spawnSync('npm', ['install', ...flags], { cwd: dir, stdio })
  if (r.status !== 0) {
    console.error(`[launch] npm install failed for ${label}`)
    process.exit(1)
  }
}

// ── session-dir discovery ─────────────────────────────────────────────────────
export function hasWorkflowRuns(sessionDir) {
  const wfDir = join(sessionDir, 'workflows')
  try {
    return readdirSync(wfDir).some((f) => /^wf_[0-9a-f-]+\.json$/.test(f))
  } catch {
    return false
  }
}

export function newestSessionWithRuns(projectDir) {
  let best = null
  let bestMtime = -1
  let sessions = []
  try {
    sessions = readdirSync(projectDir)
  } catch {
    return null
  }
  for (const s of sessions) {
    const sessionDir = join(projectDir, s)
    let st
    try {
      st = statSync(sessionDir)
    } catch {
      continue
    }
    if (!st.isDirectory() || !hasWorkflowRuns(sessionDir)) continue
    if (st.mtimeMs > bestMtime) {
      bestMtime = st.mtimeMs
      best = sessionDir
    }
  }
  return best
}

// Claude Code encodes the project path by replacing '/' with '-'.
export function slugForCwd(cwd) {
  return String(cwd).replace(/\//g, '-')
}

// Prefer the project matching cwd; fall back to the newest run-bearing session
// across every project under projectsRoot. Returns null if nothing qualifies.
export function discoverSessionDir(projectsRoot, cwd) {
  if (!existsSync(projectsRoot)) return null

  const cwdProject = join(projectsRoot, slugForCwd(cwd))
  const fromCwd = newestSessionWithRuns(cwdProject)
  if (fromCwd) return fromCwd

  let best = null
  let bestMtime = -1
  for (const proj of readdirSync(projectsRoot)) {
    const candidate = newestSessionWithRuns(join(projectsRoot, proj))
    if (!candidate) continue
    const m = statSync(candidate).mtimeMs
    if (m > bestMtime) {
      bestMtime = m
      best = candidate
    }
  }
  return best
}

// explicit: an already-resolved override (from --session-dir or $WFLENS_SESSION_DIR);
// when absent, falls through to discoverSessionDir(projectsRoot, cwd).
export function resolveSessionDir({ explicit, projectsRoot, cwd }) {
  if (explicit) {
    if (!existsSync(explicit)) {
      console.error(`[launch] WARNING: session dir not found: ${explicit}`)
    }
    return explicit
  }
  return discoverSessionDir(projectsRoot, cwd)
}
