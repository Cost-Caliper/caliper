// ledger.mjs — per-call / per-phase / per-run telemetry for a workflow run.
//
// Every real agent() call is recorded with its true token usage and wall-clock
// window [startMs, endMs]. costUsd is derived from the price table (NOT trusted
// from the caller). Because calls inside parallel()/pipeline() overlap in time,
// the run wall-clock (max(endMs) - min(startMs)) is provably LESS than the naive
// sum of per-call ms — that gap is the headline "concurrency saved you N ms"
// claim the HTML timeline visualizes.
import { PRICE } from './shim.mjs'

export function costOf(tier, inTok, outTok, price = PRICE) {
  const p = price[tier] || price.sonnet
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out
}

export function createLedger({ price = PRICE, clock } = {}) {
  // clock() returns ms-since-epoch-ish; default a monotonic hrtime-based clock so
  // the ledger itself never trips the workflow no-Date/no-random rule when reused.
  const t0 = process.hrtime.bigint()
  const now = clock || (() => Number(process.hrtime.bigint() - t0) / 1e6)
  const calls = []
  let seq = 0

  // Wrap any agent backend; records the call window + usage and tags it onto the
  // backend's returned shape. Returns the SAME value the inner backend returned
  // (string for schema-less, object for schema, null for skip/death) so the
  // workflow under test sees no behavioral change.
  function instrument(backend) {
    return async function recorded(prompt, opts = {}) {
      const id = ++seq
      const label = opts.label || `call-${id}`
      const tier = opts.model || 'sonnet'
      const startMs = now()
      let res, threw = null
      try {
        res = await backend(prompt, opts)
      } catch (e) {
        threw = e
      }
      const endMs = now()
      // Backend may return {text,usage,ms,...} (anthropic/gate) or a plain
      // string/object (a stub). Normalize usage + model.
      const usage = (res && res.usage) || {}
      const inTok = usage.inTok || 0
      const outTok = usage.outTok || 0
      const model = (res && res.model) || tier
      const requestId = (res && res.requestId) || null
      const ms = res && typeof res.ms === 'number' ? res.ms : +(endMs - startMs).toFixed(1)
      const costUsd = +costOf(tier, inTok, outTok, price).toFixed(6)
      calls.push({
        id, label, tier, model, phase: opts.phase || null,
        startMs: +startMs.toFixed(1), endMs: +endMs.toFixed(1), ms,
        inTok, outTok, costUsd, requestId,
        error: threw ? String(threw.message || threw) : null,
      })
      if (threw) throw threw
      // Unwrap the backend's envelope into the value the workflow expects:
      //   schema call  -> the validated object (schemaResult/json), else the parsed text
      //   plain call   -> the text string
      // A non-envelope return (plain string, or a stub returning null/object) passes through.
      const isEnvelope = res && typeof res === 'object' && 'text' in res && 'usage' in res
      if (isEnvelope) {
        if (opts.schema) return res.schemaResult ?? res.json ?? safeJson(res.text)
        return res.text
      }
      return res
    }
  }
  function safeJson(t) { try { return JSON.parse(t) } catch { return t } }

  function perPhase() {
    const m = new Map()
    for (const c of calls) {
      const k = c.phase || '(none)'
      const agg = m.get(k) || { phase: k, calls: 0, inTok: 0, outTok: 0, costUsd: 0, sumMs: 0, minStart: Infinity, maxEnd: -Infinity }
      agg.calls++; agg.inTok += c.inTok; agg.outTok += c.outTok; agg.costUsd += c.costUsd; agg.sumMs += c.ms
      agg.minStart = Math.min(agg.minStart, c.startMs); agg.maxEnd = Math.max(agg.maxEnd, c.endMs)
      m.set(k, agg)
    }
    return [...m.values()].map((a) => ({
      ...a, costUsd: +a.costUsd.toFixed(6), sumMs: +a.sumMs.toFixed(1),
      wallMs: a.calls ? +(a.maxEnd - a.minStart).toFixed(1) : 0,
    }))
  }

  function rollup() {
    const inTok = calls.reduce((s, c) => s + c.inTok, 0)
    const outTok = calls.reduce((s, c) => s + c.outTok, 0)
    const costUsd = +calls.reduce((s, c) => s + c.costUsd, 0).toFixed(6)
    const sumMs = +calls.reduce((s, c) => s + c.ms, 0).toFixed(1)        // naive serial total
    const minStart = calls.length ? Math.min(...calls.map((c) => c.startMs)) : 0
    const maxEnd = calls.length ? Math.max(...calls.map((c) => c.endMs)) : 0
    const wallMs = +(maxEnd - minStart).toFixed(1)                       // concurrency-aware
    return {
      calls: calls.length, inTok, outTok, costUsd,
      sumMs, wallMs,
      concurrencySavingMs: +(sumMs - wallMs).toFixed(1),                 // the provable gap
      speedup: wallMs > 0 ? +(sumMs / wallMs).toFixed(2) : 1,
    }
  }

  return {
    instrument,
    record(call) { calls.push({ id: ++seq, ...call }) }, // manual push (e.g. for skipped/null)
    calls: () => calls.slice(),
    perPhase,
    rollup,
    snapshot() { return { calls: calls.slice(), perPhase: perPhase(), run: rollup() } },
  }
}
