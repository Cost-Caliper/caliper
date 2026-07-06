// test/hooks-cli.test.mjs — end-to-end tests of the actual hook CLI scripts
// (scripts/hooks/session-start.mjs, stop.mjs, session-end.mjs) that hooks/hooks.json
// wires up as Claude Code's SessionStart/Stop/SessionEnd hooks. Real process
// boundary throughout: these spawn the REAL scripts (as Claude Code itself would,
// piping JSON on stdin) with HOME sandboxed to a per-test tmpdir, exactly like
// test/sessions-cache.test.mjs already does for src/sessions.mjs. No mocking of the
// thing under test (AGENTS.md rule 4).
//
// session-start.mjs actually launches a real detached Control Tower server process
// when none is running — this file drives a full start -> verify-alive -> end
// lifecycle and confirms the process really exits, so cleanup is checked, not
// assumed.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPidAlive, checkHealth } from '../src/hook-support.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = join(HERE, '..', '..', '..', 'scripts', 'hooks')
const START = join(SCRIPTS, 'session-start.mjs')
const STOP = join(SCRIPTS, 'stop.mjs')
const END = join(SCRIPTS, 'session-end.mjs')

function ts(sec) { return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString() }
function assistant(tArr, content, model = 'claude-opus-4-8') {
  return JSON.stringify({ type: 'assistant', timestamp: tArr, cwd: '/repo', gitBranch: 'main', message: { role: 'assistant', model, usage: { input_tokens: 20000, output_tokens: 4000 }, content } })
}
function user(tArr, content) {
  return JSON.stringify({ type: 'user', timestamp: tArr, message: { role: 'user', content } })
}
function spawnBlock(id, desc) { return { type: 'tool_use', id, name: 'Agent', input: { description: desc, model: 'claude-haiku-4-5' } } }

const ID = '12345678-9abc-4def-8123-456789abcdef'

// One sandbox: HOME (for the hooks' own state + sessions.mjs's disk cache) + a
// project dir holding the main transcript + one subagent, big enough in tokens that
// its reconstructed cost clears the default $0.05 reminder threshold.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ct-hookscli-'))
  const home = join(root, 'home')
  const projectDir = join(root, 'proj')
  const sessDir = join(projectDir, ID)
  mkdirSync(home, { recursive: true })
  mkdirSync(join(sessDir, 'subagents'), { recursive: true })

  const jsonl = join(projectDir, `${ID}.jsonl`)
  writeFileSync(jsonl, [
    user(ts(0), [{ type: 'text', text: 'go do things' }]),
    assistant(ts(1), [{ type: 'text', text: 'spawning' }, spawnBlock('tA', 'explore the repo')]),
  ].join('\n'))

  writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'explore the repo', toolUseId: 'tA' }))
  writeFileSync(join(sessDir, 'subagents', 'agent-aaaa1111.jsonl'), [
    user(ts(2), [{ type: 'text', text: 'find the thing' }]),
    assistant(ts(4), [{ type: 'text', text: 'found it' }]),
  ].join('\n'))

  return { root, home, projectDir, jsonl }
}

function run(script, input, env = {}) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(input),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return out.trim() ? JSON.parse(out) : null
}

// ── CALIPER_DISABLE_HOOKS: every hook is fully inert ───────────────────────────
test('CALIPER_DISABLE_HOOKS=1 makes all three hooks fully silent', () => {
  const fx = setup()
  try {
    const env = { HOME: fx.home, USERPROFILE: fx.home, CALIPER_DISABLE_HOOKS: '1' }
    assert.equal(run(START, { session_id: ID, cwd: fx.projectDir }, env), null)
    assert.equal(run(STOP, { session_id: ID, transcript_path: fx.jsonl }, env), null)
    assert.equal(run(END, { session_id: ID, reason: 'other' }, env), null)
    assert.ok(!existsSync(join(fx.home, '.cache', 'workflow-lens')), 'disabled hooks must touch nothing on disk')
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})

// ── stop.mjs: throttled reminder ────────────────────────────────────────────────
test('stop.mjs: shows a reminder once cost clears the threshold, stays silent on the next identical turn', () => {
  const fx = setup()
  try {
    const env = { HOME: fx.home, USERPROFILE: fx.home, CALIPER_REMINDER_THRESHOLD_USD: '0.01' }
    const first = run(STOP, { session_id: ID, transcript_path: fx.jsonl }, env)
    assert.ok(first, 'first Stop after real spend must emit a systemMessage')
    assert.match(first.systemMessage, /Session spend: \$\d+\.\d{4}/)
    assert.match(first.systemMessage, /Explore/)

    // Same transcript, nothing changed -> zero NEW delta -> must stay silent.
    const second = run(STOP, { session_id: ID, transcript_path: fx.jsonl }, env)
    assert.equal(second, null, 'no new spend since last shown must not re-trigger the reminder')
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})

test('stop.mjs: below-threshold spend never shows a reminder', () => {
  const fx = setup()
  try {
    const env = { HOME: fx.home, USERPROFILE: fx.home, CALIPER_REMINDER_THRESHOLD_USD: '1000' }
    const out = run(STOP, { session_id: ID, transcript_path: fx.jsonl }, env)
    assert.equal(out, null)
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})

test('stop.mjs: missing transcript_path/session_id is a silent no-op, never throws', () => {
  const fx = setup()
  try {
    const env = { HOME: fx.home, USERPROFILE: fx.home }
    assert.equal(run(STOP, {}, env), null)
  } finally { rmSync(fx.root, { recursive: true, force: true }) }
})

// ── full lifecycle: session-start launches a real server, session-end kills it ───
test('session-start.mjs + session-end.mjs: real server boots, is reachable, and is torn down cleanly', async () => {
  const fx = setup()
  const env = { HOME: fx.home, USERPROFILE: fx.home }
  let pid = null
  try {
    const startOut = run(START, { session_id: ID, cwd: fx.projectDir }, env)
    assert.ok(startOut?.systemMessage, 'SessionStart must report a systemMessage')
    const m = startOut.systemMessage.match(/http:\/\/localhost:(\d+)/)
    assert.ok(m, `expected a dashboard URL in: ${startOut.systemMessage}`)
    const port = Number(m[1])

    const stateRaw = JSON.parse(readFileSync(join(fx.home, '.cache', 'workflow-lens', 'hook-server.json'), 'utf8'))
    pid = stateRaw.pid
    assert.equal(stateRaw.port, port)
    assert.equal(isPidAlive(pid), true, 'the spawned server process must actually be running')
    assert.equal(await checkHealth(port), true, 'the spawned server must actually answer /v1/health')

    const lockFile = join(fx.home, '.cache', 'workflow-lens', 'hook-locks', ID)
    assert.ok(existsSync(lockFile), 'SessionStart must register this session as a lock holder')

    run(END, { session_id: ID, reason: 'other' }, env)

    // SIGTERM is async; poll briefly for the real process to actually exit.
    const deadline = Date.now() + 3000
    while (isPidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    assert.equal(isPidAlive(pid), false, 'SessionEnd must actually terminate the server process')
    assert.ok(!existsSync(lockFile), 'this session\'s lock must be removed')
    assert.ok(!existsSync(join(fx.home, '.cache', 'workflow-lens', 'hook-server.json')), 'server state must be cleared once idle')
  } finally {
    if (pid && isPidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
    rmSync(fx.root, { recursive: true, force: true })
  }
})

// MUTATION-PROVED: in session-end.mjs, changed `if (!hasAnyLocks(root))` to `if (true)`
// (kill unconditionally, ignore remaining locks) -> RED on exactly this test ("server
// must survive: the other session still holds a lock" failed — it was already dead);
// the single-session lifecycle test above stayed green (targeted kill, since that test
// has no second lock to ignore). Restored -> GREEN.
test('session-end.mjs: a still-active concurrent session keeps the shared server alive', async () => {
  const fx = setup()
  const env = { HOME: fx.home, USERPROFILE: fx.home }
  let pid = null
  try {
    const startOut = run(START, { session_id: ID, cwd: fx.projectDir }, env)
    const port = Number(startOut.systemMessage.match(/http:\/\/localhost:(\d+)/)[1])
    const stateRaw = JSON.parse(readFileSync(join(fx.home, '.cache', 'workflow-lens', 'hook-server.json'), 'utf8'))
    pid = stateRaw.pid

    // A second, concurrent session reuses the SAME server (no new spawn) and takes its own lock.
    const OTHER_ID = 'aaaaaaaa-1111-4222-8333-444455556666'
    const secondStart = run(START, { session_id: OTHER_ID, cwd: fx.projectDir }, env)
    assert.equal(Number(secondStart.systemMessage.match(/http:\/\/localhost:(\d+)/)[1]), port, 'must reuse the already-running server, not spawn a second one')

    run(END, { session_id: ID, reason: 'other' }, env) // first session ends...
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(isPidAlive(pid), true, 'server must survive: the other session still holds a lock')

    run(END, { session_id: OTHER_ID, reason: 'other' }, env) // ...now the last one ends
    const deadline = Date.now() + 3000
    while (isPidAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    assert.equal(isPidAlive(pid), false, 'server must be dead once the last lock is gone')
  } finally {
    if (pid && isPidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
    rmSync(fx.root, { recursive: true, force: true })
  }
})
