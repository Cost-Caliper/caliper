#!/usr/bin/env node
// launch-control-tower.mjs — resolve a Claude Code session dir, ensure deps, and
// start the Control Tower dashboard pointed at it (so the "Observe (native)" tab
// shows the real workflow runs from that session).
//
// Usage:
//   node scripts/launch-control-tower.mjs [--session-dir <path>] [--port <n>]
//
// Port: by default a RANDOM free high port (40000–59999) is chosen so the dashboard
// never collides with the common dev ports builders use (3000/5173/8080/8787/…).
// Pass --port <n> or set PORT to pin a specific port. The chosen URL is always
// printed as: "[launch] starting Control Tower on http://localhost:<port>".
//
// Session-dir resolution order:
//   1. --session-dir <path>
//   2. $WFLENS_SESSION_DIR
//   3. auto-discover: newest session under ~/.claude/projects/<slug-of-cwd>/ that
//      has workflow artifacts; else newest such session across all projects.
//   (If none is found, the server still starts — the Control/Replay tab works
//    without a session dir; only the native-observe tab needs one.)

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// CLAUDE_PLUGIN_ROOT is set when launched as a plugin command; fall back to repo root.
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..')
const LENS_DIR = join(ROOT, 'packages', 'workflow-lens')
const CT_DIR = join(ROOT, 'packages', 'control-tower')

// ── arg parsing ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function flag(name) {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
// Explicit port override (--port or PORT). When absent we pick a random free high port.
const PORT_OVERRIDE = flag('--port') || process.env.PORT || null

// ── port selection ──────────────────────────────────────────────────────────────
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

// Random high port (40000–59999), probed until free, so the dashboard never
// collides with the common dev ports builders run (3000/5173/8080/8787/…).
async function pickFreePort() {
  for (let i = 0; i < 50; i++) {
    const port = 40000 + Math.floor(Math.random() * 20000)
    if (await probePort(port)) return port
  }
  return 0 // last resort: let the OS assign an ephemeral port
}

// ── dependency bootstrap ────────────────────────────────────────────────────────
function ensureDeps(dir, label) {
  if (existsSync(join(dir, 'node_modules'))) return
  console.error(`[launch] installing deps for ${label} …`)
  // --ignore-scripts: never run third-party install hooks on the user's machine.
  // npm ci needs a lockfile in sync with package.json; fall back to install otherwise.
  const flags = ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']
  let r = spawnSync('npm', ['ci', ...flags], { cwd: dir, stdio: 'inherit' })
  if (r.status !== 0) r = spawnSync('npm', ['install', ...flags], { cwd: dir, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`[launch] npm install failed for ${label}`)
    process.exit(1)
  }
}

// ── session-dir discovery ─────────────────────────────────────────────────────
function hasWorkflowRuns(sessionDir) {
  const wfDir = join(sessionDir, 'workflows')
  try {
    return readdirSync(wfDir).some((f) => /^wf_[0-9a-f-]+\.json$/.test(f))
  } catch {
    return false
  }
}

function newestSessionWithRuns(projectDir) {
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

function slugForCwd() {
  // Claude Code encodes the project path by replacing '/' with '-'.
  return process.cwd().replace(/\//g, '-')
}

function discoverSessionDir() {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  if (!existsSync(projectsRoot)) return null

  // 1. Prefer the project matching the current working directory.
  const cwdProject = join(projectsRoot, slugForCwd())
  const fromCwd = newestSessionWithRuns(cwdProject)
  if (fromCwd) return fromCwd

  // 2. Fall back to the newest run-bearing session across all projects.
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

function resolveSessionDir() {
  const explicit = flag('--session-dir') || process.env.WFLENS_SESSION_DIR
  if (explicit) {
    if (!existsSync(explicit)) {
      console.error(`[launch] WARNING: session dir not found: ${explicit}`)
    }
    return explicit
  }
  return discoverSessionDir()
}

// ── main ──────────────────────────────────────────────────────────────────────
ensureDeps(LENS_DIR, 'workflow-lens')
ensureDeps(CT_DIR, 'control-tower')

const sessionDir = resolveSessionDir()
if (sessionDir) {
  console.error(`[launch] observing session dir: ${sessionDir}`)
} else {
  console.error('[launch] no session dir found — Observe tab disabled; Control/Replay tab still works')
}

const PORT = PORT_OVERRIDE || String(await pickFreePort())
const env = { ...process.env, PORT }
if (sessionDir) env.WFLENS_SESSION_DIR = sessionDir

console.error(`[launch] starting Control Tower on http://localhost:${PORT}`)
const child = spawn('node', ['server.mjs'], { cwd: CT_DIR, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
