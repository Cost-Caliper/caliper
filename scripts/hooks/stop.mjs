#!/usr/bin/env node
// scripts/hooks/stop.mjs — Claude Code Stop hook (wired in hooks/hooks.json, no
// matcher — Stop fires after every assistant turn, not just "end of session").
//
// Computes running session spend + agent-type tally directly from the transcript
// (computeRecap — no server dependency, no npm install needed: see hook-support.mjs's
// header for why that import chain has zero external deps). Always persists the
// latest recap for session-end.mjs to hand off as "last session" — cheap, since it's
// the same computation the throttle check needs anyway. Only PRINTS the visible
// reminder once spend has grown by CALIPER_REMINDER_THRESHOLD_USD (default $0.05)
// since it was last shown.
//
// Deliberately sets ONLY `systemMessage` — never `decision` or
// `hookSpecificOutput.additionalContext`, both of which force Claude to keep
// responding on a Stop hook. A cost reminder that itself spent more tokens to show
// itself would be a bad joke for a cost-visibility tool.
//
// Set CALIPER_DISABLE_HOOKS=1 to make this (and the other two hooks) fully inert.

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  defaultCacheRoot, computeRecap, shouldShow, formatReminder,
  readSessionState, writeSessionState, readServerState,
} from '../../packages/control-tower/src/hook-support.mjs'

function readStdin() {
  try { return readFileSync(0, 'utf8') } catch { return '' }
}

function main() {
  if (process.env.CALIPER_DISABLE_HOOKS) return

  let input = {}
  try { input = JSON.parse(readStdin() || '{}') } catch { input = {} }
  const transcriptPath = input.transcript_path
  const sessionId = input.session_id
  if (!transcriptPath || !sessionId) return

  const projectDir = dirname(transcriptPath)
  const recap = computeRecap(projectDir, sessionId)

  const root = defaultCacheRoot()
  const prior = readSessionState(root, sessionId)
  const lastShownCostUsd = prior?.lastShownCostUsd || 0
  const threshold = Number(process.env.CALIPER_REMINDER_THRESHOLD_USD) || 0.05
  const show = shouldShow(recap.costUsd, lastShownCostUsd, threshold)

  writeSessionState(root, sessionId, {
    ...recap,
    lastShownCostUsd: show ? recap.costUsd : lastShownCostUsd,
  })

  if (!show) return

  const server = readServerState(root)
  const dashboardUrl = server?.port ? `http://localhost:${server.port}` : null
  process.stdout.write(JSON.stringify({ systemMessage: formatReminder(recap, dashboardUrl) }))
}

try { main() } catch { /* never let a cosmetic reminder break the session */ }
process.exit(0)
