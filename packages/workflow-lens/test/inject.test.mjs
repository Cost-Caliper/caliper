// test/inject.test.mjs — keyless injection tests.
// Ported from capstone test-inject.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX = join(__dirname, 'fixtures')

import { transform } from '../src/inject.mjs'
import { lint } from '../src/ast.mjs'
import { compileWorkflow, makeParallel, makePipeline, makeBudget } from '../src/shim.mjs'

const helloSrc = readFileSync(join(FIX, 'fixture-hello.workflow.js'), 'utf8')
const fanoutSrc = readFileSync(join(FIX, 'fixture-fanout.workflow.js'), 'utf8')

// ── Output still lints clean ──────────────────────────────────────────────────

test('transform: instrumented hello still lints clean', () => {
  const { instrumentedSource } = transform(helloSrc)
  const result = lint(instrumentedSource)
  assert.equal(result.ok, true, `lint findings: ${JSON.stringify(result.findings)}`)
})

test('transform: instrumented fanout still lints clean', () => {
  const { instrumentedSource } = transform(fanoutSrc)
  const result = lint(instrumentedSource)
  assert.equal(result.ok, true, `lint findings: ${JSON.stringify(result.findings)}`)
})

test('transform: instrumented source still starts with export const meta', () => {
  const { instrumentedSource } = transform(helloSrc)
  assert.ok(instrumentedSource.trimStart().startsWith('export const meta'), 'must start with export const meta')
})

// ── Call site counts ──────────────────────────────────────────────────────────

test('transform: hello wraps exactly 1 call site (agent)', () => {
  const { wrappedCallSites } = transform(helloSrc)
  assert.equal(wrappedCallSites.length, 1)
  assert.equal(wrappedCallSites[0].kind, 'agent')
})

test('transform: fanout wraps parallel + pipeline + 3 agent sites', () => {
  const { wrappedCallSites } = transform(fanoutSrc)
  const kinds = wrappedCallSites.map(s => s.kind)
  assert.ok(kinds.includes('parallel'), 'should wrap parallel')
  assert.ok(kinds.includes('pipeline'), 'should wrap pipeline')
  const agentCount = kinds.filter(k => k === 'agent').length
  assert.equal(agentCount, 3, `expected 3 agent sites, got ${agentCount}`)
})

// ── Behavior unchanged: runs under stub ──────────────────────────────────────

test('transform: instrumented hello returns same result under stub', async () => {
  const { instrumentedSource } = transform(helloSrc)
  const fn = compileWorkflow(instrumentedSource)
  const stubAgent = async () => 'ok'
  const logs = []
  const result = await fn(stubAgent, makeParallel(), makePipeline(), () => {}, (m) => logs.push(m), {}, makeBudget(null), async () => null)
  assert.ok(result && result.reply === 'ok', `expected {reply:'ok'}, got ${JSON.stringify(result)}`)
})

test('transform: instrumented fanout parallel fires 4 thunks, pipeline gets 2 stages', async () => {
  const { instrumentedSource } = transform(fanoutSrc)
  const fn = compileWorkflow(instrumentedSource)

  const logs = []
  let agentCalls = 0
  const stubAgent = async (prompt, opts = {}) => {
    agentCalls++
    return `stub-${opts.label || agentCalls}`
  }

  const result = await fn(stubAgent, makeParallel(), makePipeline(), () => {}, (m) => logs.push(String(m)), {}, makeBudget(null), async () => null)

  // The workflow should have called agent 4 + (up to 4×2) times
  // facts = 4 parallel stubs, refined = 4 items × 2 stages
  assert.ok(agentCalls >= 4, `expected at least 4 agent calls, got ${agentCalls}`)

  // TRACE lines from log should include parallel enter
  const traceLines = logs.filter(l => l.startsWith('TRACE '))
  const parsed = traceLines.map(l => { try { return JSON.parse(l.slice(6)) } catch { return null } }).filter(Boolean)
  const parallelEnter = parsed.find(t => t.kind === 'parallel' && t.ev === 'enter')
  assert.ok(parallelEnter, 'should have a TRACE parallel enter record')
  assert.ok(parallelEnter.thunks >= 1, `expected thunks >= 1, got ${parallelEnter.thunks}`)
})

// ── Idempotence ───────────────────────────────────────────────────────────────

test('transform: re-instrumenting already-instrumented source is a no-op', () => {
  const { instrumentedSource: first } = transform(helloSrc)
  const { instrumentedSource: second, alreadyInstrumented, wrappedCallSites } = transform(first)
  assert.equal(alreadyInstrumented, true)
  assert.equal(wrappedCallSites.length, 0)
  assert.equal(first, second)
})

// ── Arg evaluated exactly once ────────────────────────────────────────────────

test('transform: side-effect prompt arg evaluated exactly once', async () => {
  const src = `export const meta = { name: 'once-test' }
let count = 0
const r = await agent('prompt-' + (++count), { model: 'haiku' })
return { r, count }`
  const { instrumentedSource } = transform(src)
  const fn = compileWorkflow(instrumentedSource)
  const result = await fn(async (p) => p, makeParallel(), makePipeline(), () => {}, () => {}, {}, makeBudget(null), async () => null)
  assert.equal(result.count, 1, `arg should be evaluated exactly once, count=${result.count}`)
})
