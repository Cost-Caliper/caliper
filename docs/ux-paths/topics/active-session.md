# Active Session Tab — Stories

**Topic**: The Active Session drill-in view — identity strip, insight card with model-split bars and potential-savings panel, waterfall & nodes views with interactive features, main conversation trace.

**Personas**: 
- **John**: runs plain Claude Code conversations, no workflows or subagents; his session shows only the main conversation.
- **Dennison**: power user with a rich session (15 workflows + 3 subagents, $622 total cost).
- **Lead**: cost-conscious manager auditing spend, reading the savings panel.

**Key Labels & Features** (from code):
- Identity strip: "VIEWING SESSION" label, session title, "switch session ↗" button
- Rollup: "This session = the main conversation + 15 workflows + 3 subagents"
- Insight card: "Where the estimated cost went" (Pareto leaderboard of top 5), model-split bars (opus/sonnet/haiku), "measured generation speed (workflow agents)", clickable bars
- Potential savings chip: OSS substitutes priced per OpenRouter, cache-aware methodology with "*" expansion
- Waterfall SVG: time-axis view, "Row 0" is the main conversation (clickable → opens trace), sorted by start time
- Nodes SVG: left-rooted nested tree, workflows/subagents fan out right, fold ▸/▾ on each node with child count, "Expand all / Collapse all" buttons, drag-pan, ⌘scroll zoom, hover branch-highlight (self + ancestors + descendants)
- Main trace: lazy-loaded `<details>`, inference vs tool timeline, per-turn detail drawer (model, tokens, thinking, stop reason, cost, text)
- Zoom controls (nodes only): −/+/Fit buttons, "N of M nodes shown"

---

## STORY-001: Zero-Workflow Session — Plain Conversation Only

**Type**: Feature verification / Edge case  
**Persona**: John (plain session, no workflows or subagents)  
**Goal**: Understand that John's session shows only the main conversation, not empty workflows/subagents sections.

**Preconditions**:
- John has run a Claude Code session with just conversation (no workflows spawned, no subagents).
- Session has cost > 0 and at least 3 turns.
- The Active Session tab is navigated to for this session.

**Steps & Expected**:
1. Click "Active Session" tab → Identity strip shows "VIEWING SESSION" with John's session title.
2. Rollup reads: "$X total (est.) · main conversation $Y".
3. Insight card displays a single item: "main conversation (this chat)" with cost and turn count.
4. Waterfall view shows Row 0 (gray bar spanning full width) labeled "main conversation" with the session's total duration.
5. Below Row 0, a note reads: "This session launched no workflows or subagents — the bar is the conversation itself. Click it to inspect the chat timeline."
6. Clicking the gray bar (or the "main conversation" label) opens Row 0 in the waterfall → Main trace details element opens.
7. Main trace shows timeline (inference vs tool segments), per-turn detail, full conversation text (capped on display).

**Variations**:
- Session with cost $0 (e.g., all cached inputs, no inference): Waterfall shows "main conversation" bar, insight card present but cost shown as $0.
- Session with 0 turns (degenerate): Rollup shows "0 turns", insight empty or minimal.

**Edge Cases**:
- Session's startedAt timestamp missing or malformed: startMs falls back to mtimeMs; waterfall still renders using fallback timing.
- Main conversation model unknown: insight card chip "Main conversation" shown without model badge.

---

## STORY-002: Insight Card with Model-Split Bars — Multi-Model Session

**Type**: Feature verification  
**Persona**: Dennison (15 workflows + 3 subagents)  
**Goal**: Verify the insight card accurately reflects cost distribution across Opus/Sonnet/Haiku and identifies the top 5 items by cost.

**Preconditions**:
- Dennison's session has workflows and subagents using different models.
- Per-workflow agent-call details are loaded (telemetry.calls with per-call model+cost).
- Insight card is rendered.

**Steps & Expected**:
1. Navigate to Dennison's session in Active Session tab.
2. Headline reads: "This session = the main conversation + 15 workflows + 3 subagents · $622 estimated · spanned 2m 34s · the top 8 account for ~60% of the spend".
3. Chips display: "Main conversation $X", "Workflows $Y", "Subagents $Z", "Biggest single", "Potential savings".
4. Legend line shows: "by model: opus $XXX (48%) sonnet $YYY (36%) haiku $ZZZ (16%)".
5. "Where the estimated cost went" section shows top 5 items as clickable bars:
   - Bar width = cost / maxCost × 100%.
   - Bar internally segmented by model color (indigo=opus, blue=sonnet, cyan=haiku).
   - Each segment's width ∝ that model's cost for that item.
   - Tooltip on hover shows item label, meta (e.g., "3 agents"), cost.
6. Clicking a bar navigates to that workflow/subagent in its tab (Workflows or Subagents) and auto-expands the detail row.

**Variations**:
- Workflow detail not yet loaded: bar shows plain indigo (no segment split) until detail arrives, then re-renders with split.
- Session uses only one model (all Haiku): legend line shows "by model: haiku $622 (100%)".
- Multiple partial workflow-detail fetches failed: note appended to legend: "partial — 2 workflow details unavailable".

**Edge Cases**:
- itemModelSplit returns null for a workflow: bar renders fallback (plain indigo).
- Cost ranking ties: stable sort by appearance order (items list order).
- Top 5 expands beyond true top 5 if cost is identical: bar at rank 5 and rank 6 have same cost.

---

## STORY-003: Potential Savings Panel — OSS Model Substitution

**Type**: Feature verification  
**Persona**: Lead (cost-conscious)  
**Goal**: Understand that the savings panel shows hypothetical cost if the session ran on cheaper OSS models instead of Claude, cache-aware, with a clear "*" methodology link.

**Preconditions**:
- Session has workflows with loaded telemetry (so per-tier token usage can be computed).
- At least one tier (Opus, Sonnet, or Haiku) has non-zero cost.
- Savings are computed and non-null.

**Steps & Expected**:
1. In the insight card, locate the "Potential savings" chip (green if save > 0, amber if save <= 0).
2. Chip shows: "Potential savings $X" with "Y% of Claude-tier spend".
3. Click the chip or scroll down to the "Potential savings" panel.
4. Panel title: "Potential savings * — swap to open models" with "OpenRouter list price · 2026-07-01" subtext.
5. Three rows (one per tier used in the session):
   - "opus → GLM-5.2: $200 → $140 save $60 (30%, 1.4× cheaper)"
   - "sonnet → DeepSeek V4 Flash: $180 → $110 save $70 (39%, 1.6× cheaper)"
   - "haiku → GLM-4.7 Flash: $242 → $220 save $22 (9%, 1.1× cheaper)"
6. Total row: "≈ $470 instead of $622 on these tiers — save $152 (24%, 1.3× cheaper)".
7. Click the "*" or scroll to expand the methodology `<details>` section.
8. Details show:
   - Formula: `cost = input×in + cache_write×in×1.25 + cache_read×in×0.10 + output×out`
   - Anthropic list prices (verified 2026-07-01).
   - OSS substitute prices from OpenRouter.
   - Disclaimer: "What this does NOT capture: whether an open model would do the work as well. It assumes identical token usage; a cheaper model may need more attempts or produce worse results, which erodes the saving."

**Variations**:
- Savings panel not present: session has no loaded workflow details, or only subagents (which don't expose inference time for speed calculation).
- Savings negative (OSS more expensive): chip shows "si-chip-warn" (amber), multiplier reads "1.2× pricier".
- Workflow detail load failures: note appended: "partial — 1 workflow detail unavailable", savings capped at models whose details loaded.

**Edge Cases**:
- SUBSTITUTE constant has no entry for a tier: that tier skipped in the panel.
- All workflow details failed: savings panel hidden entirely.
- Cost is exactly $0: pct shown as 0%, multiplier shown as "—".

---

## STORY-004: Waterfall View — Time-Axis Visualization & Main Conversation Row

**Type**: Interaction & navigation  
**Persona**: Dennison  
**Goal**: Verify that the waterfall shows the main conversation as Row 0 (spanning full width), then workflows and subagents sorted by start time.

**Preconditions**:
- Session has at least one workflow and one subagent.
- All timestamps are valid (startedAt, timestamp + durationMs, or startedAtMs).

**Steps & Expected**:
1. Navigate to Active Session tab, ensure view toggle shows "Waterfall" selected.
2. Waterfall SVG renders:
   - Row 0 (top): gray circle + label "main conversation" (left-aligned, 200px from left edge).
   - Row 0: gray bar, x-offset = 0 (representing session start), width ≈ full inner width (representing total session span).
   - Rows 1+: one per workflow/subagent, sorted by startMs (earliest first).
   - Each row: colored circle (indigo=workflow, teal=subagent) + label (26 chars truncated) + colored bar + duration (right-aligned).
3. Bar x-position computed as: xOf(startMs) = padL + ((startMs - minStart) / span) × innerW.
4. Bar width: Math.max(2, xOf(startMs + dur) − xOf(startMs)).
5. Tooltip on bar hover: "workflow-name · workflow · 2m 34s · $12.50 · 4 agents".
6. Clicking Row 0 bar or label → opens main conversation trace (sets `#session-main-trace` to `open = true`).
7. Clicking a workflow/subagent bar → navigates to Workflows or Subagents tab + auto-expands that item.
8. Legend below shows: "■ Main conversation ■ Workflow ■ Subagent".
9. Caveat text: "Everything the session launched, sorted by start time. Click a label or bar to open it in its tab."

**Variations**:
- Main conversation has $0 cost: tooltip omits cost line.
- Workflow with zero duration: bar width clamped to 2px (still clickable).
- Session has no workflows/subagents, only main conversation: waterfall shows Row 0 only, message reads "This session launched no workflows or subagents — the bar is the conversation itself."

**Edge Cases**:
- Item startedAt missing, startedAtMs = 0: item excluded from waterfall (early-return in loop).
- Two items have identical startMs: stable sort by durMs descending (larger duration first).
- span is very small (< 1 ms): all bars cluster at left; inner width still computed, no division by zero.

---

## STORY-005: Nodes View — Left-Rooted Nested Tree with Fold/Unfold

**Type**: Interaction & visualization  
**Persona**: Dennison  
**Goal**: Verify the nested-tree view shows the main session pinned left, workflows/subagents fan out right by depth, with collapsible nodes and fold state persistence.

**Preconditions**:
- Session has at least one workflow with multiple agents, or nested subagents.
- Nodes view has been loaded (wfDetails fetched).

**Steps & Expected**:
1. Click "Nodes" toggle button.
2. View switches to nested SVG + zoom/fold buttons above.
3. Main session node appears pinned at depth 0 (far left), labeled "main session" (no fold chevron).
4. Workflows appear as depth-1 nodes, fanning out right.
5. Workflow agents appear as depth-2 nodes (labeled "agent 1", "agent 2", …).
6. Direct subagents appear as depth-1 nodes (alongside workflows).
7. Nested subagents appear as depth-2+.
8. Each node with children shows a fold chevron: "▸" (collapsed) or "▾" (expanded).
   - Badge next to chevron (when collapsed): " 3" (count of immediate children).
9. Edges (lines connecting parent → child) render in color matching child's kind (indigo for workflow, light indigo for wagent, teal for subagent).
10. Hover a node → highlight self + all ancestors + all descendants (branch trace).
    - Highlighted nodes show border/fill change (class "hl").
    - If branch off-screen, canvas auto-scrolls to show it (smooth behavior, centered).
11. Click a fold chevron (▸/▾) → toggle that node's collapsed state, re-render in place, zoom maintained.
12. Expand/Collapse all button: click → all nodes with children toggle collapse state simultaneously, re-render.

**Variations**:
- Session with zero workflows/subagents: message reads "Nothing launched in this session yet. When the session runs a Workflow or spawns a subagent, it appears here."
- Very large session (100+ nodes): Fit zoom scales down to fit width; user can manually zoom in to inspect.
- Fold state persists across view toggle: user collapses a workflow, switches to Waterfall, switches back to Nodes → workflow still collapsed (sessionCollapsed Set retained).
- First load of Nodes view: all nodes-with-children auto-collapsed (so overview is glanceable); newly-seen nodes retain no prior fold state.

**Edge Cases**:
- Workflow has 0 agents: node shows no chevron (is a leaf).
- Parent workflow has 50 agents: chevron shows "▸ 50" when collapsed; expanding shows 50 child nodes (may be slow on very old browsers, but functional).
- Subagent depth > 3: tree still lays out; depth is unbounded.
- Two items have identical label and cost: sort is stable; breadth-first tree traversal maintains consistent ordering.

---

## STORY-006: Nodes View — Zoom Controls & Interaction

**Type**: Interaction  
**Persona**: Dennison  
**Goal**: Verify zoom/fit/pan controls work correctly for the nested tree.

**Preconditions**:
- Nodes view is active and rendered.
- Canvas has overflow:auto (scrollable).

**Steps & Expected**:
1. Zoom bar above the canvas shows: "−" button, "100%" label (centered), "+" button, "Fit" button, separator, "Expand all / Collapse all" button, and hint text "N of M nodes shown · click ▸ to expand · drag/two-finger to pan · ⌘/Ctrl+scroll to zoom · hover to trace a branch".
2. Click "Fit" → zoom resets to fit-to-width for nested tall tree (scales to Math.min(1, availW / W); no vertical shrink).
3. Click "+" → zoom *= 1.25, clamped to [0.2, 2.5].
4. Click "−" → zoom *= 0.8, clamped to [0.2, 2.5].
5. Label updates to show rounded percent (e.g., "125%", "80%").
6. ⌘/Ctrl + scroll wheel → zoom anchored under cursor (not corner):
   - scrollY < 0 (scroll up) → zoom *= 1.12.
   - scrollY > 0 (scroll down) → zoom *= 0.9.
   - New scroll position computed to keep cursor over the same content point.
7. Drag the canvas background (not a node/edge) → pan (grab cursor):
   - Pan only starts on a node-canvas.nested element.
   - Pointer capture acquired; small moves (< 4px) don't trigger pan (click intent preserved).
   - Once moved > 4px, canvas.scrollLeft/scrollTop updated in real-time.
   - Click-to-open (on nodes) still works after a small jitter (< 4px threshold).
8. Two-finger pan (on trackpad) → native overflow:auto momentum scrolling (passive; unmodified).

**Variations**:
- Canvas is very small (150px × 150px): Fit zoom still computed but clamped to [0.2, 1].
- User zooms to 200%, then clicks Fit → zoom resets to fit-to-width (no hysteresis).
- Collapse/expand all changes node count: zoom doesn't re-fit automatically (label updates to "N of M nodes shown").

**Edge Cases**:
- SVG has no data-w/data-h: fallback to W=900, H=600.
- Zoom wheel on a non-.node-canvas.nested element (e.g., legend): no-op (early return).
- Pinch zoom on mobile: browser handles natively; ⌘/Ctrl+scroll is desktop-only.

---

## STORY-007: Nodes View — Branch-Highlight on Hover & Auto-Scroll

**Type**: Interaction  
**Persona**: Dennison  
**Goal**: Verify hover-highlighting traces a branch (self + ancestors + descendants) and auto-scrolls if off-screen.

**Preconditions**:
- Nodes view is rendered.
- Session has deep nesting (depth ≥ 3) so branch tracing is meaningful.

**Steps & Expected**:
1. Move mouse over a nested subagent node (depth 2+).
2. Node highlights (class "hl" added): border color brightens, fill opacity increases.
3. All ancestors (parent, grandparent, …, root) highlight simultaneously.
4. All descendants (children, grandchildren, …, leaves) highlight simultaneously.
5. All edges connecting highlighted nodes highlight (colored edge strokes brighten).
6. If the topmost or bottommost highlighted node is off-screen:
   - 90ms after hover settles (scrollHoveredIntoView debounce), canvas.scrollTo({ top: Math.max(0, nodeY − canvas.clientHeight / 2), behavior: 'smooth' }) fires.
   - Branch scrolls into center view smoothly.
7. Move mouse away from all nodes → highlights clear (class "hl" removed).
8. Move mouse to a different node → previous highlights clear, new branch highlights.

**Variations**:
- Hover on root node (main session): all children/edges highlight (no ancestors to highlight).
- Hover on a collapsed node: only that node + ancestors highlight (descendants hidden, not highlighted).
9. Hover a node during an active drag-pan: hover highlighting paused (panState.moved = true skips highlight logic).
- Canvas scrolled to top: node at y=50px is visible; hover doesn't trigger scroll.

**Edge Cases**:
- Hover on node, then collapse its parent → highlight clears (parent now hidden, so node's highlight context changes).
- Branch spans full canvas height (50+ nodes): scroll centers on the hovered node, top/bottom of branch still off-screen (intentional; center is the priority).
- SessionNestedIndex is null (nodes view not yet built): mouseover handlers skip logic (no-op).

---

## STORY-008: Main Conversation Trace — Lazy Load & Interactive Timeline

**Type**: Interaction & lazy loading  
**Persona**: John (viewing his plain session)  
**Goal**: Verify the main conversation trace lazy-loads on first open, shows inference vs tool timeline, and allows per-step inspection.

**Preconditions**:
- Session is active.
- User clicks the `<details id="session-main-trace">` summary.
- Main trace has not yet been loaded for this session (mainTraceLoadedFor !== currentSessionId).

**Steps & Expected**:
1. Click summary "Main conversation trace — the chat itself, turn by turn (inference vs tool, full text)".
2. Details element animates open.
3. Body shows loading message: "Reconstructing the conversation…".
4. Background fetch: GET /v1/subagents/[MAIN_SESSION_ID] (reconstructs main agent's transcript).
5. On success:
   - Timeline SVG renders (same as subagent trace): horizontal bars, inference vs tool segments.
   - Tooltip on segment hover: duration (ms), tools called (if tool segment).
   - Legend shows inference (blue) and tool (amber) colors.
   - Per-segment detail drawer: click a segment → right-side panel opens showing model, tokens, thinking, stop reason, cost, full text (JSON-highlighted for tool results).
6. Below the timeline, render inline conversation detail (via renderCallDetailInto):
   - Per-turn readout: role (user/assistant), content snippet, tool calls (if any).
   - Full conversation text (capped on display per spec).
7. Each timeline segment is clickable (data-seg-idx attribute).
8. Click a segment → openCallDrawer fires, right-side panel shows full detail (same as workflow segments).

**Variations**:
- Main agent transcript is empty (0 turns): timeline is empty or minimal; inline detail shows "no turns".
- Fetch fails (HTTP 404, main agent not recorded): body shows "Could not load the main trace: [error message]".
- User opens & closes the trace multiple times: mainTraceLoadedFor caches it; second open skips fetch, uses cached DOM.
- Session has only tool calls (no inference): timeline shows only amber segments.

**Edge Cases**:
- Main conversation cost is $0 (all cached): timeline still renders segments (cache_read tokens show in the detail).
- User opens trace, then navigates to a different session, then back: mainTraceLoadedFor mismatch reloads the trace (correct session is shown).
- Main agent description is very long (500+ chars): label truncated in detail header.

---

## STORY-009: Clicking an Insight Card Bar — Navigation to Workflow/Subagent

**Type**: Interaction  
**Persona**: Dennison  
**Goal**: Verify that clicking a cost bar in the insight card navigates to the corresponding workflow/subagent and auto-opens its detail.

**Preconditions**:
- Insight card is rendered with clickable bars.
- Dennison's session has at least two workflows (so clicking a top-5 bar is meaningful).

**Steps & Expected**:
1. In the insight card, locate the top-5 items list (e.g., "workflow-1" bar showing $50).
2. Click the bar or the label.
3. Event fires with data-nav-kind="wf" data-nav-id="[runId]" (or data-nav-kind="sub" for subagent).
4. If kind is "wf": navigate to Workflows tab.
   - Click event handler calls navigateToRun(runId).
   - Workflows tab activates.
   - Poll for the obs-run-item[data-run-id="[runId]"] to appear.
   - If row is collapsed, toggleItem fires to expand it.
   - Expanded row scrollIntoView({ behavior: 'smooth', block: 'center' }).
5. If kind is "sub": navigate to Subagents tab.
   - Click event handler calls navigateToSubagent(agentId).
   - Subagents tab activates (waits 320ms for tab init).
   - Call selectSubagent(agentId) to open that subagent's detail.
6. User can now see the full cost breakdown for that item.

**Variations**:
- Bar's kind is "main" (main conversation): navigateToSubagent(MAIN_SESSION_ID) opens the main trace `<details>`.
- Workflow not yet loaded in the Workflows tab: poll loop waits up to 25 attempts (2 seconds) for the item to appear.
- Subagent is deeply nested: selectSubagent expands parent nodes in the tree to show it.

**Edge Cases**:
- WorkflowId contains special chars (/, :, etc.): CSS.escape used to safely select the element.
- Workflow has been deleted/unloaded since insight card rendered: poll loop times out (20 × 80ms); user sees nothing (graceful degradation).
- Two workflows with the same name: runId is unique, so correct one is found.

---

## STORY-010: Switching Sessions — Identity Strip & Waterfall Refresh

**Type**: Navigation  
**Persona**: Dennison (switching from session A to session B)  
**Goal**: Verify that the identity strip updates and the waterfall/nodes view reloads when a new session is selected.

**Preconditions**:
- Two sessions are available in the project.
- Dennison is viewing session A on the Active Session tab.
- Dennison clicks the "switch session ↗" button or selects a different session from the Sessions tab.

**Steps & Expected**:
1. Click the "switch session ↗" button in the identity strip.
2. Navigate to Sessions tab.
3. Click a different session B from the list.
4. Event fires: selectSession(sessionB.id).
5. POST /v1/session/select { id: sessionB.id } fires.
6. currentSessionId set to sessionB.id.
7. resetSessionCaches() clears lastSession, sessionCollapsed, sessionTree, mainTraceLoadedFor, etc.
8. setTab('session') navigates back to Active Session tab.
9. loadSessionWaterfall() fires:
   - Fetch /v1/observed (workflows for session B).
   - Fetch /v1/subagents (subagents for session B).
   - renderSessionHeader, renderSessionView update the strip and waterfall/nodes view.
10. Identity strip updates: new session title, new badges (workflows/subagents count).
11. Waterfall/nodes view shows session B's items.
12. Fold state cleared (sessionCollapsed reset), so workflows/subagents start folded (overview view).
13. Main trace details closed (mainTraceLoadedFor cleared).

**Variations**:
- Session B is a plain session (no workflows/subagents): waterfall shows only Row 0 (main conversation); no fold chevrons appear in nodes view.
- Session B's /v1/observed or /v1/subagents fetch fails: error message shown ("Could not load session: [error]"); user stays on Active Session tab but sees error.
- User clicks "switch session ↗" while session B is loading: selectSession(sessionA) interrupts; tabs switch to Sessions, then user can re-select session A.

**Edge Cases**:
- currentSessionId is null (no session selected): selectSession(sessionB.id) becomes the first selection; all drill-in tabs show data.
- Session B was deleted from disk since Sessions list was loaded: /v1/session/select succeeds (server-side state updated), but fetch might fail if the session subdir is gone; graceful error message shown.

---

## STORY-011: Methodology Asterisk (*) Expansion — Savings Calculation Details

**Type**: Feature & information disclosure  
**Persona**: Lead (auditing the savings calculation)  
**Goal**: Verify that clicking the "*" expands the methodology section with full pricing details, formulas, and disclaimers.

**Preconditions**:
- Potential savings panel is visible (savings computed).
- User clicks the "*" link in "Potential savings *" title.

**Steps & Expected**:
1. Click the "*" link (or navigate to #si-method anchor).
2. Details element with id="si-method" toggles open.
3. Summary reads: "* How "potential savings" is calculated & where the prices come from".
4. Body displays:
   - **Your current cost** formula: `cost = input×in + cache_write×in×1.25 + cache_read×in×0.10 + output×out`
   - **Current model prices** (Anthropic list, $/M tokens, verified 2026-07-01):
     - opus: $5/M in · $25/M out · $6.25/M cache-write · $0.50/M cache-read
     - sonnet: $3/M in · $15/M out · $3.75/M cache-write · $0.30/M cache-read
     - haiku: $1/M in · $5/M out · $1.25/M cache-write · $0.10/M cache-read
   - Note: "It's an estimate reconstructed from token counts, not a billed invoice."
   - **Substitute cost** explanation: same tokens re-priced at OpenRouter's list price, cache-aware (cache-read at model's cacheRd rate, not headline rate).
   - **Substitute prices used** ($ per M tokens, from OpenRouter 2026-07-01):
     - opus → GLM-5.2: $0.93/M in · $3.00/M out · $0.18/M cache-read
     - sonnet → DeepSeek V4 Flash: $0.098/M in · $0.196/M out · $0.02/M cache-read
     - haiku → GLM-4.7 Flash: $0.06/M in · $0.40/M out · $0.01/M cache-read
   - **Disclaimer**: "What this does NOT capture: whether an open model would do the work as well. It assumes identical token usage; a cheaper model may need more attempts or produce worse results, which erodes the saving. Treat it as a ceiling on token economics, not a promise — and prices change, so re-check OpenRouter."
5. Close the details or navigate away.

**Variations**:
- Savings.lines has only 1 tier (e.g., only Sonnet used): prices shown only for that tier.
- Multiple workflow-detail fetches failed: disclaimer appended: "· partial — 2 workflow details unavailable" (reflects the failedDetails count).

**Edge Cases**:
- SUBSTITUTE_ASOF timestamp is old (e.g., month-old prices): disclaimer text references that date; leading user to re-check if current.
- Prices in SUBSTITUTE differ from OpenRouter live (prices changed): user should re-check the live website; static data acknowledged in methodology.

---

## STORY-012: Measured Generation Speed Line — Per-Model Throughput

**Type**: Feature verification  
**Persona**: Dennison  
**Goal**: Verify the "measured generation speed" line shows real output tokens/second per model tier, based on workflow agent inference time.

**Preconditions**:
- Session has workflows with agent telemetry (calls with inferenceMs > 0).
- At least one tier (Opus, Sonnet, or Haiku) has measured inference time.

**Steps & Expected**:
1. In the insight card, below the model-split legend, locate the "measured generation speed (workflow agents)" line.
2. Line reads: "measured generation speed (workflow agents): haiku 142 tok/s · sonnet 89 tok/s · opus 56 tok/s tok/s · output ÷ inference time, not end-to-end"
   (actual numbers vary per session).
3. Tooltip on hover: "Output tokens ÷ model inference time, measured across this session's workflow agent calls (subagents don't report inference time here). Generation throughput only — not end-to-end run time (excludes tool execution and prompt processing)."
4. Each model segment shows: colored dot + model name + bold number + "tok/s".
5. Only tiers with measured speed shown (others omitted if no inference time data).
6. Final note in gray: "· output ÷ inference time, not end-to-end" (clarifies it's not wall-clock throughput).

**Variations**:
- Workflow agent calls have no inferenceMs field (older data): tierGenSpeed returns null; speed line not shown.
- All subagents, no workflows: speed line not shown (subagents endpoint doesn't expose inferenceMs).
- Only one tier has measured speed: line shows single entry (e.g., "haiku 142 tok/s").
- Large session with many inference calls: speed is accurate average (sum of timed output / sum of timed inference).

**Edge Cases**:
- inferenceMs is very small (e.g., 1ms) but outTimed is large: speed is inflated (artifact of low-latency inference, likely cached); disclaimer mitigates by explaining it's measurement-based.
- inferenceMs is 0 even with output tokens: tierGenSpeed returns null (avoid division by zero); tier skipped.
- Model's tier is "other" (not opus/sonnet/haiku): skipped from speed calculation (only standard tiers tracked).

---

## Summary

These 12 stories cover the Active Session tab's full interactive surface: zero-workflow plain sessions (John), complex multi-tier cost distribution (Dennison), cost-audit use case (Lead), waterfall time-axis visualization, nested-tree nodes view with fold/zoom/pan/hover, lazy-loaded main trace with per-turn inspection, cross-tab navigation via insight bars, session switching with state reset, methodology expansion, and measured generation speed readout. Each story references actual code labels and features from the Active Session implementation.

**Story count: 12**

