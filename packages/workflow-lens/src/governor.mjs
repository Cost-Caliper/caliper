// governor.mjs — real-time cost governor for Claude Code workflow runs.
//
// WHAT IT DOES
//   Wraps any agent backend AND provides budget-aware parallel/pipeline overrides
//   so a HARD spend cap propagates out of concurrent barriers (which normally swallow
//   all errors as null). The budget check runs BEFORE every call; once spent >= cap
//   the run throws BUDGET_EXCEEDED and the workflow halts.
//
// KEY DESIGN INSIGHT — parallel/pipeline swallow errors by design
//   The documented harness contract: a throwing thunk in parallel() resolves to null,
//   and a throwing stage in pipeline() drops that item to null. This is correct for
//   transient call failures. But it means a BUDGET_EXCEEDED thrown from inside a
//   parallel thunk is silently swallowed — the workflow continues and keeps spending.
//
//   The fix: createGovernor returns budget-aware makeBudgetParallel() and
//   makeBudgetPipeline() replacements. These still return null for ordinary errors
//   but RE-THROW when the error is BUDGET_EXCEEDED. Pass them as g.parallel and
//   g.pipeline to runWorkflow. Combined with the agent-level pre-call check this
//   ensures the first trip surface as an error at the workflow level.
//
// DESIGN RATIONALE
//   - Budget enforcement BEFORE the call: avoids a race where a call is both made
//     AND charges the ledger — enforcement is strictly conservative.
//   - Wraps the ledger-instrumented backend so the ledger reflects all calls that
//     DID complete; the governor sees the running cumulative sum.
//   - Exposes `governedAgent.stats()` for audit: { cap, spent, calls, tripped }.
//   - Uses error code 'BUDGET_EXCEEDED' matching shim.makeBudget convention.
//
// USAGE
//   const { agent, parallel, pipeline } = createGovernor(recorded, ledger, { capUsd })
//   await runWorkflow(FIXTURE, { agent, parallel, pipeline })
//
// HONEST SCOPE
//   Cost is metered from the ledger (Anthropic price table, not a live pricing API).
//   Actual invoiced cost may differ slightly. Wall-clock is NOT used for enforcement.

// Error thrown when the cap is hit.
export class BudgetExceededError extends Error {
  constructor(spent, cap) {
    const msg = `BUDGET_EXCEEDED: spent $${spent.toFixed(6)} >= cap $${cap.toFixed(6)}`
    super(msg)
    this.name = 'BudgetExceededError'
    this.code = 'BUDGET_EXCEEDED'
    this.spent = spent
    this.cap = cap
  }
}

// createGovernor(innerBackend, ledger, opts)
//   innerBackend: the ledger-instrumented backend callable
//   ledger: the createLedger() instance (provides running cost snapshot)
//   opts.capUsd: the spend cap in USD; no cap if null
//
// Returns { agent, parallel, pipeline } — pass all three to runWorkflow as g.*
// to get full budget enforcement even inside concurrent barriers.
export function createGovernor(innerBackend, ledger, { capUsd = null } = {}) {
  if (typeof innerBackend !== 'function') throw new Error('createGovernor: innerBackend must be a callable')
  if (capUsd !== null && (typeof capUsd !== 'number' || capUsd <= 0)) {
    throw new Error('createGovernor: capUsd must be a positive number or null')
  }

  let tripped = false
  let tripSpent = null    // spend at first trip
  let tripCall = null     // which call index would have been next

  // Internal: check spend and throw if over cap.
  function checkBudget() {
    if (capUsd === null) return
    const snap = ledger.snapshot()
    const spent = snap.run.costUsd
    if (spent >= capUsd) {
      tripped = true
      if (tripSpent === null) {
        tripSpent = spent
        tripCall = snap.run.calls + 1
      }
      throw new BudgetExceededError(spent, capUsd)
    }
  }

  // ── governed agent ────────────────────────────────────────────────────────────
  // Pre-call check, then delegate. The ledger charges AFTER the call returns, so
  // the check here uses spend BEFORE this call — strictly conservative.
  async function agent(prompt, opts = {}) {
    checkBudget()
    return innerBackend(prompt, opts)
  }

  // ── budget-aware parallel ─────────────────────────────────────────────────────
  // Same semantics as makeParallel() for ordinary errors (swallow -> null), but
  // BUDGET_EXCEEDED is re-thrown so it surfaces at the workflow level.
  function parallel(thunks) {
    return new Promise((resolve, reject) => {
      const results = new Array((thunks || []).length).fill(null)
      if (!thunks || thunks.length === 0) { resolve(results); return }
      let remaining = thunks.length
      let budgetError = null

      thunks.forEach((thunk, i) => {
        Promise.resolve()
          .then(thunk)
          .then((v) => { results[i] = v })
          .catch((e) => {
            if (e && e.code === 'BUDGET_EXCEEDED') {
              // Re-throw budget errors — don't swallow them.
              budgetError = e
            }
            // ordinary errors: results[i] stays null
          })
          .finally(() => {
            remaining--
            if (remaining === 0) {
              if (budgetError) reject(budgetError)
              else resolve(results)
            }
          })
      })
    })
  }

  // ── budget-aware pipeline ─────────────────────────────────────────────────────
  // Same semantics as makePipeline() for ordinary errors, but BUDGET_EXCEEDED
  // short-circuits the entire pipeline (not just that item).
  function pipeline(items, ...stages) {
    return Promise.all(
      (items || []).map(async (item, index) => {
        let prev = item
        for (const stage of stages) {
          try {
            prev = await stage(prev, item, index)
          } catch (e) {
            if (e && e.code === 'BUDGET_EXCEEDED') throw e  // re-throw budget errors
            return null  // ordinary errors: drop item
          }
        }
        return prev
      }),
    )
  }

  agent.stats = () => ({
    cap: capUsd,
    spent: ledger.snapshot().run.costUsd,
    calls: ledger.snapshot().run.calls,
    tripped,
    tripSpent,
    tripCall,
  })

  return { agent, parallel, pipeline }
}

export default { createGovernor, BudgetExceededError }
