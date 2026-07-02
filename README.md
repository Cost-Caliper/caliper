# Caliper

**Precision for your AI spend.** See exactly where your Claude Code money goes — every session, workflow, subagent, and individual tool call — then feed it back to Claude to spend less. → [caliper.run](https://caliper.run)

![Caliper — machine-wide spend dashboard](docs/screenshots/home.png)

## Open source. Local. Yours.

- **100% local** — Caliper reads the transcripts Claude Code already writes to `~/.claude/projects` on your disk. Nothing leaves your machine. No telemetry, no account, no cloud.
- **Open source (MIT)** — every number is auditable. Costs are cache-aware estimates at real per-model rates, parity-tested against [ccusage](https://github.com/ryoppippi/ccusage), and the exact formula is shown in the UI next to the numbers.
- **You're in control** — drill from machine-wide totals down to the exact inference or tool call that spent the money, then turn what you find into cheaper future sessions.

## Install

```sh
/plugin marketplace add Cost-Caliper/caliper
/plugin install caliper@caliper
```

- **`/caliper`** — launch the dashboard (auto-pointed at your current session)
- **`/optimize-spend`** — Claude reads your real spend data and, with your consent, writes you a personalized cost-discipline skill

<details>
<summary>Upgrading from <code>workflow-lens</code> (pre-0.24)? The plugin was renamed — once per machine:</summary>

```sh
/plugin marketplace remove workflow-lens
/plugin marketplace add Cost-Caliper/caliper
/plugin install caliper@caliper
```
</details>

## What you get

| Sessions by folder & day | Session drill-down |
|---|---|
| ![Folder view](docs/screenshots/folder.png) | ![Session overview](docs/screenshots/session.png) |

- **Machine-wide analytics** — all-time spend, daily charts stacked by model, spend by repo (worktree-aware), cache economics.
- **Everything, not just workflows** — plain chat sessions, Workflow runs, subagents (nested too), full agent↔user conversations, per-step inference/tool timelines.
- **The optimization loop** — one click copies a prompt containing your real numbers, file paths, and live API pointers; paste it into Claude Code and it can analyze the spend, edit the workflow that caused it, or write you a cost skill.
- **Self-updating** — the dashboard checks this repo for new versions and offers a one-click update.

*Screenshots show bundled demo data (`node scripts/demo-data.mjs`) — your dashboard shows your own transcripts, locally.*

## How costs are computed

```
cost = input×in + cache_write_5m×in×1.25 + cache_write_1h×in×2.0 + cache_read×in×0.10 + output×out
```

at per-model rates (fable-5 $10/$50 · opus $5/$25 · sonnet $3/$15 · haiku $1/$5 per Mtok), with streamed duplicate usage deduplicated by request. These are **estimates reconstructed from transcripts, not invoices** — and the UI says so wherever a dollar appears.

## Repo layout

| Path | What it is |
|------|------------|
| `packages/control-tower/` | The Caliper dashboard: local web app + JSON API that reconstructs sessions, workflows, and subagents from transcripts. |
| `packages/workflow-lens/` | Workflow-file toolkit: parse, lint, instrument, replay, and estimate Claude Code `Workflow` scripts (keyless CLI + library). |
| `commands/`, `skills/` | `/caliper` (+ `/control-tower` alias), the `caliper` skill, `/optimize-spend`. |
| `scripts/` | Session-aware launcher, demo-data generator. |

Run from source with demo data:

```sh
node scripts/demo-data.mjs
WFLENS_PROJECTS_ROOT=/tmp/caliper-demo/projects PORT=8912 node packages/control-tower/server.mjs
```

Tests: `npm test` in each package — keyless, synthetic fixtures, zero API calls.

This plugin is the first Caliper tool. Roadmap: smart routing to open models, then custom models fine-tuned on your own usage — [caliper.run](https://caliper.run).

## License

MIT
