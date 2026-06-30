# Workflow learnings: claude-code-instrumented

_Provenance: 0 trace records, 1 ledger calls, hasLedger=true, hasGateStats=false_

## Cost hotspots
- **greeter** (claude-haiku-4-5-20251001, phase: none): $0.000035 (req_011CcLruGjEdKoKzTVK6RdyX, 0.000035)

## Slowest agents
- **greeter** (claude-haiku-4-5-20251001): 761.6ms (req_011CcLruGjEdKoKzTVK6RdyX, 761.6)

## Patterns
- Single unphased call dominates run; no parallelism detected (concurrencySavingMs: -0.1, speedup: 1). (concurrencySavingMs: -0.1, speedup: 1, phase: null)
- Wall time matches sum of call durations (761.7 ms wall vs 761.6 ms summed), indicating sequential execution. (wallMs: 761.7, sumMs: 761.6)

## Recommendations
- **Baseline cost/latency established. For future runs, compare against 0.000035 USD per single haiku call and 761.6 ms latency.**: This is a minimal single-call workflow with no trace instrumentation (0 traceLines). Use as a cost and latency floor for the greeter task. (0.000035, 761.6, traceRecords: 0)

## Evidence
_single run (n=1); facts are this run only, not a trend_

_Notes: No trace records captured; ledger-only visibility. Single call, no phases, no failures. Wall clock dominated by call latency (761.6 ms from haiku model end-to-end). No concurrency overhead or savings._