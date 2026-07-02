# Caliper

**Precision for your AI spend** — [caliper.run](https://caliper.run)

Caliper shows you exactly where your Claude Code money goes. It reconstructs **every
session, workflow, and subagent** on your machine from the harness's own transcripts —
no telemetry, no cloud, runs entirely locally — and gives you:

- **Machine-wide analytics**: all-time spend, daily charts stacked by model, spend by
  repo, cache economics ($ figures are cache-aware estimates at real per-model rates,
  cross-checked against ccusage).
- **Drill-down to the exact step**: folder -> session -> workflow -> agent -> the specific
  inference or tool call, with full conversations and timelines.
- **The optimization loop**: one click copies a data-grounded prompt back into Claude
  Code asking it to cut your costs — or use the bundled `/optimize-spend` skill and let
  Claude read the data itself and write you a personalized cost-discipline skill.

This plugin is the first Caliper tool. Roadmap: smart routing to open models, then
custom models fine-tuned on your own usage — see [caliper.run](https://caliper.run).

## Install

```sh
/plugin marketplace add Cost-Caliper/caliper
/plugin install caliper@caliper
```

Then launch the dashboard with **`/caliper`** (or `/control-tower`, its alias), and try
**`/optimize-spend`**. The dashboard checks GitHub for updates and offers a one-click
update when a new version ships.

### Upgrading from `workflow-lens` (pre-0.24)

The plugin was renamed. Once per machine:

```sh
/plugin marketplace remove workflow-lens
/plugin marketplace add Cost-Caliper/caliper
/plugin install caliper@caliper
```

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
/plugin marketplace add Cost-Caliper/caliper
/plugin install caliper@caliper
```

Then run **`/control-tower`** in any session. It installs deps on first run, auto-discovers
the newest run-bearing session (preferring the current project), and starts the dashboard on
a **random free high port** (printed at launch — it won't collide with your own dev servers)
with the **Observe (native)** tab pointed at your real runs.

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
