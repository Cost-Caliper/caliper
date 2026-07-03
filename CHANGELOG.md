# Changelog

All notable changes to Caliper. Versions map to `.claude-plugin/plugin.json`; the
in-app update pill compares against this repo. (Entries before 0.27.0 are
backfilled from commit history.)

## 0.27.0 — 2026-07-03

The redesign release: the dashboard is now the caliper.run design system, end to end.

### New UI (default)

- **caliper.run look & feel** — white/ink tokens, Geist + Geist Mono, hairline panels,
  one dark "anchor" KPI card per page; tier data-ink: opus=ink, fable=blue, sonnet/haiku=grays.
- **Drill-down IA** — Home → folder → session with a real breadcrumb (`›`), hash deep links,
  and browser back/forward. Session titles render as quoted **first prompts** (that's what they are).
- **All-folders page** (`#/folders`) — full list with filter box and five sorts
  (Spend / Sessions / $-per-session / Recent / Fallbacks); linked from Home's folder panel.
- **Session forensics** — waterfall of main + subagents on the real time axis (tier legend,
  hover tooltips), subagents ranked by cost, a plain-language "biggest single cost" insight line,
  and **per-run workflow timelines**: expand any run to reconstruct each agent call split into
  inference vs tool segments (lazy, on demand).
- **Guided tour** — ✦ Tour walks every panel across all three views with a spotlight and
  explanations; targets are chosen from your own data; first-visit hint; keyboard navigation.
  Enforced by a `tour-sync` test so UI changes can't silently orphan it.
- **Dark mode** — ☾/☀ toggle, persisted, respects `prefers-color-scheme`; charts re-render
  with theme-aware palettes.
- **"Nerfed" tracking** — Fable refusal/switch days marked with red dots on the daily chart
  (legend + tooltips); fallback panel with **⧉ Analyze reasons** and **⧉ Disable auto-fallback**
  copy-prompts, plus scope-aware **⧉ Optimize spend** buttons (machine / folder / session).
- **Live-data states** — boot progress, incremental machine scan ("scanning N/M"),
  per-session "Reconstructing…" panels, honest empty states.
- The previous UI is preserved at **`/legacy/`** for one release cycle.

### Server

- New session-scoped endpoints for the v2 UI: `GET /v1/session-scope/subagents`,
  `GET /v1/session-scope/observed`, and `GET /v1/session-scope/observed/:runId`
  (`?slug=&id=`), so any session — not just the active one — can be drilled into.

### Tooling

- `scripts/demo-data.mjs`: subagents now have staggered starts, multiple turns, and real
  durations so waterfalls render in demos and screenshots.
- New test: `test/tour-sync.test.mjs` (tour ↔ UI surface consistency).
- `docs/DEPLOYING.md`: the release checklist.

## 0.26.1 — 2026-07-02

- Mobbin-driven Home dashboard upgrade.

## 0.26.0 — 2026-07-02

- Fable-fallback: machine-wide subagent counts, banner, palette + design cleanup.

## 0.25.0 — 2026-07-01

- Fable refusal-fallback tracking + per-model cost attribution.

## 0.24.5 — 2026-07-01

- Pin dependencies exactly for supply-chain safety.

## 0.24.4 — 2026-07-01

- Security hardening: loopback-only server + local-origin guard.

## 0.24.3 — 2026-07-01

- Alpha tag, Auto-Router teaser, run-/caliper install hint.

## 0.24.2 — 2026-07-01

- Brand the dashboard with caliper.run identity (rename from workflow-lens).
