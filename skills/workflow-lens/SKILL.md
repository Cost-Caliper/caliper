---
name: workflow-lens
description: Use when the user wants to visualize, instrument, analyze, budget, replay, estimate, audit, or explain Claude Code Workflow and agent/subagent runs — including "can I trust this result?", "where did my money go?", "why was it slow?", "what did the subagents do?", "graph this workflow", "instrument my workflow", "estimate workflow cost", or "replay a workflow without spending tokens".
metadata:
  version: "0.1.0"
  user_invocable: "true"
---

# workflow-lens

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

## Run review lens

When the user asks about a previous agent, workflow, or subagent run, translate the trace
into three answers before showing raw details:

- **Can I trust this result?** Point to transcript-visible evidence: files read, searches,
  commands, tests, subagent prompts, tool results, and the final output. Be explicit that
  this is an audit trail, not a correctness proof.
- **Where did my money go?** Attribute estimated cost to the main conversation,
  workflows, subagents, model tiers, tokens, and cache reads/writes. Call out the biggest
  spender first.
- **Why was it slow?** Separate elapsed session span from actual launched work. Use the
  inference-vs-tool timeline to identify whether model inference, tool execution, or the
  main conversation span dominated.

## Pick the right tool

| The user wants… | Use |
|---|---|
| An interactive dashboard of their real recent workflow runs | The `/control-tower` command |
| A readable trust/money/speed explanation of an agent or subagent run | **Control Tower → Active Session → Run review** |
| A one-shot static HTML report / graph of a specific workflow file | `workflow-lens viz` |
| To know what a run *will* cost before running it | `workflow-lens estimate` |
| To run/replay a workflow with metering and a hard budget cap | `workflow-lens run` |
| To distill durable learnings from a live run | `workflow-lens learn` |

## Control Tower (the dashboard)

Use the `/control-tower` command to launch the dashboard. Do not hand-roll the server
startup from this skill; the command owns daemonization, dependency install, log file,
PID, URL extraction, and health checking.

After launch, use **Active Session → Run review** for a plain-language explanation of
trust, money, and speed. Use **Subagents** to inspect child agents, and **Workflows** to
inspect workflow-agent traces.

## workflow-lens CLI (keyless unless noted)

Use the installed-plugin-safe wrapper so paths and dependencies are deterministic:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-lens-cli.mjs" graph      <workflow.js> [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-lens-cli.mjs" lint       <workflow.js>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-lens-cli.mjs" estimate   <workflow.js> [--json]
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-lens-cli.mjs" instrument <workflow.js> [--check]
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-lens-cli.mjs" viz        <workflow.js> [--run run.json] [--out out.html]
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-lens-cli.mjs" run        <workflow.js> [--budget 0.01] [--replay c.json] [--out out/]
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-lens-cli.mjs" learn      <workflow.js> [--out out/]  # needs key
```

For local repo development, `node scripts/workflow-lens-cli.mjs ...` is equivalent.

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
