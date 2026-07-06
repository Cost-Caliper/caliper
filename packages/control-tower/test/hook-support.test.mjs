// test/hook-support.test.mjs — src/hook-support.mjs: the Claude Code hook plumbing
// behind the SessionStart/Stop/SessionEnd plugin hooks (see hooks/hooks.json at the
// plugin root and scripts/hooks/*.mjs).
//
// computeRecap() transitively calls summarizeSessionFile() (src/sessions.mjs), which
// reads/writes a disk cache keyed off homedir() at module-load time — per AGENTS.md
// rule 5, this file sandboxes HOME by importing test/_env.mjs FIRST, exactly like every
// other test that touches sessions.mjs (see test/sessions-cache.test.mjs).
//
// The server-state/lock/session-state helpers take an explicit `root` directory (never
// homedir()) precisely so these tests can run fully isolated per-test with no shared
// global state and no risk of touching the real ~/.cache/workflow-lens.

import './_env.mjs' // FIRST: sandbox HOME (computeRecap -> summarizeSessionFile's disk cache)
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import {
  computeRecap, shouldShow, formatAgentCounts, formatReminder, formatSessionStartMessage,
  readServerState, writeServerState, clearServerState, isPidAlive,
  addSessionLock, removeSessionLock, hasAnyLocks,
  readSessionState, writeSessionState, readLastSession, writeLastSessionFrom,
  checkHealth, defaultCacheRoot,
} from '../src/hook-support.mjs'
import { summarizeSessionFile } from '../src/sessions.mjs'
import { scanSubagentTree } from '../src/subagents.mjs'

// ── fixture: one project dir with a MAIN transcript + one subagent ───────────────
// Real wire shapes copied from test/sessions.test.mjs / test/subagents.test.mjs.
function ts(sec) { return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString() }
function assistant(tArr, content, model = 'claude-sonnet-4-6') {
  return JSON.stringify({ type: 'assistant', timestamp: tArr, cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', model, usage: { input_tokens: 1000, output_tokens: 200 }, content } })
}
function user(tArr, content) {
  return JSON.stringify({ type: 'user', timestamp: tArr, message: { role: 'user', content } })
}
function spawnBlock(id, desc) { return { type: 'tool_use', id, name: 'Agent', input: { description: desc, model: 'claude-haiku-4-5' } } }

const ID = '12345678-9abc-4def-8123-456789abcdef'

function makeProject() {
  const projectDir = mkdtempSync(join(tmpdir(), 'ct-hooksupport-'))
  const sessDir = join(projectDir, ID)
  mkdirSync(join(sessDir, 'subagents'), { recursive: true })

  writeFileSync(join(projectDir, `${ID}.jsonl`), [
    user(ts(0), [{ type: 'text', text: 'go do things' }]),
    assistant(ts(1), [{ type: 'text', text: 'spawning' }, spawnBlock('tA', 'explore the repo')]),
  ].join('\n'))

  const aId = 'aaaa1111'
  writeFileSync(join(sessDir, 'subagents', `agent-${aId}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'explore the repo', toolUseId: 'tA' }))
  writeFileSync(join(sessDir, 'subagents', `agent-${aId}.jsonl`), [
    user(ts(2), [{ type: 'text', text: 'find the thing' }]),
    assistant(ts(4), [{ type: 'text', text: 'found it' }]),
  ].join('\n'))

  return projectDir
}

// ── computeRecap ──────────────────────────────────────────────────────────────
test('computeRecap: sums main + subagent cost, and counts agent types (excludes MAIN)', () => {
  const projectDir = makeProject()
  try {
    const recap = computeRecap(projectDir, ID)
    assert.ok(recap.costUsd > 0, 'total cost must include main + subagent spend')
    assert.deepEqual(recap.agentTypeCounts, { Explore: 1 })
    assert.ok(recap.turns >= 1)
  } finally { rmSync(projectDir, { recursive: true, force: true }) }
})

// MUTATION-PROVED: dropped the `+ (rollup?.totalCostUsd || 0)` term (main-only cost) ->
// RED: recap.costUsd was smaller than main.costUsd + sub cost, failing the strict-sum
// assertion below. Restored -> GREEN.
test('computeRecap: total cost strictly equals main.costUsd + subagent rollup.totalCostUsd', () => {
  const projectDir = makeProject()
  try {
    const recap = computeRecap(projectDir, ID)
    // Re-derive independently via the underlying modules to prove the sum, not just "> 0".
    const main = summarizeSessionFile(projectDir, ID)
    const { rollup } = scanSubagentTree(join(projectDir, ID))
    const expected = +((main.costUsd || 0) + (rollup.totalCostUsd || 0)).toFixed(6)
    assert.equal(recap.costUsd, expected)
  } finally { rmSync(projectDir, { recursive: true, force: true }) }
})

test('computeRecap: unknown session id returns a zeroed recap, never throws', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'ct-hooksupport-empty-'))
  try {
    const recap = computeRecap(projectDir, '00000000-0000-4000-8000-000000000000')
    assert.deepEqual(recap, { costUsd: 0, agentTypeCounts: {}, turns: 0 })
  } finally { rmSync(projectDir, { recursive: true, force: true }) }
})

// ── shouldShow (pure throttle) ─────────────────────────────────────────────────
// MUTATION-PROVED: flipped `>=` to `>` in shouldShow -> RED on exactly this test's
// boundary-equality case ("0.05, 0, 0.05" expected true, got false); all other
// shouldShow tests stayed green (targeted kill). Restored -> GREEN.
test('shouldShow: true once the delta since last-shown reaches the threshold', () => {
  assert.equal(shouldShow(0.10, 0, 0.05), true)
  assert.equal(shouldShow(0.04, 0, 0.05), false)
  assert.equal(shouldShow(0.05, 0, 0.05), true) // boundary: exactly the threshold counts
})
test('shouldShow: treats missing/null lastShown as 0', () => {
  assert.equal(shouldShow(0.06, null, 0.05), true)
  assert.equal(shouldShow(0.06, undefined, 0.05), true)
})
test('shouldShow: never shows on a non-positive delta (cost cannot regress)', () => {
  assert.equal(shouldShow(0.10, 0.12, 0.05), false) // would-be negative delta
  assert.equal(shouldShow(0.10, 0.10, 0.05), false) // zero delta, below threshold
})

// ── formatting (pure) ──────────────────────────────────────────────────────────
test('formatAgentCounts: sorts by count desc, suffixes ×N only when N > 1, null when empty', () => {
  assert.equal(formatAgentCounts({}), null)
  assert.equal(formatAgentCounts({ Explore: 1 }), 'Explore')
  assert.equal(formatAgentCounts({ Explore: 2, 'code-reviewer': 3 }), 'code-reviewer×3, Explore×2')
})
test('formatReminder: includes cost, agents (when present), and the dashboard URL', () => {
  const withAgents = formatReminder({ costUsd: 0.1234, agentTypeCounts: { Explore: 2 } }, 'http://localhost:41000')
  assert.match(withAgents, /\$0\.1234/)
  assert.match(withAgents, /Explore×2/)
  assert.match(withAgents, /http:\/\/localhost:41000/)
  const noAgents = formatReminder({ costUsd: 0.02, agentTypeCounts: {} }, 'http://localhost:41000')
  assert.doesNotMatch(noAgents, /agents:/)
})
test('formatSessionStartMessage: dashboard-only when no last session, includes recap when present', () => {
  const bare = formatSessionStartMessage('http://localhost:41000', null)
  assert.match(bare, /http:\/\/localhost:41000/)
  assert.doesNotMatch(bare, /Last session/)
  const withLast = formatSessionStartMessage('http://localhost:41000', { costUsd: 0.42, agentTypeCounts: { Explore: 3 } })
  assert.match(withLast, /Last session/)
  assert.match(withLast, /\$0\.4200/)
  assert.match(withLast, /Explore×3/)
})

// ── server-state (explicit root, no shared global state across tests) ────────────
test('server state: read is null before any write, round-trips after write, gone after clear', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-hooksupport-state-'))
  try {
    assert.equal(readServerState(root), null)
    writeServerState(root, { pid: 4242, port: 41000, startedAt: '2026-07-06T00:00:00.000Z' })
    assert.deepEqual(readServerState(root), { pid: 4242, port: 41000, startedAt: '2026-07-06T00:00:00.000Z' })
    clearServerState(root)
    assert.equal(readServerState(root), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('server state: a corrupt state file is treated as absent, not thrown', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-hooksupport-state-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'hook-server.json'), 'not [json')
    assert.equal(readServerState(root), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── isPidAlive (real process boundary, no mocking) ─────────────────────────────
test('isPidAlive: true for a live child process, false once it has exited', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
  try {
    assert.equal(isPidAlive(child.pid), true)
  } finally {
    child.kill('SIGKILL')
    await new Promise((resolve) => child.on('exit', resolve))
  }
  assert.equal(isPidAlive(child.pid), false)
})
test('isPidAlive: false for pid 0 / missing pid', () => {
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive(null), false)
  assert.equal(isPidAlive(undefined), false)
})

// ── session locks (reference counting for the shared server) ───────────────────
test('locks: hasAnyLocks false when empty, true once one is added, false after the last is removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-hooksupport-locks-'))
  try {
    assert.equal(hasAnyLocks(root), false)
    addSessionLock(root, 'session-a')
    assert.equal(hasAnyLocks(root), true)
    addSessionLock(root, 'session-b')
    assert.equal(hasAnyLocks(root), true)
    removeSessionLock(root, 'session-a')
    assert.equal(hasAnyLocks(root), true, 'session-b lock still holds the server up')
    removeSessionLock(root, 'session-b')
    assert.equal(hasAnyLocks(root), false, 'server is idle once the last lock is gone')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('locks: removing a lock that was never added is a no-op, never throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-hooksupport-locks-'))
  try {
    assert.doesNotThrow(() => removeSessionLock(root, 'never-existed'))
    assert.equal(hasAnyLocks(root), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── session-state + last-session handoff ────────────────────────────────────────
test('session state + last-session: SessionEnd copies the Stop-written state without re-parsing', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-hooksupport-laststate-'))
  try {
    assert.equal(readSessionState(root, ID), null)
    writeSessionState(root, ID, { costUsd: 0.33, agentTypeCounts: { Explore: 1 }, turns: 4, lastShownCostUsd: 0.33 })
    assert.deepEqual(readSessionState(root, ID), { costUsd: 0.33, agentTypeCounts: { Explore: 1 }, turns: 4, lastShownCostUsd: 0.33 })

    assert.equal(readLastSession(root), null)
    const ok = writeLastSessionFrom(root, ID)
    assert.equal(ok, true)
    const last = readLastSession(root)
    assert.equal(last.costUsd, 0.33)
    assert.deepEqual(last.agentTypeCounts, { Explore: 1 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('last-session: copying a session with no recorded state is a no-op, leaves prior recap intact', () => {
  const root = mkdtempSync(join(tmpdir(), 'ct-hooksupport-laststate-'))
  try {
    writeSessionState(root, ID, { costUsd: 0.10, agentTypeCounts: {}, turns: 1, lastShownCostUsd: 0.10 })
    writeLastSessionFrom(root, ID)
    const before = readLastSession(root)

    const ok = writeLastSessionFrom(root, 'no-such-session')
    assert.equal(ok, false)
    assert.deepEqual(readLastSession(root), before, 'prior recap must be untouched')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── checkHealth (real HTTP, no mocking) ────────────────────────────────────────
test('checkHealth: true against a real 200 responder, false once it stops listening', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('{"ok":true}') })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  try {
    assert.equal(await checkHealth(port), true)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
  assert.equal(await checkHealth(port, { timeoutMs: 300 }), false)
})
test('checkHealth: false for a non-2xx response', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(500); res.end('nope') })
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  try {
    assert.equal(await checkHealth(port), false)
  } finally {
    await new Promise((resolve) => srv.close(resolve))
  }
})

// ── defaultCacheRoot ─────────────────────────────────────────────────────────────
test('defaultCacheRoot: lives under the (sandboxed) home cache dir', () => {
  assert.ok(String(defaultCacheRoot()).includes(join('.cache', 'workflow-lens')))
})
