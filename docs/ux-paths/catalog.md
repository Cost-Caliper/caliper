# Control Tower — Consolidated UX Journey Catalog (Phase 3)

**App**: Control Tower (workflow-lens observability dashboard) · **Target**: `http://localhost:8787`
**Sources**: `docs/ux-paths/discovery.md` + 8 topic files in `docs/ux-paths/topics/`
**Consolidated**: 2026-07-01

- **Raw stories in topic files**: 82 (sessions-home 12 · active-session 12 · workflows-tab 11 · subagents-tab 10 · call-drawer 8 · navigation-history 9 · errors-empty-states 10 · cost-analysis 10)
- **After dedupe**: **67 stories** (15 near-duplicates merged; every merge is noted on the surviving story)
- **[WALK]** = priority subset (16 stories) for the browser-walking agent. Walkers should re-read the cited source section for full step detail, expected copy, and edge cases — steps here are compressed to their essence.
- **Type note**: sessions-home, active-session (partially), call-drawer, and navigation-history carried explicit types; workflows-tab, subagents-tab, errors-empty-states, and cost-analysis did not. Where the source omitted a type, the Short/Medium/Long class below is **derived from journey length** (marked ~).

---

## 1. Summary Table — counts by type

| Topic (section) | Stories | Short | Medium | Long |
|---|---|---|---|---|
| Sessions Home (001–010) | 10 | 8 | 2 | 0 |
| Active Session (011–020) | 10 | 5 | 5 | 0 |
| Workflows Tab (021–031) | 11 | 8 | 3 | 0 |
| Subagents Tab (032–040) | 9 | 3 | 6 | 0 |
| Call Drawer (041–042) | 2 | 2 | 0 | 0 |
| Navigation & History (043–048) | 6 | 5 | 1 | 0 |
| Errors & Empty States (049–058) | 10 | 7 | 3 | 0 |
| Cost Analysis (059–067) | 9 | 1 | 5 | 3 |
| **Total** | **67** | **39** | **25** | **3** |

Dedupe: 15 stories merged into richer survivors (6 from call-drawer, 3 from navigation-history, 2 from sessions-home, 2 from active-session, 1 from subagents-tab, 1 from cost-analysis).

---

## 2. Coverage Matrix — feature area → stories → gaps

| Feature area | Story IDs | Known gaps |
|---|---|---|
| Sessions home: project picker, date groups, day rollups, pills, empty toggle | 001–010, 049, 054, 062 | 200-session cap, no pagination/search/date-filter (003); no auto-refresh of list (005); tier dots are color-only (a11y) |
| Active Session: identity strip, rollup, session switching | 011, 043, 047 | — |
| Insight card: Pareto leaderboard, model-split bars, gen-speed line | 012, 020, 053, 058, 059, 063 | — |
| Potential savings panel + "*" methodology | 013, 060 | substitute prices are static constants dated 2026-07-01 — verify the as-of date renders |
| Waterfall view (time axis, Row 0) | 011, 014 | no pan/zoom on waterfall (static by design — confirm OK on very large sessions) |
| Nodes view (fold, zoom, pan, hover branch-highlight) | 015, 016, 017 | — |
| Main conversation trace | 018, 067 | — |
| Workflows list, filters, SSE refresh, status/caveat | 021, 022, 029, 030, 031, 050 | filter bar only renders when runs vary by branch/dir (data-dependent) |
| Workflow run detail: stat cards, timeline, per-call table, source drawer | 023–028, 059, 063, 065 | expanded-accordion state not hash-encoded → can't deep-link a specific run detail |
| Subagents views: Tree / Timeline / Table / Flatten, rollup | 032, 033, 037, 038, 040 | — |
| Subagent drill-in, conversation, orphans | 034, 035, 036, 039, 066 | orphan story (036) needs data with an actual orphan present |
| Call-detail drawer (inference / tool / thinking / long results) | 025, 026, 034, 039, 041, 042, 055, 064 | — |
| Navigation: tabs, deep links, Back/Forward, reload | 035, 043–046, 051 | hash format documented inconsistently across sources (`#/tab/<x>` vs `#/<x>`) — walker should record the real format; cross-machine deep links inherently fail (local data) |
| Theme | 048 | **toggle does not persist to localStorage** (code-inspection finding; contradicts discovery.md) |
| Errors, empty states, loading, honesty copy | 031, 049–058 | — |
| Live telemetry (SSE, live pill, governor) | 010, 029, 052, 057 | live-run failure paths (052, 057) depend on the hidden Control tab run loop |
| **Control tab: Run/Replay, budget cap, agent editor, optimization delta, learnings distillation** | *none* | **Intentionally out of scope** — the Control tab is hidden by default; discovery Topics 7–9 were deliberately not expanded into topic files |

---

## 3. Dependency Note — what assumes a selected session

- **Require a selected session** (drill-in tabs are hidden until one is picked via Sessions tab or deep link): STORY-006, 008, and **all of 011–043, 045, 047, 052–058 (most), 059–067**. Drawer stories 041–042 additionally require an open run/subagent trace.
- **No selected session needed**: 001–005, 007, 009–010 (list-level), 044/046 (the deep link itself carries the session id), 048 (theme), 049–051 (empty/error states).
- **Data-shape prerequisites for walkers**:
  - *Plain session* (no workflows/subagents) — 001, 011 (John stories).
  - *Rich session* (workflows + subagents, ideally nested depth ≥ 2) — 012–017, 019, 032–040, 059–067.
  - *Currently-running session* (transcript mtime < 2 min) — 010; live SSE run — 029, 052, 057.
  - *Fresh/empty project folder* — 049; unset `WFLENS_SESSION_DIR` — 050.
- **Suggested walk order**: 049 (empty) → 001 (first load + click-through) → 002/004/010 (list controls) → 011/018 (plain session) → switch to a rich session → 015, 019, 025, 032, 035, 064, 060 → 046, 048 last (reload/theme don't disturb state).

---

## 4. Gaps & Recommendations

1. **Theme toggle does not persist to localStorage** (already-found gap). `state.theme` is memory-only; a manual toggle is lost on reload, falling back to `prefers-color-scheme`. discovery.md claims localStorage persistence — the navigation-history code inspection contradicts it. *Recommend*: persist on toggle, read on init, fall back to OS preference; STORY-048 walks and confirms the current buggy behavior.
2. **Hidden Control tab is intentionally out of scope.** Run/Replay controls, budget cap input, cassette picker, agent editor, optimization suggestion/delta, and learnings distillation (discovery Topics 7–9) have no journey coverage beyond their error banners (052, 057). This is a deliberate scoping decision, not an oversight — do not walk it.
3. **Sessions list scalability**: hard 200-session cap with no pagination, no title search, no date filter (STORY-003 documents only workarounds). *Recommend*: "Load more" or `?offset` paging.
4. **No auto-refresh on the Sessions list** — stats go stale while a session runs; only manual Refresh (STORY-005). SSE auto-refresh exists only on the Workflows tab (029). *Recommend*: reuse the SSE bridge or a light poll for the list.
5. **Within-tab state is not deep-linkable**: expanding a workflow run or accordion row never changes the hash, so a specific run detail can't be shared/restored (043 step 3, 046 step 3).
6. **Hash-format documentation is inconsistent** across sources (`#/tab/<tab>` in discovery/subagents vs `#/<tab>` in navigation-history). Walkers must record the actual format; correct the docs afterward.
7. **Accessibility**: model-tier dots are color-only (009 edge case); cost tooltips are `title`-attr only and not announced to screen readers (008 edge case). *Recommend*: text/pattern fallback + ARIA labels.
8. **Cross-machine deep links inherently fail** (data is local transcripts). *Recommend (optional)*: a copy-link affordance that warns it only works on the same machine.

---

## 5. [WALK] Priority Subset (16 stories)

| ID | One-line title |
|---|---|
| STORY-001 | John's first load: plain-sessions list + session click-through orientation |
| STORY-002 | Project switching across many folders |
| STORY-004 | Toggle empty ("ghost") sessions on/off |
| STORY-010 | Active & live pills (list + identity strip, 2-min mtime rule) |
| STORY-011 | John's zero-workflow session comprehension journey |
| STORY-015 | Nodes view: fold/unfold tree (+ hover branch-highlight per STORY-017) |
| STORY-018 | Main conversation trace: lazy load, timeline, per-turn drawer |
| STORY-019 | Insight-bar click → cross-tab jump + auto-expand |
| STORY-025 | Agent full trace inline; trace-row → step drawer |
| STORY-032 | Subagents view switching: Tree/Timeline/Table + Flatten |
| STORY-035 | Subagent drill-in: conversation + breadcrumb + browser-Back |
| STORY-046 | Deep-link reload restores tab/session/drill-in position |
| STORY-048 | Theme toggle + persistence gap verification |
| STORY-049 | Fresh-install empty states across all tabs |
| STORY-060 | Savings methodology ("*") audit |
| STORY-064 | Cost trace-a-dollar: leaderboard → per-call table → drawer → formula |

---

# Story Catalog

Format: **ID — Title** · Type · Persona · Source (§ = original story ID in that file) · merged IDs if any.

## Sessions Home (STORY-001…010) — source: `topics/sessions-home.md`

**STORY-001 — First load: plain sessions only [WALK]**
Short · John (first-time engineer) · § STORY-001
Goal: understand cost/tokens of recent conversations with zero prior dashboard knowledge.
Essence: open app → Sessions tab auto-loads ("Reading sessions…") → project picker + "N folders known" hint → date-grouped list with per-day cost headers → card anatomy (time, title, badges, duration, turns, cost, tier dot) → click a session → identity strip appears, drill-in tabs activate, Active Session waterfall loads → return via Sessions tab.

**STORY-002 — Power user switches project folder [WALK]**
Short · Dennison (197 projects) · § STORY-002
Essence: open project picker → all projects with session counts → select another project → POST `/v1/project/select` → list re-fetches → find and activate a session there.

**STORY-003 — Find an old session beyond the 200-limit**
Medium · Dennison · § STORY-003
Essence: scroll date groups → footer "Showing the 200 most recent of X" → target session outside cap → documents current workarounds (API `?limit`, filesystem) and the missing pagination/search.

**STORY-004 — Toggle empty sessions [WALK]**
Short · Dennison · § STORY-004
Essence: default hides zero-turn/zero-cost sessions → bottom toggle "Show N empty sessions (no turns, no cost)" → click → ghost-styled rows appear interspersed → "Hide N empty sessions" reverts.

**STORY-005 — Refresh & observe a live session changing**
Medium · Dennison · § STORY-005
Essence: running session's stats are static (no polling) → click Refresh → cost/time update; "live" pill appears iff transcript mtime < 2 min → click through to Active Session with fresh stats.

**STORY-006 — Activate session → Active Session transition**
Short · John or Dennison · § STORY-006
Essence: click row → POST `/v1/session/select` → caches reset → `setTab('session')` → identity strip + waterfall + lazy main-trace `<details>` → back to Sessions keeps selection server-side. Variations: switching sessions, deleted session error.

**STORY-007 — Context line on Sessions tab**
Short · Dennison · § STORY-008
Essence: context line (project path · cwd · git branch) below picker; persists across tab switches; "n/a" branch and long-path truncation edge cases.

**STORY-008 — Cost tooltip nuance (conversation-only cost)**
Short · John · § STORY-010
Essence: session-card cost = conversation only; hover tooltip "conversation cost — workflows/subagents add more (see Active Session for the full total)" → Active Session shows the full rollup.

**STORY-009 — Model tier indicator dots**
Short · John/Dennison · § STORY-011
Essence: color dot per row (green haiku / tan sonnet / red opus), title = full model name; gray "unknown" fallback; color-blind a11y gap noted.

**STORY-010 — Active & live pills [WALK]**
Short · Dennison · § STORY-012 · **merged: navigation-history § STORY-009** (same live-pill logic on the identity strip)
Essence: "active" pill on the server-selected session row; "live" pill when mtime < 120 s with the exact explanatory tooltip; same pill logic in the "VIEWING SESSION" identity strip (title, date, cost, wf/sub badges, "switch session ↗"); Refresh may clear the pill.

## Active Session (STORY-011…020) — source: `topics/active-session.md`

**STORY-011 — Zero-workflow session: plain conversation only [WALK]**
Short (feature/edge) · John · § STORY-001
Goal: a plain session shows only the main conversation, not confusing empty sections.
Essence: identity strip + rollup "$X total · main conversation $Y" → insight card shows single "main conversation (this chat)" item → waterfall = Row 0 gray bar only, with note "This session launched no workflows or subagents…" → click bar → main trace opens with inference/tool timeline and per-turn detail.

**STORY-012 — Insight card model-split bars**
Medium (feature) · Dennison · § STORY-002
Essence: headline "main conversation + 15 workflows + 3 subagents · $622 … top 8 ≈ 60%" → chips → "by model:" legend → top-5 Pareto bars segmented by model color with hover tooltips → clicking a bar navigates (see 019). Variations: plain-indigo bar until detail loads, "partial — N workflow details unavailable".

**STORY-013 — Potential savings panel: OSS substitution**
Medium (feature) · Lead · § STORY-003
Essence: green/amber "Potential savings" chip → panel "Potential savings * — swap to open models" with per-tier rows (opus→GLM-5.2 etc.), total row, "*" methodology details (formula, Anthropic + OpenRouter prices, quality disclaimer). Edge: panel hidden when all workflow details fail.

**STORY-014 — Waterfall view: time axis & Row 0**
Medium (interaction) · Dennison · § STORY-004
Essence: Row 0 = main conversation full-width gray bar; rows 1+ sorted by startMs; bar x/width ∝ time; hover tooltip (name · kind · duration · cost · agents); click Row 0 → main trace; click item bar → its tab + auto-expand; legend + caveat. Edges: 2px min width, items without start excluded.

**STORY-015 — Nodes view: left-rooted tree with fold/unfold [WALK]**
Medium (interaction) · Dennison · § STORY-005
Essence: main session pinned left; workflows depth 1, agents depth 2, subagents fan out; ▸/▾ chevrons with child counts; edges colored by child kind; Expand/Collapse all; fold state persists across view toggles; first load auto-collapses. *Walker: also exercise the hover branch-highlight from STORY-017.*

**STORY-016 — Nodes view: zoom/fit/pan controls**
Short (interaction) · Dennison · § STORY-006
Essence: −/+/Fit buttons (zoom clamp 0.2–2.5), "N of M nodes shown" hint, ⌘/Ctrl+scroll zoom anchored under cursor, drag-pan with 4px click-intent threshold, two-finger native scroll.

**STORY-017 — Nodes view: hover branch-highlight + auto-scroll**
Short (interaction) · Dennison · § STORY-007
Essence: hover highlights self + ancestors + descendants + connecting edges; off-screen branch auto-scrolls to center after 90 ms debounce; highlights clear on mouse-out; collapsed descendants not highlighted.

**STORY-018 — Main conversation trace: lazy load & timeline [WALK]**
Medium (interaction) · John · § STORY-008
Essence: open `<details>` "Main conversation trace…" → "Reconstructing the conversation…" → fetch main-agent transcript → inference/tool timeline SVG, hover tooltips, per-segment click → call drawer (model, tokens, thinking, stop reason, cost, text) → inline per-turn conversation below (capped). Cached on re-open; reload on session change.

**STORY-019 — Insight-bar click → cross-tab navigation [WALK]**
Short (interaction) · Dennison · § STORY-009 · **merged: navigation-history § STORY-006** (identical navigateToRun/navigateToSubagent behavior)
Essence: click a top-5 bar → `wf` kind: Workflows tab, poll ≤ ~2 s for the run row, auto-expand, smooth-scroll centered; `sub` kind: Subagents tab, 320 ms tree wait, `selectSubagent`; `main` kind: opens main trace. Edges: CSS.escape ids, poll timeout degrades gracefully.

**STORY-020 — Measured generation speed line**
Short (feature) · Dennison · § STORY-012
Essence: "measured generation speed (workflow agents): haiku N tok/s · …" with tooltip (output ÷ inference time, workflow agents only, not end-to-end); tiers without data omitted; no line when only subagents.

## Workflows Tab (STORY-021…031) — source: `topics/workflows-tab.md`

**STORY-021 — Discover & list all workflow runs**
~Short · Dennison · § STORY-001
Essence: `GET /v1/observed` → accordion table (name, relative when, status badge, agents, cost w/ full-precision title, wall) newest-first; ▶/▼ chevrons, Enter/Space keyboard toggle, Refresh clears cache; empty state copy.

**STORY-022 — Filter runs by git branch & directory**
~Short · Teammate · § STORY-002
Essence: filter bar only when >1 distinct branch/dir; two dropdowns filter in place; "5 of 12" count; reset to All. (Data-dependent — needs runs spanning branches/dirs.)

**STORY-023 — Expand a run: stat cards**
~Short · Cost evaluator · § STORY-003
Essence: chevron expand → lazy fetch + cache → stat cards (Agent Calls, cache-aware Total Cost, Tok In/Out, Wall-Clock, Naive Sum, Speedup) with tooltips; accordion closes other rows; "Loading…" state.

**STORY-024 — Timeline: inference vs tool segments**
~Medium · Dennison · § STORY-004
Essence: per-agent stacked bars, blue inference / amber tool segments, tier-color dot, duration + "% tool" suffix; hover tooltip (kind, tools, duration, "click for details"); label click drills inline; legend.

**STORY-025 — Agent full trace inline; trace-row → step drawer [WALK]**
~Medium · Dennison · § STORY-005 · **merged: call-drawer § CD2** (trace-row click → drawer is the same shared component on the Subagents tab)
Essence: click agent name in timeline → inline full trace: meta chips (model, phase, wall, cost, tokens, cache wr/rd, turns, tools), numbered trace rows, Task `<pre>`, collapsible Conversation, Output → **click any trace row → call drawer opens for that exact step** (tool card: name + ✓/✗ badge, highlighted input JSON, result with char-count) → close returns to intact detail.

**STORY-026 — Timeline segment click → call drawer**
~Short · Dennison · § STORY-006 · **merged: call-drawer § CD1** (identical segment-click inspection) **and § CD6** (close/reopen across steps)
Essence: hover segment tooltip → click → drawer: inference view (tier, decided tools, tokens, cache, cost, tok/s, stop reason, full highlighted text) or tool view (per-call name/status/input/result+length) → close via ✕, scrim, or Escape → open a different step: drawer re-renders cleanly.

**STORY-027 — View workflow source + Open in VS Code**
~Short · Dennison · § STORY-007
Essence: "view workflow source" link → drawer with file path + `vscode://file{path}` link + highlighted JS source with char count; "Inline workflow — no saved file path" fallback.

**STORY-028 — Per-call table with cache columns**
~Short · Dennison · § STORY-008
Essence: 10-column table (#, Label, Tier/Model, Phase, ms, In, Out, Cache Wr, Cache Rd, Cost) — compact formats, full precision in titles, tier dots; row click → drawer with full call summary.

**STORY-029 — Live run appears via SSE (no manual refresh)**
~Medium · Dennison · § STORY-009
Essence: harness beacons → `/v1/observed/stream` EventSource → 'beacon' event triggers `loadObservedList()` → running row appears/updates (status running → completed); 10 s retry on error; silent if bridge unconfigured. (Needs a live run.)

**STORY-030 — Run status badges + cost reconstruction caveat**
~Short · Cost evaluator · § STORY-010
Essence: completed/running/error badge colors; caveat "Cost is reconstructed from harness transcripts (cache_creation × 1.25, cache_read × 0.10)… Neither is a live billing API value."; cost traceable to the cache columns.

**STORY-031 — Workflows-tab error handling**
~Short · Developer · § STORY-011
Essence: list-load failure, run-detail failure, 503 NOT_CONFIGURED ("Not watching a session — set WFLENS_SESSION_DIR."), source-fetch failure — each surfaces inline with retry via Refresh/re-expand.

## Subagents Tab (STORY-032…040) — source: `topics/subagents-tab.md`

**STORY-032 — Flat forest: view switching + Flatten [WALK]**
~Medium · John (3 flat Explore subagents) · § STORY-101
Essence: rollup line + agent-type badges → Tree view (MAIN_SESSION root, no chevrons when flat; Expand/Collapse disabled with explanatory tooltip) → Flatten toggles on → auto-switch to cost-sorted Table without MAIN_SESSION → unflatten restores tree → Timeline view (overlapping swimlanes = concurrency) → Table view columns (Agent, Type, Status, Model, Duration, Cost, Tok I/O, Started).

**STORY-033 — Expand/collapse a nested tree**
~Medium · Dennison (depth 3) · § STORY-102
Essence: Collapse all → only roots remain, chevrons show "+N" child counts → Expand all → full unfold → collapse one subtree only (siblings unaffected) → re-expand a single node.

**STORY-034 — Drill into one subagent's trace segments**
~Medium · John · § STORY-103
Essence: click row → detail slot with breadcrumb "← all subagents / ↑ main conversation / this subagent", meta line, timeline, sections Trace (N steps) / Task / Output / Conversation (collapsible) → hover a tool segment (tooltip lists tools) → click → drawer with per-call input/result/status → click an inference segment → drawer shows thinking/text/tokens/cost → close via ✕ or scrim.

**STORY-035 — Full conversation + breadcrumb + browser-Back [WALK]**
~Medium · Dennison · § STORY-104
Essence: select subagent → expand "Conversation — every agent ↔ user text, in order (N turns)" → click "↑ main conversation" → detail becomes MAIN_SESSION (original prompt, final output, full history) → "← all subagents" hides detail, scrolls list to top → **browser Back returns to the previous detail, Back again returns to the list** — breadcrumb and history stay in sync.

**STORY-036 — Orphan subagent investigation**
~Medium · Dennison · § STORY-105
Essence: rollup shows orphan count with explanatory hover → orphan re-homed under MAIN_SESSION, amber stroke + dashed parent edge, "orphan" status badge → detail still fully readable (trace/task/output/conversation) → user infers the parent link is missing, not the data. (Needs data containing an orphan.)

**STORY-037 — Timeline view: concurrency & cost compare**
~Short · John · § STORY-106
Essence: swimlanes on shared time axis; overlapping bars = parallel; hover tooltips (name · duration · cost); click bar selects; span metric matches axis.

**STORY-038 — Flatten: cost-sorted prioritization**
~Short · Dennison · § STORY-107
Essence: Flatten → Table sorted by cost desc, no MAIN_SESSION/indent/chevrons → click top row → detail → unflatten restores tree with collapse state preserved (flatten and fold state are independent).

**STORY-039 — Debug a failed tool call via segments**
~Medium · Jane · § STORY-108 · **merged: call-drawer § CD3** (inspect a failed tool call — same isError inspection)
Essence: subagent reads "done" but output looks incomplete → hover segments to find the tool step → click → drawer shows input + full error text (e.g. timeout) with ✗ error badge, scrollable not truncated → next inference segment shows the agent's recovery → Task/Output confirm intended fallback behavior.

**STORY-040 — Rollup metrics interpretation**
~Short · Dennison · § STORY-110
Essence: rollup line (`N subagents · roots · max depth · orphans · $cost · in/out tok · span`) with per-metric hover explanations; compare sum-of-durations vs span to infer concurrency.

## Call Drawer (STORY-041…042) — source: `topics/call-drawer.md`

*(CD1, CD2, CD3, CD6, CD7, CD8 merged into STORY-026, 025, 039, 026, 064, 055 respectively — the drawer is a shared component and those journeys already exercise it in context.)*

**STORY-041 — Read extended thinking**
Short · reasoning reader · § CD4
Essence: open an inference step that carried extended thinking → "Reasoning (extended thinking)" renders as its own scrollable block (30vh) before the model output; section absent entirely when no thinking.

**STORY-042 — Scroll a very long tool result**
Short · engineer · § CD5
Essence: open a tool step with a ~47k-char result → result block scrolls independently (max-height 46vh), drawer doesn't jump, char-count badge shows true size.

## Navigation & History (STORY-043…048) — source: `topics/navigation-history.md`

**STORY-043 — Orientation after multiple jumps**
Medium · John · § STORY-001
Essence: identity strip persists across Active Session → Workflows → drawer → Subagents → drill-in; breadcrumb names the selected subagent; hash tracks tab/session/agent; a full Back sequence unwinds drill-in → list → prior tabs. Edge: deleted session → "No session selected · pick one from the Sessions tab".

**STORY-044 — Sharing a deep link**
Short · Teammate · § STORY-002 · **merged: § STORY-008** (deep-link bootstrap — same flow, adds that `/v1/session/select` is POSTed server-side so data, not just URL, is correct)
Essence: full link `#/…/<sessionId>/<agentId>` → parseNavHash → server-side session select + cache reset → tab switch → `selectSubagent` → lands on the exact drill-in with correct strip/breadcrumb. Variations: link missing sessionId lands on tab without selection; malformed hash falls back to Sessions; deleted session degrades to empty tab.

**STORY-045 — Back button semantics: drill-in closes before tabs**
Short · John · § STORY-003 · **merged: subagents-tab § STORY-109** (same Back/Forward walk within Subagents, adds Forward re-opening a detail)
Essence: Back #1 closes the subagent detail (breadcrumb gone, hash drops agentId) → Back #2 switches tab → Back #3 lands on Sessions (strip hides) → Forward re-opens the previous state. Edges: same-hash clicks push no entry; rapid Back spam is safe.

**STORY-046 — Reload restores position [WALK]**
Short · John · § STORY-004
Essence: Cmd+R on `#/observe/<sessionId>` → init re-parses hash, re-selects session server-side, lands on the same tab; reload while deep in `#/subagents/<sessionId>/<agentId>` restores the exact drill-in. Known limit: accordion expansion state is not restored. Edge: deleted session → empty state + "Sessions ↗".

**STORY-047 — Switch sessions mid-exploration**
Short · Dennison · § STORY-005 · **merged: active-session § STORY-010** (same switch: cache reset + waterfall/strip refresh)
Essence: from Workflows on session A → Sessions tab → click session B → lands on Active Session (caches reset, fold state cleared, main trace closed) → back to Workflows now shows B's runs; "switch session ↗" navigates to the Sessions tab (not a dropdown). Edge: rapid switching is last-write-wins, no corruption.

**STORY-048 — Theme toggle & persistence gap [WALK]**
Short · John · § STORY-007
Essence: first load respects OS `prefers-color-scheme` → toggle ☀/☾ flips `data-theme` immediately → **reload: manual choice is LOST** (theme kept only in memory — the known gap; discovery.md wrongly claims localStorage persistence). Walker: verify and capture the regression; expected fix = persist + read `localStorage`, fall back to OS.

## Errors & Empty States (STORY-049…058) — source: `topics/errors-empty-states.md`

**STORY-049 — Fresh install: all tabs empty [WALK]**
~Short · John · § STORY-001 · **merged: sessions-home § STORY-007** (zero sessions in folder — same empty state + recovery-by-running-Claude-Code loop)
Essence: Sessions "No sessions in this folder yet" + run-Claude-Code hint; Workflows "No workflow runs yet"; Subagents Task/Agent-tree explainer (+ workflow-subagents pointer); stat cards "—"; graph placeholder; after running Claude Code once, Refresh shows the new session. Edge: credential warning + disabled Run in live mode.

**STORY-050 — Server not configured (WFLENS_SESSION_DIR)**
~Short · misconfigured user · § STORY-002
Essence: "Watching <dir>" vs "Not watching a session — set WFLENS_SESSION_DIR." hints; 503 NOT_CONFIGURED surfaces exact copy-pasteable messages on Sessions/Workflows/Subagents; unreadable dir degrades to empty list.

**STORY-051 — Deep-link to a deleted session (404)**
~Short · bookmark user · § STORY-003
Essence: `#/tab/<deleted-id>` → 404 "No such session in this project" → strip shows "No session selected" + "Sessions ↗" recovery button; drill-in tabs hidden/empty; subagent deep-link under a deleted session never opens.

**STORY-052 — SSE connection lost mid-run**
~Medium · power user · § STORY-004 (requires the hidden Control tab live-run path — see scope note)
Essence: run streaming → connection drops → red banner "INTERNAL: SSE connection lost" + "Reload and try again." → Run button re-enabled, pending bars freeze (`.t-bar-frozen`), partial data preserved.

**STORY-053 — Partial workflow details**
~Medium · session inspector · § STORY-005
Essence: some per-workflow detail fetches fail → insight still renders from available data, labeled "partial — N workflow detail(s) unavailable" on legend and savings chip; timeline includes only successful workflows.

**STORY-054 — Ghost rows: zero-turn sessions**
~Short · crash survivor · § STORY-006
Essence: empty sessions hidden by default → toggle reveals rows ("(no prompt captured)", 0 turns, $0) → opening one shows zeroed stat cards, "Waiting for first call…" timeline, "No turns recorded" trace.

**STORY-055 — "(no prompt captured)" fallback text**
~Short · malformed-transcript user · § STORY-007 · **merged: call-drawer § CD8** (tool-only inference step → "(no text — this step only emitted a tool call)" in the drawer)
Essence: every empty text field gets an honest fallback: "(no prompt captured)" for missing tasks/titles, "(no text output — tool-only turn)" for tool-only outputs, drawer variant for text-less inference steps; nothing renders blank.

**STORY-056 — Cost is an estimate, not billed**
~Short · org lead / CFO · § STORY-008
Essence: every $ surface carries the estimate disclosure — "$ = cache-aware estimate, not billed", per-call tooltip "Reconstructed cost of just this step…", full caveat with ×1.25/×0.10 multipliers in run detail and insight card.

**STORY-057 — Credential gate & budget governor**
~Medium · keyless / capped user · § STORY-009 (governor half requires the hidden Control tab run path)
Essence: live mode without ANTHROPIC_API_KEY → "⚠ Set ANTHROPIC_API_KEY to run live · Replay is free" + disabled Run (Replay clears it); budget trip → red "Over Budget — spent … ≥ cap … at call N" + "Raise Cap & Re-run" pre-filling 1.5× last cost.

**STORY-058 — Model split: computing vs unavailable**
~Short · insight viewer · § STORY-010
Essence: while details fetch → "computing model split…"; after failures → "model split unavailable" placeholder; total cost still shown — the two states are never ambiguous.

## Cost Analysis (STORY-059…067) — source: `topics/cost-analysis.md`

**STORY-059 — Find where a $733 session went**
~Long · Engineer · § STORY-001
Essence: Sessions → session → insight headline ("top 2 ≈ 60% of spend") → Pareto leaderboard → click biggest bar → Workflows auto-expand → per-call table exposes the $124 call (huge input, tiny output) → drawer confirms tokens/model → actionable options (retier / chunk / accept).

**STORY-060 — Savings methodology ("*") audit [WALK]**
~Medium · Cost evaluator / Lead · § STORY-002 · **merged: active-session § STORY-011** (methodology expansion feature detail: formula, per-tier Anthropic + OpenRouter price tables, as-of dates) **and cost-analysis § STORY-008** (substitute prices + "re-check OpenRouter" decision framing)
Essence: click "*" next to "Potential savings" → collapsible methodology: cache-aware formula, Anthropic list prices (dated), OpenRouter substitute prices (dated, per-tier), estimate-not-invoice note, and the prominent honesty caveat ("assumes identical token usage; a cheaper model may need more attempts… ceiling on token economics, not a promise") → auditor can verify the math and plan a quality-gated pilot rather than trusting the multiple blindly.

**STORY-061 — Cache-read dominance**
~Medium · ML engineer · § STORY-003
Essence: per-call table's cache-read column + tooltip ("charged at 0.10× the input rate") + methodology line ("a model's cached-input price usually decides the comparison") → engineer derives the reuse-the-cache design rule (write once ×1.25, read many ×0.10).

**STORY-062 — Day-level budgeting via rollups**
~Long · Finance/ops · § STORY-004 · **merged: sessions-home § STORY-009** (per-day cost rollup headers — same group-header feature)
Essence: day group headers "Today · 12 sessions · $187" → compare days → drill into expensive days' sessions → workflows tab pinpoints an Opus call that should be Haiku → budget narrative with a concrete retiering note.

**STORY-063 — Model-split bar → per-call tier audit**
~Medium · ML lead · § STORY-005
Essence: a 70/30 Sonnet/Opus segmented bar → hover per-segment costs → click → per-call table's Tier badges confirm which calls used which model → judge whether tiering is appropriate.

**STORY-064 — Trace a dollar end-to-end [WALK]**
~Long · Engineer · § STORY-006 · **merged: call-drawer § CD7** (metadata-chip reading for cost attribution incl. cache-read 0.10× / cache-write 1.25× chips)
Essence: insight headline → leaderboard top item → click → Workflows auto-expand → pick the priciest per-call row → drawer: model, thinking, stop reason, In/Out/cache-read/cache-write token chips, cost → cross-check against the methodology formula → conclude where the dollars went (input-context-heavy) and what would reduce it.

**STORY-065 — "Cached" flag + cache-read column**
~Short · Engineer · § STORY-007
Essence: blue "Cached" badge + high cache-read count + low cost vs an uncached sibling call → the 10× cache saving is visible per-row; tooltip explains prompt-cache hits.

**STORY-066 — Subagent cost rollup drill-in**
~Medium · Workflow engineer · § STORY-009
Essence: subagent appears in the insight leaderboard like a workflow → click → Subagents tab highlights it → trace segments show which turns are Opus-expensive → drawer confirms per-turn tokens/cost → cost judged justified or split-into-cheaper-subagents.

**STORY-067 — Main conversation cost drill-in**
~Medium · Engineer · § STORY-010
Essence: main conversation is a first-class leaderboard item with its own chip ("$89 · 39% of spend") → click → main trace timeline → longest segment's drawer shows extended thinking + Opus + long output driving the cost → the chat itself becomes an optimization target.

---

*End of catalog — 67 stories, 15 merges, 16 [WALK].*
