# STORY-064 — Trace a dollar end-to-end

**Verdict: FAIL** (critical navigation bug on repeat use; downstream trace/drawer/composition all pass on their own)

**Persona**: Engineer tracing a single dollar from the leaderboard down to the exact inference step that spent it.

**Session used**: `~/develop/agent-university` → "Feed: call this agent 'Agent University'…" (main conversation + 15 workflows + 3 subagents, $265 total est.)

## Walk

1. Opened the rich session, landed on Active Session. Scrolled to the Session Insight card's Pareto leaderboard.
2. **Noted a data-shape deviation from the story script**: the single biggest bar in the leaderboard is **"main conversation (this chat)" at $97.64 (37%)**, not a workflow. The story instructs "insight leaderboard biggest bar → ... → auto-expand in the Workflows tab" — but per the app's own documented behavior (STORY-019/067), clicking the main-conversation bar correctly routes to the *main trace*, not the Workflows tab. To exercise the intended workflow-tracing path faithfully, I traced the **biggest workflow bar** instead: "degree-build $40.21 (15%)" (16m 0s, 24 agents) — the second-largest bar overall and the largest that is a workflow run.
3. **First click (fresh browser session, first navigation)**: clicked the "degree-build $40.21 15%" bar. URL hash changed to `#/observe/738d4acc-35fb-492c-bcec-153e4b8d1d68`, Workflows tab activated, and the correct row ("degree-build", Jun 8 8:51 PM, 24 agents, $40.21, 16m 0s) expanded (`aria-expanded="true"`, chevron `▼`) with a faint residual background tint consistent with a fading flash animation, captured mid-fade. **This part worked as specified**, including the flash.
4. **Repeat click (same run, after navigating back to Active Session and re-clicking the same bar)**: same hash `#/observe/738d4acc-...` was set, Workflows tab activated — but this time **the target row did NOT expand** (`aria-expanded="false"` on all rows) and a **different, unrelated row got a stray highlight** ("degree-poc", Jun 8 9:22 PM, $1.35, 2 agents — not the clicked $40.21 item). Reproduced this **three times** across two separate browser sessions (including one fresh `agent-browser` session with the very run started once and then a single subsequent re-click) — the pattern is consistent: **first navigation to a given run auto-expands correctly; any subsequent re-navigation to the same run (via Active Session → click the bar again) silently fails to expand and does not scroll to/highlight the correct row.**
   - This is a genuine, reproducible bug, not a fluke — see `screenshots/04-BUG-no-autoexpand.png` and `screenshots/06-BUG-repeat-click-no-expand.png`, and the raw DOM dumps in the session transcript (`aria-expanded` false on the target row both times, hash unchanged both times, no console/network errors in either case).
   - Likely root cause (external observation only, no source read): the expand/scroll/flash logic is probably keyed off a hash-*change* event; because the hash resolves to the identical value on re-click when returning to the same run, no change fires and the effect never re-runs. This would explain why it fails specifically on re-visiting the *same* run and not on first visits to *new* runs.
5. **Manually expanded** the target row (clicking its own disclosure toggle) to continue the trace, since the auto-expand had failed. Per-call table appeared with 24 rows: 12 `build:*` (opus-4-8, "Scaffold" phase) + 12 `audit:*` (haiku-4-5-20251001, "Audit" phase).
6. **Composition check #1 — call costs vs. run cost**: summed all 24 row costs from the table: $2.26+$4.72+$4.98+$2.26+$2.32+$4.18+$2.36+$1.81+$4.10+$4.28+$2.41+$4.30+$0.027+$0.025+$0.018+$0.021+$0.017+$0.020+$0.024+$0.014+$0.016+$0.019+$0.015+$0.020 = **$40.216**, vs. the run's stated cost **$40.208965** (displayed "$40.21"). Match to within $0.007 (rounding across 24 two-decimal display values) — **composes correctly**.
7. **Found the priciest call**: row #3, `build:gemini` (opus-4-8, Scaffold, 14m 56s, In 13K, Out 38K) at **$4.98** — the single most expensive call in this run.
8. **Clicked the row**: opened a "Call details" drawer directly — model `opus-4-8`, phase `Scaffold`, wall `14m 56s`, **cost `$4.977140`**, tok `13,049→37,764`, cache `141,216wr/6,170,391rd`, turns `80`, tool calls `64`, full task prompt and last-assistant-text shown. This is the agent-level rollup drawer (triggered by row click), distinct from a single-step drawer.
9. **Found the priciest-looking step within that agent's timeline**: used the Timeline chart's per-agent segment bars (row for build:gemini) and identified the longest inference segment: "Inference step 75 · 26 s". Clicked it (via a synthetic click dispatched at its exact screen coordinates, since the segment has no visible text label — this is a fine-grained SVG hit-target, expected to work with a real mouse click at the same coordinates).
10. **Step-level drawer opened**: "Inference step" — build:gemini, Inference · 26s, "decided to call: Write", output **1,954 tok**, input **2 tok**, cache-read **118K**, cache-write **1K**, **cost $0.115**, speed 76 tok/s, stop `tool_use`, model `opus-4-8`. Model output panel correctly shows "(no text — this step only emitted a tool call)" since the step was tool-only.

## Composition check #2 — step cost vs. formula (manual reproduction)

Using the exact formula from STORY-060's methodology (`cost = input×in + cache_write_5m×in×1.25 + cache_read×in×0.10 + output×out`) and opus list prices ($5/M in, $25/M out, $6.25/M cache-write, $0.50/M cache-read):

```
input:       2 × $5/M      = $0.00001
cache-write: 1,000 × $6.25/M = $0.00625
cache-read:  118,000 × $0.50/M = $0.05900
output:      1,954 × $25/M   = $0.04885
-----------------------------------------
total                        = $0.11411 → rounds to $0.114–0.115
```

Displayed step cost: **$0.115**. Computed: **$0.1141**. **Match to the cent.** This is strong, independent confirmation that the formula shown in the STORY-060 methodology panel is the *actual* formula used to compute displayed costs — not decorative copy.

## Overall composition verdict

- Step cost ($0.115) → agent cost ($4.977140 for build:gemini, which contains this step among 80 turns) — consistent (one 26s step is a small fraction of an 80-turn, 14m56s agent run).
- Sum of 24 per-call costs ($40.216) → run cost ($40.208965 / displayed $40.21) — **matches**.
- Run cost ($40.21) → leaderboard bar ($40.21, 15% of $265 total) — **matches exactly** (same figure, no discrepancy).

**The dollars compose correctly end-to-end** wherever the flow could be exercised. The one broken link is navigational, not numerical: the click-to-auto-expand affordance from the insight leaderboard to the Workflows tab **only works reliably on the first visit to a given run**; every subsequent re-click of the same leaderboard bar silently fails to expand the target row and instead leaves a stray highlight on an unrelated row. For a user re-checking a number (exactly the "audit a dollar" persona this story describes), that's a real, repeatable dead-end requiring a manual workaround (scroll + click the row's own toggle).

## Findings

| ID | Severity | Summary |
|---|---|---|
| F-STORY-064-1 | **critical** | Clicking an insight-leaderboard bar to auto-expand + flash the matching Workflows row works on first navigation to a run, but **silently fails on every subsequent click of the same bar** (row never expands; a different, unrelated row gets a stray highlight instead). Reproduced 3× across 2 browser sessions. |
| F-STORY-064-2 | low | STORY-064's own setup line ("leaderboard biggest bar") is ambiguous in this app: the single biggest bar is usually the main conversation, not a workflow, so "click the biggest bar" doesn't reliably land on the Workflows tab as written. Not an app bug — a story-script clarity note for future walkers (resolved here by tracing the biggest *workflow* bar instead). |

## Screenshots

- `screenshots/00-active-session-landing.png` — session landing, waterfall view
- `screenshots/01-leaderboard-top.png` — insight card + leaderboard, biggest bar = main conversation $97.64
- `screenshots/02-after-click-leaderboard-bar.png` — first click: degree-build $40.21 row correctly expanded in Workflows tab
- `screenshots/03-flash-attempt-a.png`, `03-flash-attempt-b.png` — attempt to catch the flash mid-animation (second/third clicks — shows the bug, not the flash)
- `screenshots/04-BUG-no-autoexpand.png` — repeat click: target row NOT expanded, wrong row highlighted
- `screenshots/05-first-click-works.png` — fresh session, first click: correct row expanded with fading flash tint
- `screenshots/06-BUG-repeat-click-no-expand.png` — same fresh session, second click on same bar: expand fails again (deterministic repro)
- `screenshots/07-manual-expand-percall.png`, `08-percall-table.png`, `09-scroll-more.png`, `10-percall-more.png` — manually expanded per-call table (all 24 rows)
- `screenshots/11-row-click-inline-trace.png` / `12-after-close-check.png` — row click → agent-level "Call details" drawer (build:gemini, cost $4.977140)
- `screenshots/13-drawer-closed.png` — drawer closed via Close button
- `screenshots/14-timeline-view.png` — Timeline chart with per-agent inference/tool segments
- `screenshots/15-step-drawer.png` — step-level "Inference step" drawer (build:gemini step 75, cost $0.115)
