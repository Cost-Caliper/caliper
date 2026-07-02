---
name: caliper
description: Caliper (caliper.run) — use when the user wants to see where their Claude Code spend goes, visualize sessions/workflows/subagents, launch the Caliper dashboard, or instrument/replay/estimate Workflow runs — the single-file `export const meta` + injected-globals format. Triggers include "visualize my workflow", "launch caliper", "launch control tower", "show me what that workflow run cost", "graph this workflow", "instrument my workflow", "estimate workflow cost", "why was that workflow slow", or "replay a workflow without spending tokens".
version: 0.1.0
user_invocable: true
---

# Caliper (workflow-lens tools)

Two tools for seeing inside Claude Code `Workflow` runs:

- **`workflow-lens`** (`packages/workflow-lens/`) — a keyless CLI + library that parses,
  lints, instruments, runs/replays, estimates, and renders workflow files to a
  self-contained HTML report (inline SVG graph + concurrent-agent timeline + cost/token
  telemetry). No CDN, works offline.
- **Control Tower** (`packages/control-tower/`) — a dark web dashboard over workflow-lens.
  Its **Observe (native)** tab visualizes *real* `Workflow` runs the harness already wrote
  to disk; its **Control (shim)** tab runs/replays bundled sample workflows with live
  telemetry, a budget governor, a cost router, and a cache/HITL gate.

A Claude Code workflow is ONE plain-JS file whose body uses 8 injected globals
(`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`).
workflow-lens operates on that file **unmodified**.

## Pick the right tool

| The user wants… | Use |
|---|---|
| An interactive dashboard of their real recent workflow runs | **Control Tower** → run `/control-tower` (or `node scripts/launch-control-tower.mjs`) |
| A one-shot static HTML report / graph of a specific workflow file | `workflow-lens viz` |
| To know what a run *will* cost before running it | `workflow-lens estimate` |
| To run/replay a workflow with metering and a hard budget cap | `workflow-lens run` |
| To distill durable learnings from a live run | `workflow-lens learn` |

## Control Tower (the dashboard)

```sh
node scripts/launch-control-tower.mjs            # auto-discovers the current session
node scripts/launch-control-tower.mjs --port 9000  # pin a port (default is a random free high port)
node scripts/launch-control-tower.mjs --session-dir ~/.claude/projects/<proj>/<session>
```

Start it **in the background** (long-running server). It binds to a **random free high
port** so it won't clash with the user's own dev servers — read the actual URL from the
launcher's `[launch] starting Control Tower on http://localhost:<port>` line, then confirm
with `curl -fsS http://localhost:<port>/v1/health` and report that URL to the user. The
**Observe (native)** tab needs a session dir containing `workflows/wf_*.json` (+
`subagents/workflows/wf_*/`) — that is where the `Workflow` tool writes run artifacts. Cost
shown there is reconstructed from transcripts with the cache-aware convention
(cache_creation ×1.25, cache_read ×0.10), so it is an estimate, not a billed figure.

## workflow-lens CLI (keyless unless noted)

```sh
cd packages/workflow-lens
node bin/workflow-lens.mjs graph     <workflow.js> [--json]      # static AST graph
node bin/workflow-lens.mjs lint      <workflow.js>               # resume-safety lint
node bin/workflow-lens.mjs estimate  <workflow.js> [--json]      # pre-flight cost/wall (±200%)
node bin/workflow-lens.mjs instrument <workflow.js> [--check]    # splice telemetry prelude
node bin/workflow-lens.mjs viz       <workflow.js> [--run run.json] [--out out.html]
node bin/workflow-lens.mjs run       <workflow.js> [--budget 0.01] [--replay c.json] [--out out/]
node bin/workflow-lens.mjs learn     <workflow.js> [--out out/]  # needs key
```

`run` / `learn` / `estimate --calibrate` need `ANTHROPIC_API_KEY` (or
`OPENROUTER_API_KEY` with `--provider openrouter`) and **fail closed** with
`MISSING_CREDENTIAL` when absent — they never fabricate output. `run --replay <cassette>`
is the one keyless run mode (0 API calls).

## Honest caveats to relay

- **Timing comes from the external shim, not the in-harness trace.** Under the real
  harness, `Date.now()`/`Math.random()` throw (resume-safety), so the instrumented trace
  captures call *structure* only. Every `ms`/speedup number in a report comes from running
  the file outside the harness under a real clock.
- **Cost is metered from price tables**, not a live billing API — invoiced cost may differ.
- The HTML report is fully self-contained (inline SVG, no CDN) and opens offline.

See `packages/workflow-lens/README.md` for the full CLI table and library API.
