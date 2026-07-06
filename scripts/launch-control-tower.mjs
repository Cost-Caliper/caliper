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
//
// The reusable pieces (port picking, dep install, session-dir discovery) live in
// packages/control-tower/src/launch-support.mjs, shared with the automatic
// SessionStart hook (scripts/hooks/session-start.mjs) so there's one implementation.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pickFreePort, ensureDeps, resolveSessionDir } from '../packages/control-tower/src/launch-support.mjs'

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

// ── main ──────────────────────────────────────────────────────────────────────
ensureDeps(LENS_DIR, 'workflow-lens')
ensureDeps(CT_DIR, 'control-tower')

const sessionDir = resolveSessionDir({
  explicit: flag('--session-dir') || process.env.WFLENS_SESSION_DIR,
  projectsRoot: join(homedir(), '.claude', 'projects'),
  cwd: process.cwd(),
})
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
