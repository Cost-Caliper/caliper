// test/cassette.test.mjs — keyless record/replay tests.
// Ported from A5 test-cassette.mjs, using node:test and a stub backend.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

import { createRecorder, loadCassette, hashCall } from '../src/cassette.mjs'
import { hashCall as gateHashCall } from '../src/gate.mjs'

// Stub backend (no network): returns a unique envelope per call.
let stubSeq = 0
function makeStub() {
  return async (prompt, opts = {}) => ({
    text: `response-to: ${prompt}`,
    usage: { inTok: 10, outTok: 5 },
    ms: 15,
    requestId: `stub-req-${++stubSeq}`,
    tier: opts.model || 'sonnet',
    model: opts.model || 'sonnet',
  })
}

// ── hashCall parity with gate.hashCall ────────────────────────────────────────

test('cassette.hashCall === gate.hashCall for same inputs', () => {
  const a = hashCall('hello world', { model: 'haiku', max_tokens: 32 })
  const b = gateHashCall('hello world', { model: 'haiku', max_tokens: 32 })
  assert.equal(a, b)
})

// ── record -> save -> load -> replay ─────────────────────────────────────────

test('record N calls -> save -> loadCassette -> replay returns same envelopes with 0 real calls', async () => {
  const stub = makeStub()
  const recorder = createRecorder(stub, { metaName: 'test-cassette' })

  // Record 3 calls
  const calls = [
    { prompt: 'what is 2+2', opts: { model: 'haiku' } },
    { prompt: 'say hello', opts: { model: 'sonnet' } },
    { prompt: 'describe the sky', opts: { model: 'haiku' } },
  ]
  const origResults = []
  for (const c of calls) {
    origResults.push(await recorder(c.prompt, c.opts))
  }

  // Save to a temp file
  const tmpPath = join(tmpdir(), `test-cassette-${Date.now()}.json`)
  recorder.save(tmpPath)

  // Load and replay
  const replay = loadCassette(tmpPath)
  let replayCount = 0
  const replayResults = []
  for (const c of calls) {
    replayResults.push(await replay(c.prompt, c.opts))
    replayCount++
  }

  // Should have replayed all 3
  assert.equal(replayCount, 3)
  const stats = replay.stats()
  assert.equal(stats.replayHits, 3)
  assert.equal(stats.cacheMisses, 0)

  // Returned envelopes should have same text and requestId as originals
  for (let i = 0; i < origResults.length; i++) {
    assert.equal(replayResults[i].text, origResults[i].text)
    assert.equal(replayResults[i].requestId, origResults[i].requestId)
    assert.equal(replayResults[i].replayed, true)
  }

  // Cleanup
  try { unlinkSync(tmpPath) } catch {}
})

test('recorder: duplicate calls record last-write-wins; size = unique prompts', async () => {
  const stub = makeStub()
  const recorder = createRecorder(stub, { metaName: 'dup-test' })
  await recorder('hello', { model: 'haiku' })
  await recorder('hello', { model: 'haiku' })  // same key — overwrites
  const s = recorder.stats()
  assert.equal(s.size, 1)
  assert.equal(s.callCount, 2)
  assert.equal(s.dupCount, 1)
})

test('replay: unrecorded call throws CACHE_MISS', async () => {
  const stub = makeStub()
  const recorder = createRecorder(stub, { metaName: 'miss-test' })
  await recorder('recorded prompt', { model: 'haiku' })

  const tmpPath = join(tmpdir(), `test-cache-miss-${Date.now()}.json`)
  recorder.save(tmpPath)
  const replay = loadCassette(tmpPath)

  await assert.rejects(
    () => replay('this was NOT recorded', { model: 'haiku' }),
    (e) => e.code === 'CACHE_MISS',
  )

  const s = replay.stats()
  assert.equal(s.cacheMisses, 1)

  try { unlinkSync(tmpPath) } catch {}
})

test('loadCassette: missing file throws CACHE_MISS (ENOENT)', () => {
  assert.throws(
    () => loadCassette('/tmp/this-does-not-exist-12345.json'),
    (e) => e.code === 'CACHE_MISS',
  )
})
