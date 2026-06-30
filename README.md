# workflow-lens

Observability for **Claude Code `Workflow` runs** — visualize, instrument, budget, replay,
and estimate the cost of the single-file `export const meta` + injected-globals workflow
format. Ships as a **Claude Code plugin** with two tools and one slash command.

> A Claude Code workflow is one plain-JS file whose body uses 8 injected globals
> (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow`).
> workflow-lens operates on that file **unmodified**.

## What's in here

| Path | What it is |
|------|------------|
| `packages/workflow-lens/` | Keyless CLI + library: parse, lint, instrument, run/replay, estimate, and render workflows to a **self-contained HTML report** (inline SVG graph + concurrent-agent timeline + cost/token telemetry — no CDN, opens offline). |
| `packages/control-tower/` | A dark web dashboard over workflow-lens. **Observe (native)** tab visualizes *real* `Workflow` runs the harness wrote to disk; **Control (shim)** tab runs/replays sample workflows with live telemetry, a budget governor, a cost router, and a cache/HITL gate. |
| `commands/control-tower.md` | The `/control-tower` slash command — launches the dashboard pointed at your current session. |
| `skills/workflow-lens/` | A skill teaching Claude how and when to use both tools. |
| `scripts/launch-control-tower.mjs` | Session-aware launcher used by the command. |

`control-tower` depends on `workflow-lens` as a sibling (`file:../workflow-lens`); keeping
them under `packages/` preserves every relative import unchanged.

## Use it as a Claude Code plugin

```sh
# Add this repo as a marketplace, then install the plugin
/plugin marketplace add dennisonbertram/workflow-lens
/plugin install workflow-lens@workflow-lens
```

Then run **`/control-tower`** in any session. It installs deps on first run, auto-discovers
the newest run-bearing session (preferring the current project), and starts the dashboard
at `http://localhost:8787` with the **Observe (native)** tab pointed at your real runs.

## Use the dashboard directly

```sh
node scripts/launch-control-tower.mjs                 # auto-discover current session
node scripts/launch-control-tower.mjs --port 9000
node scripts/launch-control-tower.mjs --session-dir ~/.claude/projects/<proj>/<session>
```

The **Observe** tab needs a directory containing `workflows/wf_*.json` (+
`subagents/workflows/wf_*/`) — where the `Workflow` tool writes run artifacts. Cost there
is reconstructed from transcripts (cache_creation ×1.25, cache_read ×0.10), so it is an
estimate, not a billed figure.

## Use the CLI directly

```sh
cd packages/workflow-lens && npm install
node bin/workflow-lens.mjs graph    examples/fanout.workflow.js
node bin/workflow-lens.mjs viz      examples/fanout.workflow.js --out graph.html
node bin/workflow-lens.mjs estimate examples/fanout.workflow.js
# live (needs ANTHROPIC_API_KEY; fails closed without one):
node bin/workflow-lens.mjs run      examples/fanout.workflow.js --budget 0.01 --out out/
```

See `packages/workflow-lens/README.md` for the full command table, library API, and the
honest caveats (timing comes from an external shim clock, not the in-harness trace; cost is
metered from price tables, not a billing API).

## Develop

```sh
# workflow-lens (keyless suite)
cd packages/workflow-lens && npm install && node --test test/*.test.mjs

# control-tower (set WFLENS_TEST_SESSION_DIR to a real session dir to exercise the
# native-observe fixtures; otherwise those tests skip and the unit tests run)
cd packages/control-tower && npm install && node --test test/*.test.mjs
```

Node ≥ 20 required. All source is ESM `.mjs`.

## Provenance

Extracted from the `01-workflow-instrumentation` degree of [Agent
University](https://github.com/) — consolidated from that degree's live-verified POCs — and
repackaged here as a standalone, buildable Claude Code plugin.

## License

MIT — see [LICENSE](./LICENSE).
