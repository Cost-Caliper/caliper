# Control Tower UX Journey Discovery

**Application**: Control Tower — workflow-lens observability dashboard  
**Type**: Vanilla JavaScript web dashboard (no framework, no bundler)  
**Tech Stack**: 
- Backend: Node.js `node:http` (zero extra deps beyond workflow-lens/acorn)
- Frontend: ES6 modules, plain DOM APIs, CSS Grid/Flexbox, inline SVG
- Server: `/packages/control-tower/server.mjs` (pure HTTP + JSON + SSE)
- Client: `/packages/control-tower/public/{app.js, index.html, app.css}` (~3200 lines)
- Data bridge: `/packages/control-tower/src/*.mjs` (sessions, observer, subagents, runner, editor)
- Launch: `node scripts/launch-control-tower.mjs` with auto-port selection (40000–59999) + session-dir discovery

**Server**: Listens on random high port (or `PORT` env var), served at `http://localhost:8787` (default)

---

## User Roles / Personas

1. **First-Time Engineer (Plain Sessions Only)**
   - Has run Claude Code conversations but never launched a workflow or spawned subagents
   - Sees the Sessions home tab populated with date-grouped conversation records
   - No Workflows or Subagents data to inspect
   - Use case: understand the cost/tokens/latency of recent conversations

2. **Power User (Many Workflows + Subagents)**
   - Actively uses workflow-lens to run multi-step agent orchestrations
   - Launches subagents via the Task/Agent tool
   - Uses Control Tower to debug cost, latency, and trace execution
   - Heavily uses Workflows, Subagents, and Session waterfall tabs
   - May edit workflow agents (models, prompts) and re-run in live or replay mode
   - Watches optimization suggestions and applies them

3. **Cost Evaluator (Organization Lead)**
   - Wants to audit overall spend, compare runs, understand where dollars go
   - Focuses on stat cards (Total Cost, Cost per Run, Speedup)
   - Uses the Workflows tab to see cost-per-agent and model distribution
   - May compare live vs replay vs optimized runs to justify budget

---

## Feature Map: Every Interactive Capability

### **Header & Navigation**

- **Brand**: "Control Tower — workflow-lens observability" (fixed sticky header)
- **Workflow Picker**: Dropdown to select which bundled workflow to control/run/edit
- **Live/Replay Toggle**: Segmented control (`Live Run` | `Replay Cassette`) — switches mode, shows/hides budget cap & cassette picker
- **Theme Toggle**: Light/dark mode button (☀/☾), persists to localStorage, respects `prefers-color-scheme`

### **Control Bar** (below header)

- **Primary Action**: "Run Workflow" or "Replay Cassette" button (disables when no key in live mode, or when a run is in progress)
- **Budget Cap** (live mode only): numeric input for USD cap; governor trip triggers "Over Budget" banner + "Raise Cap & Re-run" button
- **Cassette Picker** (replay mode only): dropdown listing cassettes with call counts
- **Toggle Chips**: 
  - "Cost Router" — enables cheaper-model routing (non-Anthropic via OpenRouter if available)
  - "Cache + HITL Gate" — enables cache/human-in-the-loop gate
- **Credential Warning**: "⚠ Set ANTHROPIC_API_KEY to run live · Replay is free" (shown when key absent and in live mode)
- **Run Status Label**: "Running…" or "Complete" (aria-live polite)
- **Report Link**: "↗ Open Report" (hidden until run completes; opens `/v1/runs/:id/report.html` in new tab)

### **Tab Navigation** (5 tabs, main content area below)

1. **Sessions** (home tab, initially active)
   - Project folder picker dropdown (all `~/.claude/projects/<slug>/` dirs)
   - Session list: date-grouped, newest-first, with per-session summary cards
   - Empty-session toggle: "Show N empty sessions (no turns, no cost)"
   - Click a session → activates it in the drill-in tabs + populates identity strip
   - Refresh button
   - Context line: project dir + cwd + git branch

2. **Active Session** (drill-in tab, hidden until session selected)
   - Identity strip: session ID, project, cwd, "switch session ↗" button
   - Session rollup: total cost, tokens, calls, wall-clock, speedup
   - **Insight Card**: model-split bar chart (Haiku/Sonnet/Opus percentages of cost/tokens)
   - **Potential Savings Panel**: estimated cost saved by concurrency if parallelized (methodology: "Naive Sum" vs "Wall-Clock" speedup)
   - **Segmented View Toggle** (`Waterfall` | `Nodes`):
     - **Waterfall**: time-axis SVG showing main session + all workflows + all subagents side-by-side, bars positioned by actual start/end timestamps, length = duration
     - **Nodes**: nested tree graph, main session pinned left, fan-out to workflows/subagents right (left-rooted for no horizontal scroll)
   - **Main Conversation Trace** (collapsible `<details>`): 
     - Lazy-loaded on first open per session
     - Timeline SVG segmented by inference vs tool
     - Per-step detail drawer: model, tokens, tool calls, thinking, stop reason
     - Full conversation text (capped on display)
   - Refresh button
   - Caveat: "Every workflow and subagent here was launched by the main session…"

3. **Workflows** ("Observe" tab, read from native harness transcripts)
   - **Empty State** (when no workflows): "No workflow runs yet" + hint to run one
   - **Filter Bar** (shown only when runs vary by dir/branch): 
     - Filter by working directory
     - Filter by git branch
     - Live filter count
   - **Workflow List** (accordion, expandable rows):
     - Row header: workflow name, when (relative time), status badge
     - **Expanded Row Detail**:
       - Stat cards: agent calls, cost, tokens, wall-clock, speedup
       - Timeline SVG: per-agent timeline with model-color legend (haiku/sonnet/opus/error)
       - Run log (if SSE streaming during live run)
       - **Per-Call Table**: 
         - Columns: #, Label, Tier, Phase, ms, In, Out, Cost, Request Id, Flags
         - Rows are clickable → right-side call-detail drawer (inference text, tool call payload, result)
         - Flags: "Cached" (blue), "Replayed" (gray), "Routed→<tier>" (amber)
       - **Per-Phase Rollup Table** (if multi-phase): phase name, calls, tokens in/out, cost, sum ms, wall ms
       - **Call Details Drawer** (right-side panel, slide-in on segment click):
         - Close button
         - If inference: model, decision tokens, thinking, stop reason, cost, inference text (highlighted JSON/JS)
         - If tool: tool name, input payload (formatted JSON), result content + length, is-error flag
   - Refresh button
   - Caveat: "Workflow-tool runs — reconstructed from real harness transcripts"

4. **Subagents** (parent→child tree of direct Task/Agent spawns)
   - **Empty State**: "Subagents you launch with the Task/Agent tool appear here as a parent → child tree"
   - **Identity Strip** (visible when a subagent is selected): breadcrumbs "main session > parent > selected" + "switch session ↗"
   - **Subagent Rollup**: total subagents, root count (depth 1), max depth, orphan count (parents not found), total cost, tokens
   - **View Toggle** (segmented: `Tree` | `Timeline` | `Table`):
     - **Tree**: nested list with fold/unfold chevrons, cost-sorted siblings, depth indentation; "Expand all" / "Collapse all" / "Flatten" buttons
     - **Timeline**: swimlane diagram, each subagent as a horizontal bar on shared time axis
     - **Table**: flat cost-sorted list, one row per subagent, drillable
   - **Flatten Button** (toggle): when on, shows a flat cost-sorted list (only meaningful in Table view; auto-switches to Table)
   - **Inline Call Detail** (shared slot): selected subagent's full trace renders inline below the tree/timeline/table
     - Timeline SVG: inference vs tool segments
     - Per-segment detail drawer: same as Workflows
     - Conversation snippet: first + last user/assistant turns
   - Refresh button
   - Caveat: "Parent→child is resolved by matching each subagent's spawning Agent tool-call id…"

### **Stat Cards** (visible in multiple places: Control tab, Workflows detail, Subagents detail)

- **Agent Calls**: count of inference calls across all agents
- **Total Cost**: estimated USD (cache-aware: cache_creation ×1.25, cache_read ×0.10)
- **Tok In / Out**: total tokens in and out
- **Wall-Clock**: elapsed time (real world)
- **Naive Sum**: sum of all agent ms (if serialized)
- **Concurrency Speedup**: Naive Sum / Wall-Clock ratio (highlights potential savings if parallelized)

### **Error / Empty / Loading States**

- **Empty Sessions**: "No sessions in this folder yet" → Run Claude Code in this project
- **Empty Workflows**: "No workflow runs yet" + hint about running or replaying
- **Empty Subagents**: "Subagents you launch with the Task/Agent tool appear here…"
- **No Workflow Selected**: Graph panel shows "Select a workflow to view its graph"
- **Loading States**:
  - Sessions list: "Reading sessions…"
  - Workflow detail: "Loading workflow…"
  - Timeline on live run: "Waiting for first call…" → updates in real-time via SSE
  - Main trace (first open): "Reconstructing the conversation…"
  - Nested graph view: "Loading nested graph…"
- **Failed Fetches**: "Could not load [resource]: [error message]"
- **Credential Gate**: 
  - Live mode + no ANTHROPIC_API_KEY: warning badge, Run button disabled
  - Replay mode: always enabled (free, deterministic)
- **Governor Trip**: Red banner "Over Budget" appears when cumulative cost exceeds cap; "Raise Cap & Re-run" button re-runs with doubled cap
- **No Session Selected** (drill-in tabs): Identity strip shows "pick one from the Sessions tab" + "Sessions ↗" button

### **Interactive Elements: Waterfall & Nodes Views**

- **Waterfall SVG**:
  - Bars positioned on shared x-axis (time), y = stacked by kind (main, workflow, subagent)
  - Bar height varies, color by kind (gray/indigo/teal), tooltip on hover
  - Clickable → opens call-detail drawer with full trace
  - Pan/zoom: currently view-fit on load; no user pan/zoom controls (design: static visualization)
  
- **Nodes SVG** (nested tree):
  - Left-rooted: main session pinned left, children fan out right by depth
  - Collapsible: chevron fold/unfold, collapsed nodes shown as leaf
  - Nodes color-coded: session (gray), workflow (indigo), wagent (light indigo), subagent (teal)
  - Hover highlight: node border, parent/child links
  - Clickable node → selects subagent, populates breadcrumbs + drill-in detail
  - Zoom/Pan: `applySessionNodeZoom()` on view switch + resize; fit-to-start, pan by scroll, zoom by mouse wheel (implicit in CSS overflow:auto)

### **History & Deep-Linking**

- **Hash-based navigation**: `#/tab/<tab>` or `#/tab/<sessionId>` or `#/tab/<sessionId>/<agentId>`
- **Browser Back/Forward**: works; popNav/pushNav track state
- **Query Params**: none used (all state is hash + local memory)

### **Drawer: Right-Side Call Details**

- **Scrim**: semi-transparent overlay (click to close)
- **Drawer Panel** (fixed right, 460px max, 94vw on mobile):
  - Header: "Call details" + Close button
  - Body: scrollable
  - Content (per segment):
    - **Inference**: heading (model badge), decision text, thinking (if present), stop reason, tokens + cost, full inference text (JSON/JS syntax-highlighted)
    - **Tool**: heading (tier badge), tool name + status (✓ ok / ✗ error), input (formatted JSON), result (truncated, full in tooltip), result length
  - Close on scrim click, close button, Escape key (inferred)

### **Tooltip: Segment Hover (Timeline)**

- **Timing Tooltip** (hover on timeline bar segment):
  - Tier dot + label (agent name or "Segment N")
  - Inference vs Tool, duration (ms)
  - Tools called (if tool segment): comma-list
  - Positioned at mouse + fixed to viewport (no overflow off-screen)
- **Hint**: "Click for details" (blue text)

### **Insight & Optimization Panels** (Control tab, when workflow runs)

- **Workflow Graph**: SVG render of the workflow DAG (agents, edges, tool calls)
- **Lint Badge**: "✓ Lint Pass" (green) | "⚠ N Findings" (red); hover → list of issues
- **Timeline Panel**: bar chart of all calls, color-coded by model tier, with legend
- **Optimization Card** (appears after run completes):
  - Title: "◆ Optimization Suggestion"
  - Body: prose description of the suggestion (e.g., "Route haiku-suitable calls to cheaper model")
  - **Before/After Delta**:
    - Cost before → after + savings
    - Wall-Clock before → after + savings
    - Speedup before → after
  - Buttons: "Apply Optimization" (amber), "Dismiss" (tertiary)
  - When applied: proposed run starts; delta card shows comparative results
- **Learnings Panel** (appears during/after distillation):
  - Title: "Learnings"
  - Spinner: "Distilling…" (appears while SSE stream processes learnings)
  - List: bullet points of extracted learnings (grounded only: cites must appear verbatim in run)
  - Button: "Write Learnings" (secondary) → POST /v1/runs/:id/learn, streams distill-start → distill-progress → distill-done events
  - Link: "Download .md" (appears after distillation, hidden by default)

### **Editing & Control (Control Tab, hidden by default)**

- **Editor Panel** (per-agent edits):
  - Agent row: agent name + tag, model dropdown, prompt textarea
  - Status: "dirty" border (blue) if model or prompt changed from original
  - Disabled prompts: read-only (agent prompt built at runtime)
  - Buttons: "Run Workflow" (after edits made)
- **Error Banner** (if edit validation fails): red background, error title + detail + next-steps

### **Session Context Line**

- Visible on Workflows, Subagents, Session waterfall tabs
- Shows: project folder (slug), cwd (full path), git branch (if available)
- Helps answer "which repo am I in?"

### **Theme**

- Light/dark toggle in header
- Persists in localStorage
- CSS variables: `--bg`, `--bg-100`, `--bg-200`, `--gray-*`, `--blue`, `--green`, `--red`, `--amber`
- Respects `data-theme` attribute on `<html>`

---

## Navigation Structure

1. **Tabs** (main content switching):
   - Sessions (home)
   - Active Session (requires session selected)
   - Workflows (observe native runs)
   - Subagents (parent→child tree)

2. **Breadcrumbs** (when session/subagent selected):
   - "project / session" or "main session > parent > selected"
   - Clickable to jump back

3. **History** (browser Back/Forward):
   - Hash routing: `setTab()` → `pushNav()` → `history.pushState()`
   - Drill-in tabs auto-populate from URL hash

4. **Deep-Link URLs**:
   - `#/sessions` — Sessions tab
   - `#/tab/session` — Active Session tab (requires session selected first)
   - `#/tab/observe` — Workflows tab
   - `#/tab/subagents` — Subagents tab
   - `#/tab/sessionId` — Select and view that session
   - `#/tab/sessionId/agentId` — Select session + drill into subagent detail

5. **No Search/Filter** (Sessions tab has manual filter by dir/branch, but no global search)

---

## Data Entities

### **Projects**
- `slug` (dash-encoded cwd path)
- `dir` (filesystem path)
- `cwd` (original working directory)
- `sessionCount` (number of sessions in this project)
- `lastActivityMs` (most recent session's mtime)

### **Sessions**
- `id` (UUID)
- `title` (cleaned first user message, ~140 chars)
- `startedAt`, `endedAt` (ISO timestamps)
- `ms` (duration milliseconds)
- `turns` (assistant turn count)
- `toolCalls` (tool invocations)
- `tokens`: `{ in, out, cacheWr, cacheRd }`
- `costUsd` (reconstructed, cache-aware estimate)
- `model` (primary model used)
- `tier` (Haiku/Sonnet/Opus)
- `cwd`, `gitBranch` (context)
- `workflows`, `subagents` (count of each)
- `hasDir` (whether a session subdir exists)

### **Workflows** (native harness runs)
- `runId` (UUID)
- `name` (from scriptPath or meta)
- `status` (running/done/error)
- `startedAt` (ISO)
- `timestamp`, `durationMs` (alternative timing)
- `agentCount` (number of Agent calls in the run)
- `totalTokens`, `totalToolCalls` (aggregates)
- `costUsd` (reconstructed)
- `source` (from Observe: "observed-native" | "workflow-tool")
- **Per-Agent Telemetry**:
  - `calls`: `[{ seq, label, tier, phase, ms, startMs, endMs, costUsd, inTok, outTok, cacheCreationTok, cacheReadTok, model, flags }]`

### **Subagents**
- `agentId` (UUID, unique per agent)
- `agentType` ("subagent" | "session")
- `description` (from Task/Agent tool spawn)
- `parentToolUseId` (links to parent's Agent tool_use)
- `parentAgentId` (resolved parent agentId, or MAIN_SESSION)
- `depth` (0 = main session, 1 = root subagent, 2+ = nested)
- `children` (array of child subagent nodes, tree structure)
- `model`, `tier`, `tokens`, `costUsd`, `ms`
- `startedAt` (ISO), `startedAtMs` (numeric for sorting)
- `status` ("done" | "running" | "missing" | "session")
- `tools`, `toolCalls`, `turns`
- `orphan` (true if parent not found)

### **Agent Calls** (within a transcript)
- `id` (UUID, the tool_use id that spawned the subagent)
- `description` (what the tool call was for)
- `model` (the model that made the call)

### **Segments** (inference vs tool, within an agent transcript)
- `kind` ("inference" | "tool")
- `startMs`, `endMs` (relative to agent start)
- `tools` (tool names, if tool segment)
- **Inference Detail**:
  - `text` (the model's response)
  - `decided` (tool names the model decided to call)
  - `inTok`, `outTok`, `cacheReadTok`, `cacheCreationTok`
  - `costUsd` (per-segment cost)
  - `model`, `stopReason`, `thinking`, `turns`
- **Tool Detail**:
  - `calls`: `[{ name, input, result, isError, resultLen }]`

### **Conversation Turns** (in a transcript)
- `role` ("user" | "assistant")
- `timestamp` (ISO)
- `content` (text or mixed content blocks)
- `toolUses` (if assistant and using tools)
- `usage` (if assistant, the token counts)

---

## Error / Empty / Loading States (Detailed)

1. **No Sessions in Project**
   - Message: "No sessions in this folder yet"
   - Sub: "Run Claude Code in this project and its sessions will appear here."
   - Icon: network diagram (SVG)

2. **No Workflows in Session**
   - Message: "No workflow runs yet"
   - Sub: "Run a Workflow in this session and it'll appear here automatically…"
   - Hint: "Add a workflow to your project and run it"

3. **No Subagents in Session**
   - Message: "Subagents you launch with the Task/Agent tool appear here as a parent → child tree."
   - Sub: "(Subagents spawned inside a Workflow show under the Workflows tab.)"
   - Icon: network diagram

4. **Session Not Selected (Drill-In Tabs)**
   - Identity strip: "pick one from the Sessions tab" + "Sessions ↗" button
   - Tabs (Session/Workflows/Subagents) hidden or show empty placeholders

5. **Loading States**
   - Spinner with "Reading sessions…"
   - "Loading workflow…"
   - "Loading nested graph…"
   - "Reconstructing the conversation…"

6. **Fetch Errors**
   - Format: "Could not load [resource]: [HTTP status or error message]"
   - Shown in the panel that tried to fetch

7. **Credential Missing (Live Mode)**
   - Warning badge: "⚠ Set ANTHROPIC_API_KEY to run live · Replay is free"
   - Run button disabled, styled as tertiary
   - Disappears when key is set or mode switches to Replay

8. **Budget Over (Governor Trip)**
   - Red banner: "Over Budget" + "Raise Cap & Re-run" button
   - Triggered when cumulative agent cost exceeds the cap
   - Re-running doubles the cap

9. **No Workflow Selected**
   - Graph panel: "Select a workflow to view its graph."

10. **Failed Lint Check** (on workflow edit)
    - Error: "Edited workflow failed lint: [findings joined by semicolon]"
    - User must fix and re-submit

11. **Cassette Missing** (Replay mode)
    - Error: "No cassette found for "{workflowId}". Run live with record:true first."

---

## Recommended Story Topics (8–10)

These collectively cover the entire dashboard and are sized for parallel swarm assignments.

### **Topic 1: Sessions Home — Project & Session Discovery**
**Rationale**: End-to-end journey from "no sessions shown" to "selected session activates all drill-in tabs." Covers project picker, date-grouped list, empty-session toggle, session selection, and context display.

### **Topic 2: Active Session Waterfall — Time-Axis Visualization**
**Rationale**: User selects a session → waterfall SVG renders main + workflows + subagents on shared time axis. Covers timing reconstruction, SVG rendering, hover tooltips, click-through to call drawer, and pan/zoom affordances.

### **Topic 3: Active Session Nodes — Nested Tree Graph**
**Rationale**: Alternative view of the session DAG (left-rooted, depth-based layout). Covers tree layout algorithm, fold/unfold interaction, breadcrumb drill-in, and visual hierarchy (session > workflows > agents > subagents).

### **Topic 4: Workflows Observe Tab — Native Run Inspection**
**Rationale**: Full workflow run detail: per-agent timeline, per-call table, per-phase rollup, stat cards, and inline call-detail drawer. Covers timeline SVG rendering, table pagination/sorting (implicit), filter bar, and segment clicks.

### **Topic 5: Subagents Tree / Timeline / Table — Multi-View Mode Switching**
**Rationale**: Three representations of the parent→child forest (tree chevrons, timeline swimlane, flat cost-sorted table) with shared drill-in detail slot. Covers view toggle, collapse/expand all, flatten mode, and per-subagent trace rendering.

### **Topic 6: Call Details Drawer — Inference vs Tool Inspection**
**Rationale**: Right-side panel opened by segment click. Shows inference detail (model, tokens, thinking, text) or tool detail (name, input, result, error flag). Covers drawer open/close, scrim click, content switching, and syntax highlighting.

### **Topic 7: Workflow Control & Editing — Live Run vs Replay & Edit Mode**
**Rationale**: Workflow picker, mode toggle (Live/Replay), edit-agent UI (model dropdown, prompt textarea), budget cap, chips (Cost Router, Cache Gate), and "Run" button. Covers all control-bar affordances and state transitions.

### **Topic 8: Timeline & Learnings SSE — Real-Time Run Telemetry Streaming**
**Rationale**: Live run progress: SSE stream (run-start, agent-start, agent-end, phase, rollup, governor-trip, done, distill events). Covers timeline bar animation, stat-card updates, optimize-card appearance, and learnings distillation UI.

### **Topic 9: Optimization Suggestion & Delta — Run Improvement Loop**
**Rationale**: After run completes, suggest optimization (e.g., route haiku calls to cheaper model). User clicks "Apply Optimization" → new run starts → delta card shows before/after cost, wall-clock, speedup. Covers proposal generation, re-run triggering, and delta rendering.

### **Topic 10: Error Handling & Empty States — Resilience & Guidance**
**Rationale**: Covers all error banners (credential warning, governor trip, failed edit, fetch error), empty states (no sessions, no workflows, no subagents, no selection), and loading indicators. Ensures user never gets lost and always has next steps.

---

## Summary

The **Control Tower** is a lightweight vanilla-JS observability dashboard that reconstructs the cost, latency, and trace of Claude Code sessions and workflows from local harness transcripts. It offers five primary views:

1. **Sessions** — browse all sessions in a project folder
2. **Active Session** — waterfall or nested-tree view of one session's workflows + subagents
3. **Workflows** — accordion list of native workflow runs with per-agent timeline + per-call detail
4. **Subagents** — parent→child tree (or timeline/table) of direct Task/Agent spawns
5. **Control (hidden)** — edit agents + run or replay a bundled workflow

**Key interactions**: session selection activates drill-in tabs; segment clicks open a right-side call-detail drawer; timeline and nodes views use SVG with hover tooltips and click-through to detail; real-time runs stream telemetry via SSE (phase events, stat rollups); budget cap governs execution; optimization suggestions propose and measure improvements. The app supports light/dark theme, deep-linking via hash, and browser history (Back/Forward).

**Data sources**:
- Sessions: `~/.claude/projects/<slug>/` transcripts (agent-*.jsonl + session UUID.jsonl)
- Workflows: reconstructed from `workflows/wf_*.json` + agent transcripts
- Subagents: `subagents/agent-*.{jsonl,meta.json}` + parent linkage via tool_use ids
- Cost: cache-aware estimate (cache_creation ×1.25, cache_read ×0.10), not a billed amount
- Timing: wall-clock from transcript timestamps (external monotonic clock, not in-harness)

---
