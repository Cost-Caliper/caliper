# workflow-lens

Run, instrument, visualize, route, budget, record/replay, estimate, and distill Claude Code workflow files — the single-file `export const meta` + injected-globals format.

A Claude Code workflow is ONE plain-JS file:

```js
export const meta = { name: 'my-workflow', description: '...', phases: [...] }

phase('Fan-out')
const facts = await parallel(topics.map(t => () => agent(`fact about ${t}`, { model: 'haiku' })))

phase('Refine')
const refined = await pipeline(facts.filter(Boolean),
  fact => agent(`tweet this: "${fact}"`, { label: 'draft', model: 'haiku' }),
  draft => agent(`add emoji: "${draft}"`, { label: 'polish', model: 'haiku' }),
)
return { facts, refined }
```

The body uses 8 injected globals: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`. `workflow-lens` runs, instruments, and transforms that file UNMODIFIED.

## Install

```sh
npm install   # installs acorn (the only dependency)
node bin/workflow-lens.mjs --help
```

Node >= 20 required (built on v24). All source is ESM `.mjs`.

## Quick start (keyless)

```sh
node bin/workflow-lens.mjs lint examples/fanout.workflow.js
node bin/workflow-lens.mjs graph examples/fanout.workflow.js
node bin/workflow-lens.mjs estimate examples/fanout.workflow.js
node bin/workflow-lens.mjs instrument examples/fanout.workflow.js
node bin/workflow-lens.mjs viz examples/fanout.workflow.js --out graph.html
```

None of these commands need an API key. They work offline.

## Live commands (need a key)

Load your key first:

```sh
# Anthropic (default provider):
export ANTHROPIC_API_KEY=sk-ant-...

# OpenRouter (for non-Anthropic backends):
export OPENROUTER_API_KEY=sk-or-...
```

Then:

```sh
# Run the workflow and write a report
node bin/workflow-lens.mjs run examples/fanout.workflow.js --out out/

# Run with a hard budget cap ($0.01)
node bin/workflow-lens.mjs run examples/fanout.workflow.js --budget 0.01 --out out/

# Record a cassette for later keyless replay
node bin/workflow-lens.mjs run examples/fanout.workflow.js --record cassette.json

# Replay from cassette (ZERO real API calls — the only keyless run mode)
node bin/workflow-lens.mjs run examples/fanout.workflow.js --replay cassette.json

# Instrument -> run -> distill durable grounded learnings
node bin/workflow-lens.mjs learn examples/fanout.workflow.js --out out/learnings/
```

**Live commands FAIL CLOSED with `MISSING_CREDENTIAL` when the key is absent — they never fabricate output.** `run --replay <cassette>` is the one keyless run mode.

## CLI command table

| Command | Usage | Keyless? | What it does |
|---------|-------|----------|--------------|
| `graph` | `graph <workflow.js> [--json]` | Yes | Static AST graph (metaName, phases, agents, edges). `--json` prints raw object. |
| `lint` | `lint <workflow.js>` | Yes | Resume-safety lint. Exit 0 = clean, exit 1 = findings. |
| `instrument` | `instrument <workflow.js> [--out <file>] [--check]` | Yes | Splice `__trace` prelude around every agent/parallel/pipeline call. `--check` prints sites without writing. |
| `viz` | `viz <workflow.js> [--run <run.json>] [--out <run.html>]` | Yes (graph only) | Render self-contained HTML report. `--run` adds telemetry tables. Inline SVG, no CDN. |
| `run` | `run <workflow.js> [opts]` | `--replay` only | Execute under shim+ledger+gate. Options: `--provider`, `--budget`, `--record`, `--replay`, `--out`, `--max-tokens`. |
| `estimate` | `estimate <workflow.js> [--calibrate] [--json]` | Yes (no `--calibrate`) | Pre-flight cost/wall estimate (±200% band). `--calibrate` seeds table from a live haiku call (needs key). |
| `learn` | `learn <workflow.js> [--out <dir>] [--max-tokens <n>]` | No | Instrument -> run live -> distill durable grounded learnings. Writes `learnings.json` + `learnings.md`. |
| `watch` | `watch [<watchDir>] [<outDir>]` | Yes | Long-running `fs.watch`: auto-instruments `*.workflow.js` on add/change. |

## Library API

```js
import {
  lint, buildGraph, estimate,           // keyless static analysis
  createLedger, anthropicBackend,       // runtime metering
  createGate, runWorkflow,              // execution
  renderRun,                            // HTML report
  transform,                            // AST instrumentation
  emit,                                 // graph -> workflow JS
  createGovernor,                       // hard budget cap
  createRouter, classify,               // cost-aware model routing
  createRecorder, loadCassette,         // record/replay
  compare, runLive,                     // pre-flight calibration
  distillLearnings, groundingCheck,     // durable learnings
} from './src/index.mjs'
```

See `examples/demo.mjs` for a worked end-to-end example using the library API:

```sh
node examples/demo.mjs           # keyless: lint + graph + estimate + skip live run
ANTHROPIC_API_KEY=sk-ant-... node examples/demo.mjs  # full run + HTML report
```

Per-module sub-exports are available for tree-shaking:
`workflow-lens/ast`, `workflow-lens/gate`, `workflow-lens/ledger`, etc.

## Self-contained, no CDN

The `viz` command and `renderRun()` produce a single `.html` file with an **inline SVG** workflow graph. No Mermaid CDN, no external scripts — opens correctly in any browser, including offline. This was the result of two real browser failures the test suite guards against:

1. Unquoted `#` in Mermaid container IDs caused syntax errors (`parallel#1` -> parse error).
2. CDN-blocked offline use dumped raw Mermaid source as text instead of rendering a graph.

The graph is now always a self-contained `<svg>` element. Mermaid source is still embedded as a collapsible `<details>` reference.

## The honest harness-timing caveat

Two complementary observability paths — they are NOT redundant:

**In-harness tracer** (`instrument` / `transform`):

Captures call **structure** — order, counts, static label/model/phase, arg shape (thunk count, item count, stages), and ok/fail/null — all via `log()`, the only harness-safe output channel. It **cannot** capture wall-clock: under the real harness, `Date.now()`, argless `new Date()`, and `Math.random()` all **throw** (resume-safety enforcement), and `ast.lint()` enforces this. The `__trace` prelude is purposely clock-free so the instrumented file still passes lint and is resume-safe.

**External shim runtime** (`run` + `createLedger`):

Runs the same file OUTSIDE the harness under a real monotonic clock, so per-call `ms`, wall-clock, and the concurrency-saving gap are real measurements. Cost is metered from the Anthropic/OpenRouter price tables (not a live billing API) — invoiced cost may differ slightly.

**Therefore:** every `ms` / speedup number in `run.html` and `learnings.md` comes from the shim ledger, NOT from the in-harness trace. The report header says so.

## Honest scope of codegen

`emit(graph)` handles the structured subset: pure-literal `meta`, `phase()` calls, `agent()` with literal prompt + opts, `parallel()` of N agents, `pipeline()` over a literal item list. It does NOT re-emit arbitrary author JS (loops, helper vars, `.map()` thunks). Those survive `buildGraph()`'s static view but are out of scope for re-emission — the emitted file is plain, canonical, and always passes `ast.lint()`.

## Testing

```sh
node --test test/*.mjs    # 109 keyless tests, fully offline, no API key needed
npm run demo              # library demo (keyless path works without a key)
npm run lint:self         # lint examples/fanout.workflow.js via the CLI
```

All keyless suites run offline with stub backends. Live paths (`run`/`learn`/`estimate --calibrate`) are exercised only when a key is present. `cli.smoke.test.mjs` spawns the bin and includes a fail-closed assertion: `run` without a key must exit non-zero with `MISSING_CREDENTIAL`.

## License / provenance

MIT. Consolidated from the `01-workflow-instrumentation` degree's live-verified POCs (A1-A7 + L-capstone, Agent University). Acorn is a normal dependency (`npm i` installs it). No other runtime dependencies.
