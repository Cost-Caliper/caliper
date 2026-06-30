# Workflow learnings: fixture-hello

_Provenance: 0 trace records, 1 ledger calls, hasLedger=true, hasGateStats=false_

## Cost hotspots
- **greeter** (claude-haiku-4-5-20251001, phase: none): $0.000035 (req_011CcLhF6dR7Mur2UBA9baZg, 0.000035)

## Slowest agents
- **greeter** (claude-haiku-4-5-20251001): 769.9ms (req_011CcLhF6dR7Mur2UBA9baZg, 769.9)

## Patterns
- Single unphased call (phase:null) with no parallelism; concurrencySavingMs is 0 and speedup is 1, indicating sequential execution only. (phase:null, 0, 1)
- Wall-clock time equals sum of call times (wallMs 769.9 = sumMs 769.9), confirming no concurrent thunks. (769.9, 769.9)
- Input and output token counts are minimal: 15 inTok, 4 outTok, suggesting a simple greeting interaction. (15, 4)

## Recommendations
- **Collect multi-run telemetry before optimizing; this single execution does not reveal variance or structural inefficiencies.**: Single run (n=1) cannot support trend or performance regression analysis. Latency (769.9 ms) may be normal for model initialization; repeated runs would clarify. (single run (n=1))
- **If future workflows include multiple independent calls, instrument them as concurrent phases to measure parallelism benefit.**: Current workflow has no phase labels and no concurrency (speedup=1). Structured phases enable speedup quantification. (speedup:1, phase:null)

## Evidence
_single run (n=1); facts are this run only, not a trend_

_Notes: No trace events recorded (traceLines empty); cost and latency rely entirely on ledger. No errors. Haiku model tier is cost-efficient at 0.000035 USD. Workflow is a single greeter call with no branching or retries observed._