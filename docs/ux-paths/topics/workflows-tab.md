# Workflows Tab Stories (control-tower)

## Context
The Workflows tab ("Observe") provides a read-only view of native harness workflow runs reconstructed from local transcripts. Each run is an accordion showing per-agent telemetry (calls, cost, timeline, segments), a per-call table with cache columns, and inline drill-in UI for inspecting individual inference steps and tool calls.

---

## STORY-001: Discover and List All Workflow Runs

**Persona**: Power user Dennison auditing a degree-build run  
**Goal**: See all observed workflows at a glance with names, when they ran, status, and key metrics

**Narrative**
Dennison opens the Workflows ("Observe") tab. The dashboard calls `GET /v1/observed` and populates an accordion list (wf-table) with one row per run. Each row shows:
- Workflow name (or runId if unnamed)
- When it ran (relative time: "3 days ago")
- Status badge (completed/running/error)
- Agent count (number of agents executed)
- Cost (short format, full precision in title tooltip)
- Wall-clock time (real duration)

The list is sorted newest-first. Clicking a row chevron unfolds the detail inline (accordion pattern). A Refresh button clears the cache and re-fetches the full list.

**Acceptance Criteria**
- `loadObservedList()` fetches `/v1/observed` and renders a table with proper column widths (Workflow 32%, When 17%, Status 11%, Agents 10%, Cost 12%, Wall 11%)
- Table headers are sticky (implied by CSS)
- Each run row has `data-run-id` attribute for tracking; chevron shows ▶ (closed) or ▼ (open)
- Cost cell shows short format (e.g., "$0.024") with full precision in title="$0.024000"
- Keyboard support: Enter/Space on a row toggles its detail (aria-expanded)
- Empty state: "No workflow runs yet — Run a Workflow in this session…"
- Refresh clears runCache and calls loadObservedList again

---

## STORY-002: Filter Workflows by Git Branch and Working Directory

**Persona**: Teammate wondering which runs happened on main vs feature branch  
**Goal**: Narrow the list to runs matching specific repo context (branch, directory)

**Narrative**
When the workflow list includes runs from multiple branches or directories, a filter bar appears above the table. Two dropdowns:
1. **Branch**: "All" or specific branch name (main, feat/xyz, etc.)
2. **Directory**: "All" or specific cwd (shortened path like ~/conductor/workspaces/islamabad)

The dropdowns only render when they have >1 distinct value (no noise). Selecting a value filters the table in place; the count updates ("5 of 12 runs"). A reset to "All" for both shows the full list again.

**Acceptance Criteria**
- `populateObservedFilters(runs)` extracts unique branches/dirs from all runs
- Dropdowns render only when (branches.length > 1 || dirs.length > 1)
- `obsDistinct()` dedupes and sorts values
- `applyObservedFilters()` re-renders the table with the filtered runs
- Filter count label shows "5 of 12" when filtered, or "12 runs" when "All"
- Selections persist across refreshes (select value checked against options)
- Keyboard: dropdown change event triggers applyObservedFilters

---

## STORY-003: Expand a Run and Inspect Its Stat Cards

**Persona**: Cost evaluator comparing two runs  
**Goal**: Understand the overall shape of a single run: how many agents, total cost, tokens, wall-clock, parallelism speedup

**Narrative**
Dennison clicks the chevron on a run row. The row expands (aria-expanded=true, chevron becomes ▼). Below it, a detail section renders:
- **Stat cards** (4 across, or stacked on narrow screens):
  - Agent Calls: count of agents executed
  - Total Cost (cache-aware): reconstructed USD (cache_creation × 1.25, cache_read × 0.10)
  - Tok In / Out: summed input/output tokens
  - Wall-Clock: real elapsed time (start of first agent to end of last)
  - Naive Sum: if all agents ran serially, total time
  - Speedup: Naive Sum / Wall-Clock ratio (1× = serial, 2× = half the time, etc.)

A "view workflow source" link anchors the detail.

**Acceptance Criteria**
- `toggleItem(item)` lazy-fetches `/v1/observed/{runId}` on first open; caches the result (runCache)
- `buildDetailHtml(run)` renders stat cards using the run's `telemetry.run` object
- Cards show: `r.calls`, `r.costUsd`, `r.inTok / r.outTok`, `r.wallMs`, `r.speedup`
- Tooltips explain each metric (visible on hover or via title attr)
- Accordion: opening one run closes any other open run (standard accordion UX)
- Loading state: "Loading…" shown while fetch in flight

---

## STORY-004: Understand the Timeline: Inference vs Tool Segments

**Persona**: Power user debugging an expensive agent  
**Goal**: See which agents spent time on inference vs tool calls, and in what sequence

**Narrative**
Below the stat cards, a concurrent-agent timeline SVG renders:
- X-axis: time (0 to maxEnd of all agents)
- Y-axis: stacked rows, one per agent (horizontal bars)
- Each bar is divided into colored segments: blue = inference, amber = tool execution
- Leading dot: tier color (haiku=green, sonnet=tan, opus=red)
- Label (left): agent name, clickable to drill into full trace
- Trailing text: duration (e.g., "2.3 s") or "2.3 s · 40% tool" if split
- Bars/segments are clickable to open the call-detail drawer

Hover any segment to see a tooltip: agent name, segment kind (Inference/Tool), tool names (if tool), duration, "click for details".

**Acceptance Criteria**
- `buildTimelineSvg(calls)` generates an SVG with viewBox scaled to fit all bars
- Each call's segments are rendered as colored rects, proportionally positioned within the call's bar
- Segments carry `data-call-idx`, `data-seg-idx`, `data-seg-kind`, `data-seg-dur`, `data-seg-tools`, `data-seg-label`
- Hover shows tooltip via `showSegTip(e, seg)` and `positionSegTip(e)` (floats to avoid overflow)
- Click on a segment opens the call-detail drawer with that exact step (segmentDetailHtml)
- Click on agent name (label with data-drill="inline") renders full trace below the timeline
- Legend shows segment colors (Inference, Tool) and tier dots (Opus, Sonnet, Haiku, Fable)

---

## STORY-005: Inspect One Agent's Full Trace Inline

**Persona**: Power user reconstructing an agent's decision loop  
**Goal**: See every inference step and tool call an agent made, in order, with their relative timings

**Narrative**
Dennison clicks the agent name (e.g., "generate-degree") in the timeline. Below the timeline, an expandable drill-in slot fills with:
- Agent header (name, tier dot, "full trace")
- Meta chips: model, phase, wall-time, cost, tokens (in→out), cache (wr/rd), turns, tool calls, tools used
- **Trace rows**: numbered list of every segment (inference or tool), kind (blue dot = inference, amber = tool), name/tools, duration
- **Task**: the full prompt the agent received (in a scrollable <pre>)
- **Conversation**: collapsible details of every user↔agent text turn (capped display)
- **Output**: the agent's last assistant text

Clicking any trace row opens the call-detail drawer for that exact step.

**Acceptance Criteria**
- `renderCallDetailInto(slot, c)` fills the slot with callDetailHtml(c)
- Meta chips extracted from call `c` (model, phase, ms, cost, inTok/outTok, cacheCreationTok, cacheReadTok, turns, toolCalls)
- Trace rows rendered from `c.segments` array; each segment shows its position, kind (via colored dot), name, duration
- Clicking a trace row (data-trace-idx) calls `openCallDrawer(currentTraceDetail, seg)` with that segment
- Task and Output are <pre> blocks with word-wrap and max-height overflow
- Conversation (data-trace-idx click handler) shows/hides a collapsible <details> block with all turns
- Close button (data-close-call) hides the detail slot

---

## STORY-006: Click a Timeline Segment and Inspect the Exact Step

**Persona**: Power user zooming into an expensive inference or tool call  
**Goal**: See the exact model response, tool input/output, tokens, cost, and why the step happened

**Narrative**
Dennison hovers over a blue segment (inference) or amber segment (tool) on the timeline. A tooltip appears showing the segment's kind and duration. She clicks it. The call-detail drawer (right side) opens with one of two views:

**If inference segment**:
- Model and tier
- Heading: "Inference step · {duration}"
- Metadata: decided tools (if any), output tokens, input tokens, cache-read/write, cost, throughput (tok/s), stop reason, model name, turns merged
- Full inference text (syntax-highlighted JSON/JS if it looks like JSON)

**If tool segment**:
- Tool name(s)
- Heading: "Tool call · {duration}"
- For each tool call in the segment:
  - Name + status (✓ ok / ✗ error)
  - Input (formatted JSON or plain text)
  - Result (truncated, full in title attr), result length (chars)

The drawer has a close button (✕) and closes on Escape or scrim click.

**Acceptance Criteria**
- `openCallDrawer(c, seg)` sets drawer title and body from `segmentDetailHtml(seg, c)`
- Inference detail: heading includes tier dot, decision tokens, thinking (if present), stop reason, tokens in/out, cache, cost, speed, model
- Tool detail: each call shows name, status (error flag), formatted input JSON, result + length
- Drawer adds `open` class and sets `aria-hidden="false"`; scrim hidden=false
- Close button: `document.getElementById('cd-close')` removes `open` class, sets aria-hidden, hides scrim
- Escape key: document keydown listener calls closeCallDrawer
- Scrim click: closeCallDrawer

---

## STORY-007: View the Workflow Source Code and Open in VS Code

**Persona**: Power user tracing a bug back to the workflow definition  
**Goal**: Read the exact workflow script that produced this run, with a one-click link to edit it

**Narrative**
In the expanded run detail, a link reads "📄 {workflow-name} — view workflow source". Clicking it opens the call-detail drawer with the workflow source:
- **File path** (if saved): the workflow's .js or .mjs path, plus a blue link "Open in VS Code ↗"
- **Source**: the full workflow code (syntax-highlighted JavaScript), with character count

The vscode:// link uses `vscode://file{path}` to open the file directly in the editor (if VS Code is configured to handle vscode:// links).

**Acceptance Criteria**
- Click `.wf-source-link[data-script]` calls `openScriptDrawer(runId)`
- `openScriptDrawer()` fetches `/v1/observed/{runId}/script` (returns { name, path, source })
- Drawer title = "Workflow source"
- Body renders: file path (if present) + "Open in VS Code ↗" link with href="vscode://file{path}"
- Source rendered in code-block-html with highlightJs(source) for JavaScript highlighting
- If no source recorded, message: "Inline workflow — no saved file path" or "(source not recorded)"

---

## STORY-008: Explore the Per-Call Table with Cache Columns

**Persona**: Power user optimizing cache usage  
**Goal**: See which agents hit the prompt cache and how much they saved; understand token flow across tiers

**Narrative**
Below the timeline and agent traces, a per-call table shows one row per agent call:
| # | Label | Tier/Model | Phase | ms | In | Out | Cache Wr | Cache Rd | Cost |
|---|-------|-----------|-------|----|----|-----|----------|----------|------|
| 1 | refine | Claude 3.5 Sonnet | refinement | 2400 | 12K | 4.2K | 8K | 0 | $0.034 |
| 2 | grade | Claude 3.5 Haiku | grading | 540 | 4.8K | 1.2K | 0 | 8K | $0.002 |

Each row is clickable (table row cursor:pointer) → opens call-detail drawer. Full numeric values in title attributes (full precision), short format in cells. Cache Wr and Cache Rd have a "cache-col" class for visual grouping. The "In" and "Out" columns are compact format (K for thousands).

**Acceptance Criteria**
- `buildCallsTable(calls)` renders a <table> with 10 columns
- Column widths: # 4%, Label 18%, Tier/Model 14%, Phase 10%, ms 8%, In 7%, Out 7%, Cache Wr 9%, Cache Rd 9%, Cost 14%
- Each call row carries `data-call-idx="{i}"` for click handling
- Tier dot (colored circle) + model name (without "claude-" prefix)
- Numbers: ms (fmtMs), In/Out (fmtNshort with title tooltip), Cache Wr/Rd (fmtNshort), Cost (fmtUsdShort with full precision in title)
- Row click opens call-detail drawer with callDetailHtml(c) (no segment selected, shows full call summary)
- CSS class "cache-col" on Cache Wr/Rd for potential visual distinction

---

## STORY-009: Track a Run's Completion and Auto-Refresh via SSE

**Persona**: Power user waiting for a live degree-build to finish  
**Goal**: See a run appear in the list as it completes, without manual refresh

**Narrative**
A degree-build workflow is running. The harness publishes beacons to the server (POST /v1/observe). The server stores them by runId and broadcasts a "beacon" event via SSE (/v1/observed/stream). The Workflows tab's `subscribeObservedStream()` listener hears the event and calls `loadObservedList()` to refresh the table. If the runId is new, it appears at the top of the list (newest-first). If the runId exists, the row's data updates (status → "completed", agentCount, cost, etc.). The page never requires a manual refresh to see new runs.

**Acceptance Criteria**
- `subscribeObservedStream()` creates an EventSource('/v1/observed/stream') and listens for 'beacon' events
- On beacon event, calls `loadObservedList()`
- Server's `addBeacon(payload)` stores beacons by runId
- GET /v1/observed includes "running" status beacons (from beaconByRunId) merged with completed runs from disk
- If EventSource fails (onerror), retries after 10 seconds
- Non-fatal if bridge not configured (try/catch silently skips)

---

## STORY-010: Distinguish Run Status and Understand Cost Reconstruction

**Persona**: Cost evaluator validating a run's cost estimate  
**Goal**: Know whether a run is still in progress, completed successfully, or errored; trust the cost number

**Narrative**
Each row shows a status badge:
- **completed** (green): run finished, all telemetry captured
- **running** (amber): still in flight, beacon data captured but workflow file hasn't landed yet
- **error** (red): workflow failed or harness error

Below the expanded detail, a caveat reads: "Cost is reconstructed from harness transcripts (cache_creation × 1.25, cache_read × 0.10); timing is derived from transcript timestamps. Neither is a live billing API value."

The cost calculation is transparent: cache tokens are marked in the per-call table (Cache Wr / Cache Rd columns). The total cost sums these, applying the multiplier. A user can trace any call's cost back to the table.

**Acceptance Criteria**
- `statusClass(status)` maps "completed"/"ok" → obs-run-status-completed, "running" → obs-run-status-running, "error" → obs-run-status-error
- Each status receives a distinct CSS color (green/amber/red respectively, in app.css)
- Caveat text appears at the bottom of buildDetailHtml (observed-caveat label-13 muted)
- Per-call table includes cache columns with full token counts in title tooltips
- Cost calculation: (inTok × 0.003 + outTok × 0.015 + cacheCreationTok × 1.25 × 0.003 + cacheReadTok × 0.10 × 0.003) for Haiku; similar logic for other tiers (not shown in code but reconstructed from cost data)

---

## STORY-011: Handle Edge Cases and Errors Gracefully

**Persona**: Developer debugging a missing run  
**Goal**: See clear error messages and next steps when something goes wrong

**Narrative**
When the list fails to load (GET /v1/observed fails):
"Could not load observed runs: {error message}"

When a run detail fails to expand (GET /v1/observed/{runId} fails):
"Loading…" → "Could not load run: {error message}"

When the server says WFLENS_SESSION_DIR is not set (503 NOT_CONFIGURED):
The list is empty. The "watching" hint shows: "Not watching a session — set WFLENS_SESSION_DIR."

When a workflow script fetch fails:
Drawer shows: "Could not load source: {error message}"

All error messages are visible inline, user can retry by clicking Refresh or expanding again.

**Acceptance Criteria**
- `loadObservedList()` catch block renders error message in list
- `toggleItem()` catch block renders error in detail slot
- `openScriptDrawer()` catch block renders error in drawer body
- HTTP error codes (404, 503, etc.) handled and surfaced
- Refresh button always available to retry

---

## Summary

Ten stories covering the full Workflows tab journey: discover & filter runs (001–002), expand to stat cards (003), understand the timeline (004), drill into one agent's full trace (005), click a segment for exact detail (006), view and open workflow source (007), explore the per-call table with cache columns (008), track live completion via SSE (009), understand cost and status (010), and handle errors gracefully (011).

These stories map to the actual code: loadObservedList/renderObservedList (list), toggleItem/buildDetailHtml (expand), buildTimelineSvg (timeline), renderCallDetailInto (trace), openCallDrawer/segmentDetailHtml (segment), openScriptDrawer (source), buildCallsTable (table), subscribeObservedStream (SSE), statusClass/caveat (status & cost), and error handling throughout.
