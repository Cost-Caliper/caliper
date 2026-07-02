# UX Walker — Run Report (2026-07-01)

**Target**: http://localhost:8787 · session `ux-walker-8787` · walkers: sonnet
**Walked**: 16 [WALK] stories in 6 batches (of 67 in the catalog) · **Passed**: 13 · **Failed→fixed**: 3

## Findings & Resolutions

| ID | Severity | Finding | Resolution |
|----|----------|---------|------------|
| F-STORY-004-1 | high | Empty-sessions toggle couldn't re-hide (visible-but-dead after data reset) | fixed — renderSessionsList self-heals (refetch on cleared data), clearer labels, aria-pressed; re-verified idempotent in batch E |
| F-019-1 | high | Insight workflow-bar click switched tabs but silently failed to auto-expand (cold-scan > 2s poll) | fixed — 15s poll + row flash on arrival |
| F-064-1 | critical | Repeat navigation to the same run expanded a stale row that the reload wiped | fixed — render-generation guard in navigateToRun; re-verified (repeat visit expands) |
| F-011-1 | medium | "[object Object]" in Sessions error copy | fixed — apiFetch normalizes {error:{code,message}} |
| F-010-x | medium | "active" pill had no tooltip | fixed |
| F-015-x | medium | Fold chevron vs node-click ambiguity in Nodes view | mitigated — explicit titles on both targets |
| STORY-048 gap | medium | Theme did not persist | fixed — localStorage, explicit choice wins over OS pref; re-verified both directions |
| F-018-1 | low | Timeline segments lacked accessible names | fixed — aria-labels on segment rects |
| F-032-1 | low | Flatten toggle styled like the exclusive view selector | mitigated — explanatory tooltip |
| F-035-1 | low | Stale tree-selection highlight after navigating away | fixed — selection syncs in selectSubagent/crumb-back |
| suggestion | — | Project picker unusable at 197 flat entries | queued: IA redesign (grouping + home dashboard) |

## Cost-accuracy audit (ran alongside the walk, user-prompted via ccusage)
Three real accuracy bugs found & fixed (v0.20.1): requestId double-counting (2×), fable-5 priced as opus (halved), cache-write TTL buckets ignored. Parity now test-enforced: $1.161496 vs ccusage $1.16 (exact); rich session reconciles main+subagents to ~1%.
Batch-F walker independently recomputed a step cost by hand from raw tokens and matched to the cent.

## What walked clean
Nodes fold/hover branch-highlight, deep-link reload restore, browser Back through drill-ins, breadcrumbs, empty states ("specific, honest guidance"), savings methodology (reproducible math), main-conversation trace at 605-turn scale (~160ms interactions), Tree/Timeline/Table switching, script drawer, per-call composition ($40.216 sum ≈ $40.208965 run).

## Top recommendations (next iteration)
1. IA redesign (in progress): Home dashboard → folder-scoped → session-scoped nested nav; grouped project picker; aggregate costs.
2. Project picker search/filter; session list pagination beyond the 200 cap.
3. Auto-refresh for live sessions (SSE exists only on Workflows tab).
4. Walk the remaining 51 catalog stories in a follow-up run.
