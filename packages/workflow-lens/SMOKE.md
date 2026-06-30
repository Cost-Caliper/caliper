# workflow-lens smoke test — 2026-06-23

Captured during live integration run. All commands executed from
`/…/06-skill-pack/workflow-lens`. Secrets loaded from:
`set -a; . .agent-university/secrets.local.env 2>/dev/null; . /Users/dennison/develop/agent-university/.agent-university/secrets.local.env 2>/dev/null; set +a`

---

## 1. Dependencies

```
npm install
# → up to date, 0 vulnerabilities (acorn only dep)
```

---

## 2. Keyless CLI commands

### graph
```
node bin/workflow-lens.mjs graph examples/fanout.workflow.js
workflow: fixture-fanout
phases: 2 — Fan-out, Refine
agents: 3
  agent:1: (unlabeled) · haiku [parallel#1 · parallel]
  agent:2: draft · haiku [pipeline#2 · pipeline]
  agent:3: polish · haiku [pipeline#2 · pipeline]
edges: 3
```
Exit 0.

### lint
```
node bin/workflow-lens.mjs lint examples/fanout.workflow.js
lint OK — no findings
```
Exit 0. `lint bad/bad-banned-global.workflow.js` exits 1 with `[error] no-nondeterminism`.

### instrument
```
node bin/workflow-lens.mjs instrument examples/fanout.workflow.js --check
wrapped call sites (5):
  line 13: parallel
  line 14: agent model="haiku"
  line 20: pipeline
  line 22: agent label="draft" model="haiku"
  line 23: agent label="polish" model="haiku"
```
`--out out/fanout.instrumented.workflow.js` writes the file; lint of instrumented output passes clean.

### viz
```
node bin/workflow-lens.mjs viz examples/fanout.workflow.js --out out/graph.html
wrote .../out/graph.html
```
HTML is self-contained: 0 CDN/script-src references, 1 `<script type="application/json">` (data only), inline `<svg>`.

### estimate
```
node bin/workflow-lens.mjs estimate examples/fanout.workflow.js
workflow: fixture-fanout
agents: 3 | models: {"haiku":3}
cost estimate: $0.00018000 [$0.00006000 – $0.00054000] (±200%)
wall-clock estimate: 2400ms [800ms – 7200ms]
```
Keyless static AST estimate. Exit 0.

---

## 3. Live CLI commands (real Anthropic haiku calls)

### run — hello workflow (Anthropic)
```
node bin/workflow-lens.mjs run examples/hello.workflow.js --out out/run-hello --max-tokens 32
calls: 1 | cost: $0.000035 | wall: 708.2ms | sum: 708.1ms | speedup: 1x
```
Request ID: `req_011CcLePn7LLjYv3ga3CCpox`
Artifacts: `out/run-hello/graph.json`, `telemetry.json`, `run.html`

### run — fanout workflow (Anthropic, 12 haiku calls)
```
node bin/workflow-lens.mjs run examples/fanout.workflow.js --out out/run-fanout --max-tokens 32
calls: 12 | cost: $0.001405 | wall: 5854.4ms | sum: 14334ms | speedup: 2.45x
```
First 3 request IDs:
- `req_011CcLeQXTZLoR5V47Mw1JPD` (fact:forests, haiku, $0.000086, 676.6ms)
- `req_011CcLeQXpP95vzFvoSsvmzo` (fact:deserts, haiku, $0.000092, 825.8ms)
- `req_011CcLeQXWXt8FsQYvr48Ktf` (fact:oceans, haiku, $0.000087, 999.5ms)

`run.html` embeds: 14 `req_` occurrences, 2 inline SVG elements, 0 CDN references.
Concurrency saving: 8479.6ms vs naive serial sum.

### run — OpenRouter (gpt-4o-mini)
```
node bin/workflow-lens.mjs run examples/hello.workflow.js --provider openrouter --out out/run-openrouter --max-tokens 16
calls: 1 | cost: $0.000025 | wall: 1047.9ms | sum: 1047.9ms | speedup: 1x
```
Served model in telemetry: `openai/gpt-4o-mini` — confirms NON-Anthropic routing via OpenRouter.

### run — fail-closed (no key)
```
ANTHROPIC_API_KEY= node bin/workflow-lens.mjs run examples/fanout.workflow.js
MISSING_CREDENTIAL: ANTHROPIC_API_KEY is required (set it or use --replay <cassette>)
# exit 1 — confirmed by CLI smoke test
```

### learn — hello workflow
```
node bin/workflow-lens.mjs learn examples/hello.workflow.js --out out/learnings --max-tokens 24
workflow: greeter
trace records: 2 | ledger calls: 1
top hotspot: greeter — $0.000035
patterns: 3
artifacts written to .../out/learnings/
```
Distiller request ID: `req_011CcLeTByciPF7fibBgtd6M`
Run agent request ID (cited in learnings.json): `req_011CcLeT4Zdaoqo543gufS7f`
`costHotspots[0].cites`: `["req_011CcLeT4Zdaoqo543gufS7f", "0.000035"]` — grounded in real trace.

`learnings.md` content summary:
- Cost hotspot: greeter, $0.000035
- Slowest agent: 1899.3ms
- 3 patterns (all cite real ledger numbers)
- 2 recommendations (all cite real facts)

---

## 4. examples/demo.mjs

```
node examples/demo.mjs
=== workflow-lens demo ===
lint: OK (no findings)
graph: fixture-fanout / phases: Fan-out, Refine / agents: 3
pre-flight estimate: $0.00018000 [$0.00006000 – $0.00054000]
running live (12 haiku calls via fanout.workflow.js)…
  calls: 12 | costUsd: $0.00138 | wallMs: 4049.1ms | sumMs: 14235.6ms
  speedup: 3.52x | concurrencySaving: 10186.5ms
  firstRequestId: req_011CcLeUjYSqznPRFirLB7hs
report: .../examples/out/demo-report.html
Demo complete (live path).
```

---

## 5. npm test (all suites)

```
npm test   # node --test test/*.test.mjs
ℹ tests 109
ℹ pass  109
ℹ fail    0
duration: ~412ms
```

All 109 tests pass. Breakdown by suite (all keyless, offline):
- ast.test.mjs: 11 tests (buildGraph + lint)
- inject.test.mjs: 14 tests (transform: idempotent, lints clean, behavior-unchanged, arg-once)
- codegen.test.mjs: 9 tests (emit round-trips, emitted file runs, fixed-point)
- render.test.mjs: 6 tests (no CDN, inline SVG, no bare '#' regression)
- shim.test.mjs: 7 tests (makeParallel/Pipeline/Budget semantics, compileWorkflow)
- gate.test.mjs: 8 tests (cache hit, HITL deny, fail-closed MISSING_CREDENTIAL, hashCall)
- governor.test.mjs: 5 tests (BUDGET_EXCEEDED re-thrown through parallel + pipeline barriers)
- router.test.mjs: 8 tests (classify + routeTier easy-vs-hard, createRouter)
- cassette.test.mjs: 5 tests (record->save->load->replay=0 real calls, CACHE_MISS)
- estimate.test.mjs: 12 tests (analyzeGraph, estimate, compare inBand on fixtures)
- learnings.test.mjs: 13 tests (groundingCheck rejects fabricated/empty cites)
- cli.smoke.test.mjs: 11 tests (spawns bin/ — graph/lint/instrument/viz/estimate/run-fail-closed)

---

## Summary

| Command | Mode | Status | Evidence |
|---|---|---|---|
| `lint` | keyless | PASS | exit 0 clean / exit 1 bad |
| `graph` | keyless | PASS | correct phase/agent/edge counts |
| `instrument` | keyless | PASS | 5 sites wrapped; lints clean |
| `viz` | keyless | PASS | self-contained HTML, no CDN |
| `estimate` | keyless | PASS | ±200% band printed |
| `run` (Anthropic) | LIVE | PASS | `req_011CcLePn7LLjYv3ga3CCpox` |
| `run` (fanout 12 calls) | LIVE | PASS | `req_011CcLeQXTZLoR5V47Mw1JPD` + 11 more |
| `run` (OpenRouter) | LIVE | PASS | `openai/gpt-4o-mini` confirmed |
| `run` (no key) | LIVE | PASS (FAIL CLOSED) | `MISSING_CREDENTIAL` exit 1 |
| `learn` | LIVE | PASS | distiller `req_011CcLeTByciPF7fibBgtd6M`; grounded cites |
| `node examples/demo.mjs` | LIVE | PASS | `req_011CcLeUjYSqznPRFirLB7hs`; 3.52x speedup |
| `npm test` | offline | PASS | 109/109 |
