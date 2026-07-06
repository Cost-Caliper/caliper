#!/usr/bin/env node
// scripts/hooks/session-end.mjs — Claude Code SessionEnd hook (wired in
// hooks/hooks.json, no matcher — cleanup regardless of exit reason).
//
// SessionEnd has NO decision control and cannot show the user anything (its default
// timeout is a tight 1.5s) — it exists purely for cleanup. This hook: hands off this
// session's already-computed recap (written by stop.mjs — no re-parsing here, so this
// stays well inside the 1.5s budget) as the "last session" slot for the next
// SessionStart to show; removes this session's lock on the shared Control Tower
// server; and — only once NO session still holds a lock — kills the server so it
// never leaks as an orphaned background process. A still-active concurrent Claude
// Code session never gets its dashboard yanked out from under it.
//
// Set CALIPER_DISABLE_HOOKS=1 to make this (and the other two hooks) fully inert.

import { readFileSync } from 'node:fs'
import {
  defaultCacheRoot, removeSessionLock, hasAnyLocks, readServerState, clearServerState,
  writeLastSessionFrom,
} from '../../packages/control-tower/src/hook-support.mjs'

function readStdin() {
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

function main() {
  if (process.env.CALIPER_DISABLE_HOOKS) return

  let input = {}
  try { input = JSON.parse(readStdin() || '{}') } catch { input = {} }
  const sessionId = input.session_id
  const root = defaultCacheRoot()

  if (sessionId) {
    writeLastSessionFrom(root, sessionId)
    removeSessionLock(root, sessionId)
  }

  if (!hasAnyLocks(root)) {
    const state = readServerState(root)
    if (state?.pid) {
      try { process.kill(state.pid, 'SIGTERM') } catch { /* already gone */ }
    }
    clearServerState(root)
  }
}

try { main() } catch { /* cleanup best-effort; never block session termination */ }
process.exit(0)
