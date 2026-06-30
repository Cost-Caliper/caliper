# Control Tower — Smoke Test Evidence

Date: 2026-06-23

## Server Start

```
cd /Users/dennison/conductor/workspaces/agent-university/belgrade/claude-code/degrees/01-workflow-instrumentation/06-skill-pack/control-tower
set -a; . /Users/dennison/conductor/workspaces/agent-university/belgrade/.agent-university/secrets.local.env 2>/dev/null; . /Users/dennison/develop/agent-university/.agent-university/secrets.local.env 2>/dev/null; set +a
PORT=4319 node server.mjs &
```

Server startup log:
```
[registry] loaded 3 workflow(s)
[registry] loaded 1 cassette(s)
[control-tower] listening on http://localhost:4319
[control-tower] anthropic key: SET
[control-tower] openrouter key: SET
[control-tower] workflows: 3, cassettes: 1
```

Health check (`/v1/health`):
```json
{"ok":true,"lensVersion":"0.1.0","node":"v24.15.0","providers":{"anthropic":true,"openrouter":true},"workflowCount":3,"cassetteCount":1}
```

## Console-Clean Confirmation

`agent-browser errors` returned no output (zero JS errors) on http://localhost:4319.
CDN reference count in index.html / app.js / app.css / report.html: 0. No CDN, no external assets.

## Screenshots

- `/tmp/ct-initial.png` — initial dashboard load (dark, all 3 workflows in picker, no runs yet)
- `/tmp/ct-replay-done.png` — after Replay Cassette run of fixture-hello
- `/tmp/ct-live-done.png` — after Live Run of fixture-hello
- `/tmp/ct-final.png` — full Geist dark dashboard showing live run with timeline, graph, stats

## Replay Path (deterministic, free, 0 API calls)

- Workflow selected: `fixture-hello`
- Mode: Replay Cassette, cassette: `fixture-hello (1 calls)`
- Result: done, status=ok
- Per-call table populated from cassette:
  - label: greeter, tier: haiku, ms: 811ms (cassette recorded time), in: 15, out: 4, cost: $0.000035
  - requestId (from cassette): `req_011CcLg6XJrgsmgDxMeTSREn`
  - Wall-Clock: 0ms (cassette returns immediately — correctly labeled non-meaningful in replay)
  - Naive Sum: 811ms, Concurrency Speedup: 4053.50x (artifact of wall=0)
- 0 real API calls confirmed (cassette replay, no credentials consumed)

## Live Path (real Anthropic API call)

- Workflow: `fixture-hello`, Mode: Live Run, provider: anthropic
- Result: done, status=ok
- Per-call table:
  - label: greeter, tier: haiku, ms: 770ms (real wall-clock from shim ledger), in: 15, out: 4, cost: $0.000035
  - requestId (REAL, from Anthropic): `req_011CcLhF6dR7Mur2UBA9baZg`
  - Wall-Clock: 770ms, Naive Sum: 770ms, Speedup: 1.00x
- SSE events streamed: run-start, phase, agent-start, agent-end, rollup, done
- Workflow log: "Phase: Greet", "agent replied: ok"
- Lint badge: green "Lint Pass"
- Inline SVG graph rendered (no CDN): start -> phase: Greet -> agents -> greeter · haiku

## Optimization Path

- GET /v1/runs/2/optimize returned:
  ```json
  {"suggestions":[{"kind":"cap-budget","rationale":"This run cost $0.000035 across 1 call(s). A budget cap of $0.00007 (2x observed) would catch future regressions...","cites":["0.000035","1"],"proposedRunBody":{"capUsd":0.00007}}]}
  ```
  Every cite grounded in the run's ledger (no fabricated values).

- POST /v1/runs/2/apply-optimization with proposedRunBody={capUsd:0.00007}
  - Created run 3 with a REAL new API call
  - requestId: `req_011CcLhNKs6DBZYAYx3ChvqN`
  - status: ok, cost: $0.000035

## Learnings Path (Write Learnings)

- POST /v1/runs/2/learn triggered distillation via Anthropic haiku
- Learnings written to: learnings/2/learnings.md + learnings.json
- All facts grounded in run ledger (requestId req_011CcLhF6dR7Mur2UBA9baZg cited throughout)
- Includes: cost hotspots, slowest agents, patterns, recommendations, evidence caveat (n=1)

## Report HTML

- GET /v1/runs/2/report.html: self-contained HTML, no CDN references (grep count = 0)
- render.renderRun output confirmed

## Real Request IDs (evidence of real API calls)

| Run | Mode   | requestId                     |
|-----|--------|-------------------------------|
| 1   | replay | req_011CcLg6XJrgsmgDxMeTSREn (cassette) |
| 2   | live   | req_011CcLhF6dR7Mur2UBA9baZg |
| 3   | live (apply-opt) | req_011CcLhNKs6DBZYAYx3ChvqN |

## Known Gaps

- The `Write Learnings` UI button requires a live key (ANTHROPIC_API_KEY must be set) — fails closed otherwise with MISSING_CREDENTIAL.
- The `Apply Optimization` button's delta card only renders when the apply-opt run stream is observed in the same session. Direct API calls to apply-optimization produce correct results (run 3 confirmed above).
- The "Concurrency Speedup" card shows an artificially large number in replay mode (wall=0ms denominator); this is honest behavior — the footer explicitly labels replay timing as non-meaningful.
- The `learnings.runAndDistill` path uses an empty `traceLines: []` (no in-harness inject.mjs trace) — documented limitation in the learn endpoint.

## Teardown

Server killed after smoke test. Port 4319 is free.

## Independent Audit (2026-06-23)

Re-verified from scratch on PORT=4377 (secrets loaded), driven via agent-browser.

- Server started clean: `[control-tower] listening`, anthropic + openrouter keys SET, 3 workflows / 1 cassette.
- NO CDN — confirmed three ways: (1) `performance.getEntriesByType('resource')` on the live page lists only same-origin assets (`/app.css`, `/app.js`, `/fonts/*.woff2`, `/v1/*`), all 200; the only non-same-origin entry is an inline `data:` SVG (dropdown arrow); (2) report.html's only `http://` is the `w3.org` SVG namespace URI; (3) a `grep` sweep over `public/ server.mjs src/` finds no cdn/unpkg/jsdelivr/googleapis/@import.
- Fonts self-hosted: `/fonts/Geist-Variable.woff2` + `/fonts/GeistMono-Variable.woff2` load 200; computed `font-family` = Geist (sans) / Geist Mono (stat numbers, tabular-nums).
- Dark Geist tokens verified by computed style: bg `rgb(0,0,0)`, text `rgb(237,237,237)`, `data-theme=dark`. Light toggle flips to `#ffffff` / `#171717`.
- Replay path: fixture-hello cassette → 1 call, $0.000035, cassette requestId `req_011CcLg6XJrgsmgDxMeTSREn`, 0 real API calls.
- Live path: real Anthropic call → fresh requestId `req_011CcLhpaqyD4Y1AcbpcPepG` (≠ cassette, ≠ prior runs), wall from shim ledger, optimize + learnings panels appear.
- Fail-closed verified by test: POST /v1/runs live with no key → 412 MISSING_CREDENTIAL.
- `agent-browser errors` empty after full interaction (replay + live + theme + mode toggles).

### Fixes applied during audit

- **app.js — "saved" badge leaked across runs.** `updateStatCards` only ever set `statSavedBadge.hidden = false` and never reset it, and `resetTimeline` didn't clear it. After a replay run (wall=0 → bogus large saving), the badge stuck on "811 ms saved" into the next live run despite a real saving of ~0 / speedup 1.00×. Now hidden unless `concurrencySavingMs > 0.5`, and cleared on reset. Re-verified in-browser: badge correctly hides on the live run.
- **test/server.test.mjs — port-collision false reds.** The suite hardcoded port 8787 and, if anything answered `/v1/health` there, asserted against it. An unrelated local service on 8787 made all 7 server tests 404. The harness now self-starts its own Control Tower on a dedicated random port and only trusts a response whose `/v1/health` matches the Control Tower shape. `node --test test/*.test.mjs` → 12/12 green, with and without keys.
