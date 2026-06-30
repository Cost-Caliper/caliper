// cassette.mjs — deterministic record/replay for Claude Code workflow runs.
//
// WHAT IT DOES
//   RECORD mode: wrap any real agent backend; every call's (prompt + opts) is
//   hashed (same key as gate.mjs uses) and the full response envelope is stored.
//   When the run ends, call cassette.save(path) to persist the cassette to disk
//   as JSON.
//
//   REPLAY mode: load a cassette from disk; return recorded envelopes for every
//   (prompt+opts) pair that was recorded. Make ZERO real API calls. If a call
//   does NOT have a recording, throw a precise CACHE_MISS error — never silently
//   fall through to a real backend.
//
// KEY DESIGN DECISIONS
//   - Hash key = sha256(prompt + shaping opts: model/schema/max_tokens) — the
//     same stable key gate.mjs uses, so the two are interoperable.
//   - Replay returns the stored envelope verbatim (including the original
//     requestId and token counts) so downstream ledger.instrument() sees the
//     same shape it would from a live call. costUsd / tokens are authentic
//     replayed facts, not fabricated.
//   - Replay counts (replayHits, cacheMisses) are exposed via stats() so a test
//     can assert 0 real Anthropic calls without any test-double patching of fetch.
//   - save() / load() are synchronous convenience wrappers; callers that want
//     async may use JSON.stringify / writeFile directly.
//   - The cassette file format is intentionally simple: a JSON object mapping
//     hash -> recorded envelope, plus a small header with metaName + recordedAt
//     (ISO string, cosmetic only — the cassette is deterministic regardless).
//
// HONEST SCOPE
//   Cassette replay proves ZERO real API calls and identical return values. It
//   does NOT reproduce wall-clock timing — the replay backend returns immediately
//   (a real run will be much faster). The ledger still records startMs/endMs
//   from the external shim clock, so timing in replay is not meaningful.
//   This is correct and expected: the cassette is for correctness / zero-spend
//   testing, not latency modeling.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

// ── key derivation (identical to gate.mjs hashCall) ──────────────────────────
export function hashCall(prompt, opts = {}) {
  const shaping = {
    model: opts.model || 'sonnet',
    max_tokens: opts.max_tokens || null,
    schema: opts.schema || null,
  }
  return createHash('sha256').update(JSON.stringify({ prompt, shaping })).digest('hex').slice(0, 32)
}

// ── RECORD mode ───────────────────────────────────────────────────────────────
// createRecorder(realBackend, opts?) -> { backend, cassette(), save(path) }
//
//   backend: drop-in replacement for the real agent backend. Call it exactly
//     like the real backend — it records every unique call and returns the live
//     result unchanged.
//   cassette(): the in-memory cassette map { hash -> envelope }.
//   save(path): write the cassette to a JSON file.
export function createRecorder(realBackend, { metaName = '(unknown)' } = {}) {
  if (typeof realBackend !== 'function') throw new Error('createRecorder: realBackend must be a callable')
  const tape = new Map() // hash -> stored envelope
  let callCount = 0
  let dupCount = 0

  async function backend(prompt, opts = {}) {
    const hash = hashCall(prompt, opts)
    callCount++
    // Always make the real call (do not short-circuit here — recorder's job is
    // to capture, gate.mjs is the cache). If the same (prompt+opts) appears
    // twice in a single run, record the latest result (last-write-wins).
    const res = await realBackend(prompt, opts)
    if (tape.has(hash)) dupCount++
    // Store the full envelope the backend returned — keep requestId + usage so
    // replay can return authentic evidence without real calls.
    tape.set(hash, { ...res })
    return res
  }

  function cassette() {
    return Object.fromEntries(tape)
  }

  function save(path) {
    const payload = {
      _header: {
        metaName,
        recordedAt: new Date().toISOString(), // cosmetic; cassette is deterministic by hash
        calls: tape.size,
        dupCount,
      },
      entries: Object.fromEntries(tape),
    }
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
    return path
  }

  backend.cassette = cassette
  backend.save = save
  backend.stats = () => ({ callCount, dupCount, size: tape.size })
  return backend
}

// ── REPLAY mode ───────────────────────────────────────────────────────────────
// loadCassette(path) -> { backend, stats() }
//
//   Throws if the file does not exist (ENOENT) or is not parseable.
//   backend: async (prompt, opts) => stored envelope | throws CACHE_MISS.
//   stats(): { replayHits, cacheMisses, size }
export function loadCassette(path) {
  let payload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') {
      const err = new Error(`CACHE_MISS: cassette file not found: ${path}`)
      err.code = 'CACHE_MISS'
      err.path = path
      throw err
    }
    const err = new Error(`CASSETTE_PARSE_ERROR: ${e.message} (path: ${path})`)
    err.code = 'CASSETTE_PARSE_ERROR'
    err.cause = e
    throw err
  }

  // Support both raw {hash->envelope} and the wrapped {_header, entries:{...}} format.
  const entries = payload.entries || payload
  const tape = new Map(Object.entries(entries))

  let replayHits = 0
  let cacheMisses = 0

  async function backend(prompt, opts = {}) {
    const hash = hashCall(prompt, opts)
    if (!tape.has(hash)) {
      cacheMisses++
      const err = new Error(
        `CACHE_MISS: no recording for hash ${hash} (prompt: ${JSON.stringify(prompt.slice(0, 80))}…, model: ${opts.model || 'sonnet'})`,
      )
      err.code = 'CACHE_MISS'
      err.hash = hash
      err.prompt = prompt
      err.opts = opts
      throw err
    }
    replayHits++
    // Return the stored envelope with a `replayed:true` marker so callers can
    // distinguish replay traffic in telemetry without patching fetch.
    return { ...tape.get(hash), replayed: true, cached: false }
  }

  backend.stats = () => ({ replayHits, cacheMisses, size: tape.size })
  backend.header = payload._header || null
  return backend
}

export default { hashCall, createRecorder, loadCassette }
