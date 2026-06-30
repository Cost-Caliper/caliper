// test/cli.smoke.test.mjs — spawns bin/workflow-lens.mjs for keyless command smoke tests.
// Verifies: graph --json exits 0 with valid JSON; lint exits 0 on good file and 1 on bad;
// instrument --check lists call sites; viz writes a no-CDN HTML; estimate prints a band;
// run without a key FAILS CLOSED (MISSING_CREDENTIAL, exits non-zero).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BIN = join(ROOT, 'bin', 'workflow-lens.mjs')
const FIX = join(__dirname, 'fixtures')
const FANOUT = join(FIX, 'fixture-fanout.workflow.js')
const HELLO = join(FIX, 'fixture-hello.workflow.js')
const BAD_BANNED = join(FIX, 'bad', 'bad-banned-global.workflow.js')

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, ...env },
    timeout: 15000,
  })
}

// ── graph ─────────────────────────────────────────────────────────────────────

test('graph --json exits 0 and emits valid JSON with metaName', () => {
  const r = run(['graph', FANOUT, '--json'])
  assert.equal(r.status, 0, 'expected exit 0, stderr: ' + r.stderr)
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout) }, 'stdout should be valid JSON')
  assert.equal(parsed.metaName, 'fixture-fanout')
  assert.ok(Array.isArray(parsed.phaseNodes))
  assert.ok(Array.isArray(parsed.agentNodes))
  assert.ok(Array.isArray(parsed.edges))
})

test('graph (no --json) exits 0 and prints human summary', () => {
  const r = run(['graph', HELLO])
  assert.equal(r.status, 0, 'stderr: ' + r.stderr)
  assert.ok(r.stdout.includes('fixture-hello') || r.stdout.includes('workflow:'), 'missing workflow name in output')
})

// ── lint ──────────────────────────────────────────────────────────────────────

test('lint: clean workflow exits 0', () => {
  const r = run(['lint', FANOUT])
  assert.equal(r.status, 0, 'expected exit 0, stderr: ' + r.stderr)
})

test('lint: bad workflow exits 1 and prints no-nondeterminism finding', () => {
  const r = run(['lint', BAD_BANNED])
  assert.equal(r.status, 1, 'expected exit 1 for bad workflow')
  const out = r.stdout + r.stderr
  assert.ok(out.includes('no-nondeterminism'), 'expected no-nondeterminism finding in output: ' + out)
})

// ── instrument ────────────────────────────────────────────────────────────────

test('instrument --check lists call sites without writing', () => {
  const r = run(['instrument', FANOUT, '--check'])
  assert.equal(r.status, 0, 'stderr: ' + r.stderr)
  const out = r.stdout
  // Should mention call sites (agent, parallel, pipeline)
  assert.ok(out.includes('agent') || out.includes('parallel') || out.includes('pipeline') || out.includes('call site'), 'expected call site info: ' + out)
})

test('instrument writes an output file', () => {
  const outFile = join(tmpdir(), `smoke-instrumented-${Date.now()}.workflow.js`)
  const r = run(['instrument', HELLO, '--out', outFile])
  assert.equal(r.status, 0, 'stderr: ' + r.stderr)
  assert.ok(existsSync(outFile), 'output file should exist')
  const content = readFileSync(outFile, 'utf8')
  assert.ok(content.includes('__trace'), 'instrumented file should contain __trace')
  try { unlinkSync(outFile) } catch {}
})

// ── viz ───────────────────────────────────────────────────────────────────────

test('viz writes a self-contained HTML file with no CDN', () => {
  const outFile = join(tmpdir(), `smoke-viz-${Date.now()}.html`)
  const r = run(['viz', FANOUT, '--out', outFile])
  assert.equal(r.status, 0, 'stderr: ' + r.stderr)
  assert.ok(existsSync(outFile), 'output HTML file should exist')
  const html = readFileSync(outFile, 'utf8')
  assert.ok(html.includes('<svg'), 'HTML should contain inline SVG')
  assert.ok(!/cdn\.|<script\s+src=/i.test(html), 'HTML should NOT reference CDN or external script')
  try { unlinkSync(outFile) } catch {}
})

// ── estimate ──────────────────────────────────────────────────────────────────

test('estimate exits 0 and prints a cost band', () => {
  const r = run(['estimate', FANOUT])
  assert.equal(r.status, 0, 'stderr: ' + r.stderr)
  const out = r.stdout
  assert.ok(out.includes('cost') || out.includes('$'), 'expected cost info in output: ' + out)
})

test('estimate --json exits 0 and emits valid JSON', () => {
  const r = run(['estimate', HELLO, '--json'])
  assert.equal(r.status, 0, 'stderr: ' + r.stderr)
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout) }, 'stdout should be valid JSON')
  assert.ok(parsed.costUsd >= 0)
  assert.ok(parsed.workflowName)
})

// ── run (live fail-closed) ────────────────────────────────────────────────────

test('run without ANTHROPIC_API_KEY fails closed with MISSING_CREDENTIAL (non-zero exit)', () => {
  const r = run(['run', HELLO], {
    ANTHROPIC_API_KEY: '',   // unset the key
    OPENROUTER_API_KEY: '',
  })
  assert.notEqual(r.status, 0, 'expected non-zero exit when key is absent')
  const out = r.stdout + r.stderr
  assert.ok(
    out.includes('MISSING_CREDENTIAL') || out.includes('not set') || out.includes('required'),
    'expected MISSING_CREDENTIAL message, got: ' + out,
  )
})

// ── --help ────────────────────────────────────────────────────────────────────

test('--help exits 0 and prints usage', () => {
  const r = run(['--help'])
  assert.equal(r.status, 0)
  assert.ok(r.stdout.includes('graph') && r.stdout.includes('lint'), 'help should list commands')
})
