#!/usr/bin/env node
// scripts/hooks/session-start.mjs — Claude Code SessionStart hook (wired in
// hooks/hooks.json, matcher ["startup","resume","clear"]).
//
// The Control Tower dashboard is a MACHINE-WIDE singleton (it already browses every
// session on the machine, not just the one that launched it — see src/sessions.mjs).
// This hook reuses an already-running, healthy instance if one exists; otherwise it
// starts one (same ensureDeps/pickFreePort/resolveSessionDir steps as the manual
// `/caliper` command, factored into src/launch-support.mjs so both share one
// implementation). Either way it registers this session as a lock holder — see
// session-end.mjs, which only kills the server once no session still holds a lock —
// and reports the dashboard URL (+ last session's recap, if any) via `systemMessage`,
// the one JSON field guaranteed to show up as a message to the user.
//
// Set CALIPER_DISABLE_HOOKS=1 to make this (and the other two hooks) fully inert.
//
// Never lets an internal failure surface to the user: a bug in a "hey, here's your
// dashboard" nicety must not show up as a Claude Code hook error, so every failure
// path falls back to a silent, empty exit 0.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import {
  defaultCacheRoot, readServerState, writeServerState, isPidAlive, checkHealth,
  addSessionLock, readLastSession, formatSessionStartMessage,
} from '../../packages/control-tower/src/hook-support.mjs'
import { pickFreePort, ensureDeps, resolveSessionDir } from '../../packages/control-tower/src/launch-support.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url)) // .../scripts/hooks
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..', '..')
const LENS_DIR = join(ROOT, 'packages', 'workflow-lens')
const CT_DIR = join(ROOT, 'packages', 'control-tower')

function readStdin() {
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

async function waitForHealth(port, { attempts = 15, delayMs = 300 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await checkHealth(port)) return true
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return false
}

async function main() {
  if (process.env.CALIPER_DISABLE_HOOKS) return

  let input = {}
  try { input = JSON.parse(readStdin() || '{}') } catch { input = {} }
  const sessionId = input.session_id
  const cwd = input.cwd || process.cwd()

  const root = defaultCacheRoot()
  const state = readServerState(root)
  const reusable = Boolean(state?.pid && isPidAlive(state.pid) && state?.port && await checkHealth(state.port))
  let port = reusable ? state.port : null

  if (!reusable) {
    // stdio: 'ignore' on BOTH steps below — a hook's stdout must contain only the
    // final JSON line; 'inherit' (the manual-launcher default) would splice npm/server
    // chatter into that same stream and break JSON parsing.
    ensureDeps(LENS_DIR, 'workflow-lens', { stdio: 'ignore' })
    ensureDeps(CT_DIR, 'control-tower', { stdio: 'ignore' })
    const sessionDir = resolveSessionDir({
      explicit: process.env.WFLENS_SESSION_DIR || null,
      projectsRoot: join(homedir(), '.claude', 'projects'),
      cwd,
    })
    port = await pickFreePort()
    const env = { ...process.env, PORT: String(port) }
    if (sessionDir) env.WFLENS_SESSION_DIR = sessionDir
    const child = spawn('node', ['server.mjs'], { cwd: CT_DIR, env, stdio: 'ignore', detached: true })
    child.unref() // survive after THIS short-lived hook process exits
    writeServerState(root, { pid: child.pid, port, startedAt: new Date().toISOString() })
    await waitForHealth(port)
  }

  if (sessionId) addSessionLock(root, sessionId)

  const lastSession = readLastSession(root)
  const dashboardUrl = `http://localhost:${port}`
  const systemMessage = formatSessionStartMessage(dashboardUrl, lastSession)
  process.stdout.write(JSON.stringify({ systemMessage }))
}

main().then(() => process.exit(0)).catch(() => process.exit(0))
