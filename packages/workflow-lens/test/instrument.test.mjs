// test/instrument.test.mjs — unit tests for instrument.mjs.
// Keyless and deterministic: no real backends, no network.
// Covers each config field independently, idempotence, lint-clean, and apply().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX = join(__dirname, 'fixtures')

import { instrument, apply, applyInstrument } from '../src/instrument.mjs'
import { lint } from '../src/ast.mjs'

// ── Shared fixtures ───────────────────────────────────────────────────────────

const HELLO_SRC = readFileSync(join(FIX, 'fixture-hello.workflow.js'), 'utf8')
const FANOUT_SRC = readFileSync(join(FIX, 'fixture-fanout.workflow.js'), 'utf8')

const DUP_PROMPT_SRC = `export const meta = { name: 'dup-prompt' }
const a = await agent('same prompt', { label: 'a', model: 'sonnet' })
const b = await agent('same prompt', { label: 'b', model: 'sonnet' })
const c = await agent('different prompt', { label: 'c', model: 'haiku' })
return { a, b, c }`

const FANOUT_5_SRC = `export const meta = { name: 'fanout-5' }
const results = await parallel([
  () => agent('task 1', { label: 't1', model: 'sonnet' }),
  () => agent('task 2', { label: 't2', model: 'sonnet' }),
  () => agent('task 3', { label: 't3', model: 'sonnet' }),
  () => agent('task 4', { label: 't4', model: 'sonnet' }),
  () => agent('task 5', { label: 't5', model: 'sonnet' }),
])
return { results }`

const FLAGGED_SRC = `export const meta = { name: 'flagged-labels' }
const a = await agent('normal task', { label: 'normal', model: 'haiku' })
const b = await agent('escape task', { label: 'escape-me', model: 'haiku' })
return { a, b }`

const TWO_PHASE_SRC = `export const meta = { name: 'two-phase' }
phase('Plan')
const plan = await agent('make a plan', { label: 'planner', model: 'sonnet', phase: 'Plan' })
phase('Execute')
const exec = await agent('execute: ' + plan, { label: 'executor', model: 'haiku', phase: 'Execute' })
return { plan, exec }`

// ── Baseline: logTrace channel (parity mode) ──────────────────────────────────

test('instrument: default config produces lint-clean output', () => {
  const result = instrument(HELLO_SRC, {})
  assert.equal(result.lintOk, true, `lint findings: ${JSON.stringify(result.lintFindings)}`)
})

test('instrument: output starts with export const meta', () => {
  const result = instrument(HELLO_SRC, {})
  assert.ok(result.instrumentedSource.trimStart().startsWith('export const meta'))
})

test('instrument: has WFLENS_INSTRUMENT_PRELUDE marker', () => {
  const result = instrument(HELLO_SRC, {})
  assert.ok(result.instrumentedSource.includes('WFLENS_INSTRUMENT_PRELUDE'))
})

test('instrument: has __trace prelude from inject.mjs', () => {
  const result = instrument(HELLO_SRC, {})
  assert.ok(result.instrumentedSource.includes('auto-instrumentation prelude'))
})

test('instrument: wrappedCallSites is populated', () => {
  const result = instrument(HELLO_SRC, {})
  assert.equal(result.wrappedCallSites.length, 1)
  assert.equal(result.wrappedCallSites[0].kind, 'agent')
  assert.equal(result.wrappedCallSites[0].label, 'greeter')
})

test('instrument: returns manifest with mode/channels/policy/hooks', () => {
  const result = instrument(HELLO_SRC, {})
  assert.ok(result.manifest)
  assert.equal(result.manifest.mode, 'sibling')
  assert.equal(result.manifest.channels.logTrace, true)
  assert.equal(result.manifest.policy.cache, false)
})

// ── Idempotence ───────────────────────────────────────────────────────────────

test('instrument: re-instrumenting already-instrumented source is a no-op', () => {
  const first = instrument(HELLO_SRC, {})
  const second = instrument(first.instrumentedSource, {})
  assert.equal(second.alreadyInstrumented, true)
  assert.equal(second.wrappedCallSites.length, 0)
  assert.equal(second.injectedSteps.length, 0)
  assert.equal(second.instrumentedSource, first.instrumentedSource)
})

// ── mode config ───────────────────────────────────────────────────────────────

test('instrument: mode sibling produces same instrumented body as mode rewrite', () => {
  const sib = instrument(HELLO_SRC, { mode: 'sibling' })
  const rew = instrument(HELLO_SRC, { mode: 'rewrite' })
  // Only the manifest mode differs — the instrumented source body is identical
  assert.equal(sib.instrumentedSource, rew.instrumentedSource)
  assert.equal(sib.manifest.mode, 'sibling')
  assert.equal(rew.manifest.mode, 'rewrite')
})

// ── apply() write modes ───────────────────────────────────────────────────────

test('apply: sibling mode writes <name>.instrumented.workflow.js', () => {
  const tmpDir = join(tmpdir(), 'wflens-test-sibling-' + Math.floor(Date.now() / 1000))
  mkdirSync(tmpDir, { recursive: true })
  const srcPath = join(tmpDir, 'hello.workflow.js')
  writeFileSync(srcPath, HELLO_SRC)

  try {
    const result = apply(HELLO_SRC, { mode: 'sibling' }, { filePath: srcPath })
    assert.ok(result.written.length >= 1, 'should write at least one file')
    const sib = result.written.find(w => w.role === 'instrumented')
    assert.ok(sib, 'should have an instrumented file')
    assert.ok(sib.path.endsWith('.instrumented.workflow.js'), `path should end with .instrumented.workflow.js, got ${sib.path}`)
    assert.ok(existsSync(sib.path), 'instrumented file should exist')
    // Original unchanged
    assert.equal(readFileSync(srcPath, 'utf8'), HELLO_SRC)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('apply: rewrite mode writes in-place + .backup', () => {
  const tmpDir = join(tmpdir(), 'wflens-test-rewrite-' + Math.floor(Date.now() / 1000))
  mkdirSync(tmpDir, { recursive: true })
  const srcPath = join(tmpDir, 'hello.workflow.js')
  writeFileSync(srcPath, HELLO_SRC)

  try {
    const result = apply(HELLO_SRC, { mode: 'rewrite' }, { filePath: srcPath })
    const backup = result.written.find(w => w.role === 'backup')
    const instrumented = result.written.find(w => w.role === 'instrumented')
    assert.ok(backup, 'should create a backup')
    assert.ok(existsSync(backup.path), 'backup should exist on disk')
    assert.equal(readFileSync(backup.path, 'utf8'), HELLO_SRC, 'backup should be the original')
    assert.ok(instrumented, 'should have instrumented file')
    assert.equal(instrumented.path, srcPath, 'instrumented should be the original path')
    const written = readFileSync(srcPath, 'utf8')
    assert.ok(written.includes('WFLENS_INSTRUMENT_PRELUDE'), 'in-place file should be instrumented')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('apply: rewrite mode does not clobber an existing .backup', () => {
  const tmpDir = join(tmpdir(), 'wflens-test-noclobber-' + Math.floor(Date.now() / 1000))
  mkdirSync(tmpDir, { recursive: true })
  const srcPath = join(tmpDir, 'hello.workflow.js')
  const backupPath = srcPath + '.backup'
  writeFileSync(srcPath, HELLO_SRC)
  writeFileSync(backupPath, '// existing backup\n')

  try {
    apply(HELLO_SRC, { mode: 'rewrite' }, { filePath: srcPath })
    // Backup should remain unchanged (not clobbered)
    assert.equal(readFileSync(backupPath, 'utf8'), '// existing backup\n')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('applyInstrument: alias of apply works', () => {
  assert.equal(typeof applyInstrument, 'function')
})

// ── policy.cache ──────────────────────────────────────────────────────────────

test('instrument: policy.cache injects __wflensCache Map', () => {
  const result = instrument(DUP_PROMPT_SRC, { policy: { cache: true } })
  assert.ok(result.instrumentedSource.includes('__wflensCache'), 'should inject cache Map')
  assert.ok(result.lintOk, 'should still lint clean')
})

test('instrument: policy.cache manifest reflects cache:true', () => {
  const result = instrument(DUP_PROMPT_SRC, { policy: { cache: true } })
  assert.equal(result.manifest.policy.cache, true)
})

// ── policy.callCap ────────────────────────────────────────────────────────────

test('instrument: policy.callCap injects WFLENS_CALL_CAP code', () => {
  const result = instrument(FANOUT_5_SRC, { policy: { callCap: 3 } })
  assert.ok(result.instrumentedSource.includes('WFLENS_CALL_CAP'))
  assert.ok(result.instrumentedSource.includes('__wflensCap = 3'))
  assert.ok(result.lintOk)
})

test('instrument: policy.callCap manifest reflects callCap value', () => {
  const result = instrument(FANOUT_5_SRC, { policy: { callCap: 5 } })
  assert.equal(result.manifest.policy.callCap, 5)
})

test('instrument: policy.callCap onCap skip is preserved', () => {
  const result = instrument(FANOUT_5_SRC, { policy: { callCap: 2, onCap: 'skip' } })
  assert.ok(result.instrumentedSource.includes('__wflensOnCap = "skip"'))
  assert.equal(result.manifest.policy.onCap, 'skip')
})

// ── policy.rerouteModel ───────────────────────────────────────────────────────

test('instrument: policy.rerouteModel injects __wflensRerouteMap', () => {
  const result = instrument(DUP_PROMPT_SRC, { policy: { rerouteModel: { sonnet: 'haiku' } } })
  assert.ok(result.instrumentedSource.includes('__wflensRerouteMap'))
  assert.ok(result.instrumentedSource.includes('"sonnet"'))
  assert.ok(result.instrumentedSource.includes('"haiku"'))
  assert.ok(result.lintOk)
})

test('instrument: rerouteModel manifest reflects mapping', () => {
  const result = instrument(DUP_PROMPT_SRC, { policy: { rerouteModel: { sonnet: 'haiku' } } })
  assert.deepEqual(result.manifest.policy.rerouteModel, { sonnet: 'haiku' })
})

// ── channels.beacon ───────────────────────────────────────────────────────────

test('instrument: beacon enabled injects beacon agent code', () => {
  const result = instrument(HELLO_SRC, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://localhost:8787', events: ['run-start', 'run-end'], model: 'haiku' } }
  })
  assert.ok(result.instrumentedSource.includes('wflens_beacon_run-start') || result.instrumentedSource.includes('beacon_run-start'))
  assert.ok(result.instrumentedSource.includes('wflens_beacon_run-end') || result.instrumentedSource.includes('beacon_run-end'))
  assert.ok(result.injectedSteps.some(s => s.kind === 'beacon' && s.where === 'run-start'))
  assert.ok(result.injectedSteps.some(s => s.kind === 'beacon' && s.where === 'run-end'))
  assert.ok(result.lintOk)
})

test('instrument: beacon injects curl to bridgeUrl', () => {
  const result = instrument(HELLO_SRC, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://mybridge:9999', events: ['run-start'], model: 'haiku' } }
  })
  assert.ok(result.instrumentedSource.includes('http://mybridge:9999'))
  assert.ok(result.lintOk)
})

test('instrument: beacon fault-tolerant (wrapped in try/catch)', () => {
  const result = instrument(HELLO_SRC, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://localhost:8787', events: ['run-start'], model: 'haiku' } }
  })
  // The beacon must be wrapped in try/catch so bridge down doesn't fail the workflow
  assert.ok(result.instrumentedSource.includes('beacon-fail'))
  assert.ok(result.lintOk)
})

test('instrument: beacon manifest reflects enabled state', () => {
  const result = instrument(HELLO_SRC, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://localhost:8787', events: ['run-start', 'run-end'] } }
  })
  assert.equal(result.manifest.channels.beacon.enabled, true)
})

// REGRESSION: run-end beacon must be injected BEFORE the final `return`, even when
// the source ends with a trailing newline (every real workflow does). A prior
// end-of-string-anchored regex appended the beacon AFTER the return, making it
// dead code that never executed.
test('instrument: run-end beacon precedes the return (not dead code after it)', () => {
  // Source WITH a trailing newline — the case the old regex got wrong.
  const src = `export const meta = { name: 'ret-newline' }
const a = await agent('go', { label: 'a', model: 'haiku' })
return { a }
`
  const result = instrument(src, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://localhost:8787', events: ['run-start', 'run-end'], model: 'haiku' } }
  })
  assert.ok(result.lintOk)
  const out = result.instrumentedSource
  const beaconIdx = out.indexOf('WFLENS run-end beacon')
  const returnIdx = out.search(/\nreturn /)
  assert.ok(beaconIdx >= 0, 'run-end beacon should be present')
  assert.ok(returnIdx >= 0, 'a return statement should be present')
  assert.ok(beaconIdx < returnIdx,
    `run-end beacon (@${beaconIdx}) must precede the return (@${returnIdx}) or it is dead code`)
})

// ── hooks.escapeHatch ─────────────────────────────────────────────────────────

test('instrument: escapeHatch injects __wflensEscapeLabels set', () => {
  const result = instrument(FLAGGED_SRC, {
    hooks: { escapeHatch: { flagLabels: ['escape-me'], provider: 'openrouter', model: 'openai/gpt-4o-mini', keyEnv: 'OPENROUTER_API_KEY' } }
  })
  assert.ok(result.instrumentedSource.includes('__wflensEscapeLabels'))
  assert.ok(result.instrumentedSource.includes('escape-me'))
  assert.ok(result.lintOk)
})

test('instrument: escapeHatch manifest reflects escapeHatch:true', () => {
  const result = instrument(FLAGGED_SRC, {
    hooks: { escapeHatch: { flagLabels: ['escape-me'], provider: 'openrouter', model: 'openai/gpt-4o-mini', keyEnv: 'OPENROUTER_API_KEY' } }
  })
  assert.equal(result.manifest.hooks.escapeHatch, true)
})

// ── hooks.conditionalShunt ────────────────────────────────────────────────────

test('instrument: conditionalShunt injects __wflensShuntDecision agent call', () => {
  const result = instrument(TWO_PHASE_SRC, {
    hooks: { conditionalShunt: { endpoint: 'http://decision:9000/model', decideModel: 'haiku', map: { fast: 'haiku', smart: 'sonnet' }, targets: ['executor'] } }
  })
  assert.ok(result.instrumentedSource.includes('__wflensShuntDecision'))
  assert.ok(result.instrumentedSource.includes('__wflens_decide'))
  assert.ok(result.instrumentedSource.includes('__wflensShuntTargets'))
  assert.ok(result.injectedSteps.some(s => s.kind === 'shunt'))
  assert.ok(result.lintOk)
})

test('instrument: conditionalShunt manifest reflects conditionalShunt:true', () => {
  const result = instrument(TWO_PHASE_SRC, {
    hooks: { conditionalShunt: { endpoint: 'http://decision:9000', decideModel: 'haiku', map: {}, targets: [] } }
  })
  assert.equal(result.manifest.hooks.conditionalShunt, true)
})

// ── composability: multiple config fields together ────────────────────────────

test('instrument: cache + reroute + callCap compose without lint errors', () => {
  const result = instrument(FANOUT_5_SRC, {
    policy: { cache: true, callCap: 3, onCap: 'skip', rerouteModel: { sonnet: 'haiku' } }
  })
  assert.ok(result.lintOk)
  assert.ok(result.instrumentedSource.includes('__wflensCache'))
  assert.ok(result.instrumentedSource.includes('__wflensRerouteMap'))
  assert.ok(result.instrumentedSource.includes('WFLENS_CALL_CAP'))
})

test('instrument: beacon + cache + reroute compose without lint errors', () => {
  const result = instrument(HELLO_SRC, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://localhost:8787', events: ['run-start', 'run-end'], model: 'haiku' } },
    policy: { cache: true, rerouteModel: { sonnet: 'haiku' } }
  })
  assert.ok(result.lintOk)
})

test('instrument: escapeHatch + conditionalShunt + beacon compose without lint errors', () => {
  const result = instrument(TWO_PHASE_SRC, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://localhost:8787', events: ['run-start'], model: 'haiku' } },
    hooks: {
      conditionalShunt: { endpoint: 'http://decide:9000', decideModel: 'haiku', map: {}, targets: ['executor'] },
      escapeHatch: { flagLabels: ['planner'], provider: 'openrouter', model: 'openai/gpt-4o-mini', keyEnv: 'OPENROUTER_API_KEY' },
    }
  })
  assert.ok(result.lintOk)
})

// ── instrumentationId (Bug C fix) ────────────────────────────────────────────

test('instrument: result carries a deterministic instrumentationId', () => {
  const result = instrument(HELLO_SRC, {})
  assert.ok(result.instrumentationId, 'instrumentationId should be present')
  assert.equal(typeof result.instrumentationId, 'string')
  // Must be non-empty hex string
  assert.ok(/^[0-9a-f]+$/.test(result.instrumentationId),
    `instrumentationId should be hex: ${result.instrumentationId}`)
})

test('instrument: instrumentationId is deterministic (same source -> same id)', () => {
  const r1 = instrument(HELLO_SRC, {})
  const r2 = instrument(HELLO_SRC, {})
  assert.equal(r1.instrumentationId, r2.instrumentationId,
    'same source should produce same instrumentationId')
})

test('instrument: instrumentationId differs across different workflow names', () => {
  const src1 = `export const meta = { name: 'alpha' }\nconst a = await agent('go', { label: 'a', model: 'haiku' })\nreturn { a }`
  const src2 = `export const meta = { name: 'beta' }\nconst a = await agent('go', { label: 'a', model: 'haiku' })\nreturn { a }`
  const r1 = instrument(src1, {})
  const r2 = instrument(src2, {})
  assert.notEqual(r1.instrumentationId, r2.instrumentationId,
    'different workflow names should produce different instrumentationIds')
})

test('instrument: preamble bakes __wflensInstrumentationId const', () => {
  const result = instrument(HELLO_SRC, {})
  assert.ok(result.instrumentedSource.includes('__wflensInstrumentationId'),
    'instrumented source should declare __wflensInstrumentationId const')
  // The value should be the same as the returned instrumentationId
  assert.ok(result.instrumentedSource.includes(`"${result.instrumentationId}"`),
    `instrumented source should contain the literal instrumentationId value`)
})

test('instrument: meta trace line emitted with instrumentationId', () => {
  const result = instrument(HELLO_SRC, {})
  assert.ok(result.instrumentedSource.includes("'WFLENS_TRACE '"),
    'instrumented source should emit WFLENS_TRACE')
  assert.ok(result.instrumentedSource.includes('"ev":"instrumented"') ||
            result.instrumentedSource.includes("ev: 'instrumented'") ||
            result.instrumentedSource.includes('"ev": "instrumented"'),
    'instrumented source should contain the meta ev:instrumented trace')
  assert.ok(result.instrumentedSource.includes('"kind":"meta"') ||
            result.instrumentedSource.includes("kind: 'meta'"),
    'instrumented source should contain kind:meta')
})

test('instrument: beacon payloads include instrumentationId when beacon enabled', () => {
  const result = instrument(HELLO_SRC, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://localhost:8787', events: ['run-start', 'run-end'], model: 'haiku' } }
  })
  // The curl payload in the beacon agent call must carry instrumentationId
  assert.ok(result.instrumentedSource.includes('"instrumentationId"'),
    'beacon payload should include instrumentationId key')
  assert.ok(result.instrumentedSource.includes(`"instrumentationId":"${result.instrumentationId}"`),
    `beacon payload should include the baked instrumentationId value ${result.instrumentationId}`)
})

test('instrument: beacon instrumentationId matches returned instrumentationId', () => {
  const src = `export const meta = { name: 'my-wf' }\nconst a = await agent('go', { label: 'a', model: 'haiku' })\nreturn { a }`
  const result = instrument(src, {
    channels: { beacon: { enabled: true, bridgeUrl: 'http://b', events: ['run-start'], model: 'haiku' } }
  })
  assert.ok(result.instrumentedSource.includes(`"instrumentationId":"${result.instrumentationId}"`),
    'beacon curl payload must carry the same instrumentationId as the returned result')
  assert.ok(result.lintOk)
})

// ── No banned globals introduced ──────────────────────────────────────────────

test('instrument: no Date.now() introduced by any config combination', () => {
  const combos = [
    {},
    { policy: { cache: true } },
    { policy: { callCap: 3 } },
    { policy: { rerouteModel: { sonnet: 'haiku' } } },
    { channels: { beacon: { enabled: true, bridgeUrl: 'http://b', events: ['run-start', 'run-end'], model: 'haiku' } } },
    { hooks: { escapeHatch: { flagLabels: ['x'], provider: 'openrouter', model: 'openai/gpt-4o-mini', keyEnv: 'OR' } } },
  ]
  for (const cfg of combos) {
    const result = instrument(HELLO_SRC, cfg)
    const lintR = lint(result.instrumentedSource)
    const banned = lintR.findings.filter(f => f.rule === 'no-nondeterminism')
    assert.equal(banned.length, 0, `banned globals found for config ${JSON.stringify(cfg)}: ${JSON.stringify(banned)}`)
  }
})
