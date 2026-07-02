# Subagents Tab — UX Journey Stories

**Application**: Control Tower — workflow-lens observability dashboard
**Topic**: Subagents tree/timeline/table views + drill-in detail
**Date**: 2026-07-01

---

## Overview

The **Subagents tab** visualizes the parent→child tree of agents spawned via the Task/Agent tool during a Claude Code session. Users can understand what subagents ran, drill into one to read its exact tool calls via clickable trace segments, view its full conversation, and navigate via breadcrumb or browser Back.

The tab offers **three complementary views** (Tree, Timeline, Table), shared controls (Expand/Collapse all, Flatten), and a drill-in detail slot showing the selected subagent's trace, task prompt, output, and conversation turns.

**Key Data**:
- Tree structure: parent → children (resolved by tool_use id matching)
- Rollup: `totalSubagents · roots · max depth · orphans · cost · tokens · wall-span`
- Per-subagent: `description · agentType · status (done/running/orphan) · model · duration · cost · tokens · started`
- Detail: `Trace (N steps) · Task (prompt) · Output (last assistant text) · Conversation (every turn)`

---

## STORY-101: John Understands His 3 Flat Explore Subagents

**Persona**: John (ultracode user with 3 flat Explore subagents, no nesting)  
**Trigger**: Opens Control Tower, navigates to Subagents tab after running a Claude Code conversation

**Journey**:

1. **Land on Subagents tab** (default Tree view, no selection yet)
   - Identity strip shows: `~/.claude/projects/myrepo · branch main · session a1b2c3d4…`
   - Rollup line displays: `3 subagents · 3 roots · max depth 1 · 0 orphans · $0.051432 · 8,452/3,891 tok · span 1m 22s`
   - Agent-type badges show: `Explore 3` (all three are Explore-type agents)
   - Tree view (active): shows a MAIN_SESSION row at the root with three child rows indented below it (no chevrons because no nesting)
   - Control bar has buttons: "Expand all" (disabled + tooltip: "Nothing to fold — all subagents here are direct children"), "Collapse all" (disabled), "Flatten" (active=false), "Refresh"

2. **Flatten the list** (toggle on via "Flatten" button)
   - "Flatten" button becomes active (aria-pressed=true, visual highlight)
   - View auto-switches to Table (flat cost-sorted list)
   - Table shows 3 rows (no MAIN_SESSION), sorted by cost descending: `Explore-A ($0.018) → Explore-B ($0.017) → Explore-C ($0.016)`
   - Chevrons are gone (indentation = 0)

3. **Unflatten back to tree** (toggle "Flatten" off)
   - "Flatten" button becomes inactive
   - View auto-switches back to Table → Tree view (default)
   - MAIN_SESSION row reappears at the top with three children indented

4. **Switch to Timeline view** (click "Timeline" button)
   - Three swimlane bars on a shared time axis, showing wall-clock start positions and durations
   - Bars are arranged by start time (likely overlapping, showing concurrency)
   - Tooltip on each bar shows: `Explore-A · 890 ms · $0.018`

5. **Switch to Table view** (click "Table" button)
   - Flat list (no indentation), cost-sorted
   - Columns: Agent, Type, Status, Model, Duration, Cost, Tok I/O, Started
   - All three show status "done" (green dot), model "Haiku", cost in `$0.01x` range

**Why this story?** John has the simplest case: a flat forest with no nesting. The disabled Expand/Collapse buttons and disabled-button tooltip teach him why fold controls don't apply. Flatten toggle and view switching feel responsive and confirm the data is the same across views. He leaves understanding: "Control Tower shows every agent I spawned and how much each cost."

---

## STORY-102: Dennison Expands and Collapses a Nested Subagent Tree

**Persona**: Dennison (nested subagent trees, depth 2+)  
**Trigger**: Launches Control Tower after a complex workflow spawning subagents that spawn their own subagents

**Journey**:

1. **Load Subagents tab** (Tree view active)
   - Rollup: `7 subagents · 2 roots · max depth 3 · 0 orphans · $0.978858 · 290/21,355 tok · span 2m 45s`
   - Agent-type badges: `Explore 5 · Coordinator 2`
   - Tree view shows:
     - MAIN_SESSION (no chevron)
     - └─ Explore-Root-1 (expanded, shows chevron ▼, child count "(3)")
     -    ├─ Explore-A (expanded, chevron ▼, child count "(1)")
     -    │  └─ Explore-A1 (collapsed, chevron ▶, no children visible)
     -    ├─ Explore-B (no children, no chevron)
     -    └─ Coordinator-C (collapsed, chevron ▶, child count "(1)")
     - └─ Explore-Root-2 (collapsed, chevron ▶, child count "(2)")

2. **Collapse all** (click "Collapse all" button)
   - All chevrons flip to ▶ (showing "+" counts instead of "−")
   - Only MAIN_SESSION + the two roots are visible (Explore-Root-1 and Explore-Root-2 nodes remain, but their children vanish)
   - Expand all button is now enabled
   - Collapse all button remains enabled (no-op if clicked again)

3. **Expand all** (click "Expand all" button)
   - All chevrons flip to ▼ (the "−" symbol)
   - Full tree unfolds: MAIN_SESSION → roots → all children → grandchildren (down to max depth 3)

4. **Collapse one subtree** (click the chevron on Explore-A)
   - Only Explore-A's subtree collapses (Explore-A1 vanishes)
   - Chevron becomes ▶ "+1" (shows child count)
   - Expand-A's sibling (Explore-B, Coordinator-C) and the other root remain fully expanded
   - Both "Expand all" and "Collapse all" buttons remain enabled

5. **Click a collapsed chevron to re-expand** (click Explore-A's chevron again)
   - Explore-A1 reappears
   - Chevron becomes ▼ "−"

6. **Manually expand Explore-Root-2's fan** (chevron on the root shows "+2")
   - Root-2 is still collapsed, child count shows "(2)"
   - Click the ▶ "+2" chevron
   - Root-2 expands, revealing two children (but grandchildren remain collapsed if they have any)

**Why this story?** Dennison's nested structure teaches the collapse/expand interaction. The disabled → enabled → enabled state of the fold buttons is clear (disabled only when all agents are direct children). Chevrons show child counts in a compact way, and the visual state (▼ vs ▶) plus the count ("+N") are immediately clear. He leaves understanding: "I can fold subtrees to focus on one branch, and the browser Back button lets me undo a row click."

---

## STORY-103: John Drills Into One Subagent's Trace to See Its Exact Tool Calls

**Persona**: John (ultracode user, 3 flat Explore subagents)  
**Trigger**: Wants to understand what tool calls Explore-B made and whether they succeeded

**Journey**:

1. **Click a subagent row** (clicks "Explore-B" in the table or tree)
   - Row is now highlighted (cursor becomes pointer on hover)
   - Detail slot becomes visible below the table/tree
   - Breadcrumb appears at the top of the detail slot:
     ```
     ← all subagents / ↑ main conversation / this subagent
     ```
   - Heading shows: "Explore-B · haiku · 1m 4s · $0.017" (meta line)
   - Timeline SVG appears (inference vs tool segments)
   - Section "Trace — 4 steps (inference & tool calls, in order)" with clickable timeline
   - Section "Task — the prompt this agent received" (shows the prompt passed to Explore-B)
   - Section "Output — its last assistant text" (shows Explore-B's final response)
   - Section "Conversation — every agent ↔ user text, in order (12 turns)" (collapsible `<details>`)

2. **Hover over a timeline segment** (hovers over segment 2, a "tool" segment)
   - Tooltip appears near cursor:
     ```
     Segment 2
     Tool · 3,420 ms
     Tools: fetch_docs, web_search
     Click for details
     ```

3. **Click the tool segment** (clicks segment 2)
   - Right-side drawer slides in (460px wide, "Call details" heading)
   - Content shows:
     ```
     TOOL — tool segment
     Tool calls: 2
     
     Call 1: fetch_docs
     Input: { "query": "how to install package X" }
     Result: "Found 3 docs matching..."
     
     Call 2: web_search
     Input: { "q": "package X latest version" }
     Result: "Web search returned..." (or "ERROR: timeout")
     Status: 1 ok, 1 error
     ```
   - Close button (X) in drawer header; can also close by clicking the scrim

4. **Click another segment** (clicks segment 1, an "inference" segment)
   - Drawer slides in with inference content:
     ```
     INFERENCE — haiku
     
     Thinking: (if present)
     "I should look up documentation first..."
     
     Text:
     "I'll search for the docs and the latest version. Let me use two tools to..."
     
     Stop reason: end_turn
     Tokens: 340 in, 280 out
     Cache: 0 creation, 0 read
     Cost: $0.0008
     ```

5. **Close the drawer** (clicks the X or the scrim)
   - Drawer slides out
   - Detail slot remains visible; detail didn't change

6. **Expand the Conversation section** (clicks the details summary)
   - Turns are revealed in chronological order: user → assistant → user → ...
   - A few long turns are shown; very long text is truncated with a tooltip

**Why this story?** John needs to debug: "Did Explore-B call the right tools? Did they succeed?" The timeline + clickable segments let him jump directly to the exact tool call and see the input/output. The breadcrumb and drawer close button give him clear ways out. He leaves understanding: "I can click any segment in the timeline to see what the agent did at that moment."

---

## STORY-104: Dennison Reads a Subagent's Full Conversation and Navigates Back via Breadcrumb

**Persona**: Dennison (nested subagents, wants to understand the full exchange with one agent)  
**Trigger**: Selected a subagent (Coordinator-C) and wants to see every message it exchanged

**Journey**:

1. **Click "Coordinator-C" in the tree**
   - Detail slot opens with Coordinator-C's meta, timeline, task, output
   - Breadcrumb:
     ```
     ← all subagents / ↑ main conversation / this subagent
     ```
   - Coordinator-C is highlighted in both the tree (visual border change) and the timeline

2. **Scroll down to the Conversation section** (it's collapsed by default)
   - Clicks the `<details>` summary:
     ```
     Conversation — every agent ↔ user text, in order (18 turns)
     ```
   - Details expand; shows all 18 turns, alternating user/assistant
   - Each turn shows timestamp, role, and content (truncated if very long)
   - Example:
     ```
     [12:34:56 UTC] User:
     "Here are the test results from phase 2: ..."
     
     [12:35:01 UTC] Assistant:
     "Thank you. I see that the test coverage is 87% and there are 3 failing tests. Let me analyze..."
     ```

3. **Click "↑ main conversation" in the breadcrumb**
   - Detail slot now shows MAIN_SESSION's data instead of Coordinator-C
   - Breadcrumb becomes:
     ```
     ← all subagents / main conversation (the thread itself)
     ```
   - Timeline shows the main session's segments (inference vs tool)
   - Task section shows the original user prompt that started everything
   - Output section shows the final assistant response from the main thread
   - Conversation section shows the main session's full turn history

4. **Click "← all subagents" to go back** (clicks the breadcrumb button)
   - Detail slot becomes hidden
   - Subagents tree/table/timeline is brought into view (scrolls to top of the list)
   - Hash navigation records this as a "back" event (browser Back button now closes the detail slot)

5. **Browser Back button** (from main conversation view)
   - Takes Dennison back to Coordinator-C's detail view (the previous selection)
   - Hash was recorded as `#/tab/sessionId/agentId` when Coordinator-C was selected

6. **Browser Back button again**
   - Takes Dennison back to the subagents list view (no selection)
   - Hash is now `#/tab/subagents`

**Why this story?** Dennison needs two things: (1) see every message the subagent exchanged (full conversation), and (2) be able to navigate back to the main conversation and back again. The breadcrumb + browser Back give him two ways to move around, and they stay in sync. The detail slot's auto-scroll ensures he sees what he clicked. He leaves understanding: "I can read the full conversation of any subagent, jump to the main session, and Back always takes me where I was."

---

## STORY-105: Dennison Spots an Orphan Subagent and Investigates Its Status

**Persona**: Dennison (nested subagents, one orphan flagged)  
**Trigger**: Rollup line shows "2 orphans" count; Dennison wants to understand why

**Journey**:

1. **Load Subagents tab** (Tree view)
   - Rollup: `8 subagents · 2 roots · max depth 2 · 2 orphans · $0.85 · ...`
   - Orphan count is highlighted in the metric (full title on hover: "Subagents whose spawning Agent tool-call could not be found...")

2. **Scan the tree** (looking for visual indicators of orphan status)
   - MAIN_SESSION has its usual rows + children
   - At the bottom of the tree, there's an indentation-less row: `Orphan-1 · Explore · orphan (amber dot) · ...`
   - The tree shows the orphan row anchored to MAIN_SESSION (it's been re-homed)
   - In the Tree view, the node has an amber border (stroke) around it and a dashed parent edge (indicating the link to parent is broken)
   - Tooltip on hover: "Explore-Orphan-1 · explore · 45 ms · $0.003 · ⚠ orphan"

3. **Switch to Timeline view**
   - Orphan-1's swimlane bar is still visible, color-coded by its tier (not its orphan status; color is the agent's model tier, not the orphan flag)
   - Click Orphan-1's bar to select it

4. **Click the orphan row in the table/tree**
   - Detail slot opens
   - Breadcrumb shows: `← all subagents / ↑ main conversation / this subagent`
   - Meta line: "Explore-Orphan-1 · explore · 45 ms · $0.003 (no flag here, but status column shows 'orphan')"
   - Status badge in the detail meta: `orphan` (amber dot)
   - Timeline, task, output, conversation all render normally

5. **Read the orphan's conversation**
   - Conversation section is fully populated (the agent's transcript exists; only the parent link is missing)
   - For example:
     ```
     User:
     "Run this diagnostic check"
     
     Assistant:
     "Running check... result is OK."
     ```

6. **Infer the cause** (by reading the task + agent type)
   - Task section shows: "You are an Explore agent. Diagnose the system."
   - Output section shows the agent did complete and returned results
   - The agent exists and has a transcript, but the spawning Agent tool-call ID doesn't match any parent's transcript
   - Possible causes: (1) the parent agent crashed before logging the tool_use, (2) the parent's transcript is in a different session, or (3) the tool_use ID was malformed

**Why this story?** Orphans are rare but important to notice. The visual indicator (amber stroke in tree view, "orphan" status in table), the rollup count, and the tooltip all point Dennison to them. The data is still readable (task, output, conversation), but the parent link is gone. He understands: "An orphan subagent is an agent whose parent transcript doesn't exist; the agent still ran and we have its data, but we don't know which other agent spawned it."

---

## STORY-106: John Compares 3 Subagents' Cost and Duration in Timeline View

**Persona**: John (3 flat Explore subagents, wants to see concurrency and cost)  
**Trigger**: Wonders if the subagents ran in parallel and which one cost the most

**Journey**:

1. **Switch to Timeline view** (click "Timeline" button)
   - Swimlane SVG appears with title: "Each bar is a subagent on a shared time axis. Overlapping bars ran concurrently; x-position ≈ when it was spawned."
   - Three rows (no MAIN_SESSION), one per subagent:
     - Row 1 (index 0): Explore-A · blue bar from 0ms to 890ms · `890 ms · $0.018`
     - Row 2 (index 1): Explore-B · blue bar from 50ms to 930ms · `880 ms · $0.017`
     - Row 3 (index 2): Explore-C · blue bar from 100ms to 980ms · `880 ms · $0.016`
   - Bars are color-coded by tier (all haiku = blue, or similar)
   - Tier legend dot appears to the left of each label (small colored circle)

2. **Hover over bars to compare**
   - Hovers over Explore-A: tooltip shows `Explore-A · 890 ms · $0.018`
   - Hovers over Explore-B: tooltip shows `Explore-B · 880 ms · $0.017`
   - Hovers over Explore-C: tooltip shows `Explore-C · 880 ms · $0.016`
   - All three bars overlap, confirming they ran concurrently (good parallelization)

3. **Click a bar to select** (clicks Explore-A's bar)
   - Detail slot opens below, showing Explore-A's full data
   - Explore-A's bar is now highlighted (thicker stroke or opacity change)
   - Breadcrumb guides back to the list

4. **Observe the span line**
   - Rollup metric shows: `span 1m 22s` (wall-clock from first subagent start to last subagent end)
   - Timeline x-axis spans exactly 1m 22s (980ms from the diagram above is ~1s; if there were longer agents, the span would be larger)

**Why this story?** John needs to see if his agents are parallelizing well. The Timeline view makes it instantly obvious: overlapping bars = concurrency. The bars' x-positions show start time, lengths show duration, and the span metric confirms the overall wall-clock. He leaves understanding: "Timeline shows me which agents ran at the same time and how long each took."

---

## STORY-107: Dennison Filters and Sorts Subagents via the Flatten Button and Table View

**Persona**: Dennison (8 subagents, wants a simple cost-sorted list to prioritize optimization)  
**Trigger**: Rolled in looking at costs; wants to see the most expensive agent first without the tree structure

**Journey**:

1. **Toggle Flatten** (click "Flatten" button while in Tree view)
   - Button becomes active (aria-pressed=true, visual highlight)
   - View auto-switches to Table (flat cost-sorted list)
   - MAIN_SESSION is removed from the list (flatten shows only actual subagents, not the main session)
   - Table now shows all 8 subagents sorted by cost descending:
     ```
     1. Coordinator-Root-1 · subagent · done · sonnet · 2m 10s · $0.198 · 45K/12K tok · 12:34
     2. Explore-Root-1 · subagent · done · haiku · 1m 5s · $0.165 · 32K/8K tok · 12:35
     3. Explore-A · subagent · done · haiku · 45s · $0.089 · 18K/4K tok · 12:36
     4. Coordinator-C · subagent · done · sonnet · 35s · $0.078 · 14K/5K tok · 12:37
     ...
     ```
   - No indentation (all at depth 0 from the display's perspective)
   - No chevrons (collapse controls are meaningless in flat view)

2. **Click the top row** (Coordinator-Root-1)
   - Detail slot opens, showing Coordinator-Root-1's trace, task, output, conversation
   - Timeline segment clicks open the drawer as usual
   - Coordinator-Root-1 is visually selected (highlight)

3. **Unflatten** (click "Flatten" button again)
   - Button becomes inactive
   - View switches back to default (Tree or Table, depending on the last non-flat view)
   - MAIN_SESSION reappears
   - Indentation and chevrons return (the nested structure is preserved via the collapse state)

4. **Observe that unflattening preserves the subtree collapse state**
   - If Coordinator-Root-1 was collapsed before flattening, it's still collapsed after unflattening
   - The collapse state is independent of the flatten state

**Why this story?** Dennison wants to prioritize: "What cost the most?" Flatten + Table gives him a cost-sorted list with zero structural noise. Unflattening returns him to the nested view with the collapse state intact. He leaves understanding: "Flatten shows me a simple sorted list; unflatten brings back the tree structure."

---

## STORY-108: Jane Debugs via Timeline Segment Clicks, Reading Exact Tool Inputs and Errors

**Persona**: Jane (power user, investigating a failed tool call in a nested subagent)  
**Trigger**: One subagent succeeded but its output looks incomplete; needs to see what tool it called and why it might have failed

**Journey**:

1. **Navigate to Subagents tab** (Tree or Timeline view)
   - Sees the subagent in question (let's call it "Scraper-1")
   - Status shows: "done" (green dot) — so the subagent itself completed, but Jane suspects a tool error inside it

2. **Click Scraper-1 to drill in** (row click)
   - Detail slot opens
   - Breadcrumb: `← all subagents / ↑ main conversation / this subagent`
   - Timeline shows segments: 3 inference, 3 tool, 2 inference, 1 tool
   - Section: "Trace — 9 steps (inference & tool calls, in order)"

3. **Hover over each segment to find the tool segment**
   - Hovers over segment 6 (the last tool segment)
   - Tooltip: `Segment 6 · Tool · 2,100 ms · Tools: scrape_web`

4. **Click segment 6** (the last tool segment)
   - Drawer opens (right side, 460px):
     ```
     TOOL — tool segment
     
     Call: scrape_web
     Input: { "url": "https://example.com", "selector": ".content" }
     Result: "ERROR: Timeout after 30s. Partial result: <div>Content snippet...</div>"
     Status: error
     ```
   - Jane sees the timeout error and partial result. The error message is clear: the tool timed out.

5. **Click segment 7 (the next inference after the error)**
   - Drawer updates:
     ```
     INFERENCE — haiku
     
     Text: "The scrape timed out; I got a partial result. Let me try a fallback approach..."
     
     Stop reason: end_turn
     Tokens: 120 in, 95 out
     ```
   - Jane sees the agent's response to the timeout: it recovered with a fallback.

6. **Read the Task section** (back in the detail slot)
   - Task: "You are a web scraper. Fetch the content from the given URL and extract the main article. If you fail, try an alternative method."
   - Jane sees the agent was explicitly instructed to try a fallback, which it did.

7. **Read the Output section**
   - Output: "Scraped content: [partial snippet from timeout] ... falling back to alternative extraction method, result: [alternative snippet]. Note: primary method timed out."
   - Output is complete; the subagent did what it was supposed to do (attempt primary, then fallback).

**Why this story?** Jane needs to debug a tool error. The timeline + segment clicks let her jump directly to the exact tool call, see the input (what was asked) and output/error (what happened). The next inference segment shows the agent's reaction. Reading the task gives context on the expected behavior. She leaves understanding: "I can see exactly which tool call failed, why it failed, and how the agent responded."

---

## STORY-109: John Uses Browser Back to Navigate Through Selected Subagents

**Persona**: John (3 flat Explore subagents, comfort with browser history)  
**Trigger**: Navigated to a subagent detail, wants to use Back button to return to the list and move to a different subagent

**Journey**:

1. **Start at Subagents tab** (list view, no detail selected)
   - URL hash: `#/tab/subagents` (or similar)

2. **Click Explore-A to open detail** (row click)
   - Detail slot opens
   - URL hash changes to: `#/tab/<sessionId>/Explore-A` (or agent ID)
   - Breadcrumb: `← all subagents / ↑ main conversation / this subagent`

3. **Click "↑ main conversation" in breadcrumb**
   - Detail slot now shows MAIN_SESSION detail
   - URL hash changes to: `#/tab/<sessionId>/MAIN_SESSION_ID` (or similar)

4. **Browser Back button**
   - Returns to Explore-A detail
   - URL hash returns to: `#/tab/<sessionId>/Explore-A`
   - Detail slot re-renders Explore-A (if it was cached, it's shown immediately)

5. **Browser Back button again**
   - Returns to the subagents list (no detail selected)
   - URL hash returns to: `#/tab/subagents`
   - Detail slot is hidden

6. **Click Explore-B to open a different subagent**
   - Detail slot opens with Explore-B data
   - URL hash changes to: `#/tab/<sessionId>/Explore-B`

7. **Browser Back button**
   - Returns to the subagents list (no detail selected)
   - URL hash returns to: `#/tab/subagents`

8. **Browser Forward button**
   - Returns to Explore-B detail
   - URL hash changes to: `#/tab/<sessionId>/Explore-B`

**Why this story?** John is familiar with browser history and expects it to work. The hash-based navigation ensures Back/Forward track the state (list vs. detail, and which detail). Each detail selection pushes a new history entry, so the browser's natural Back button feels responsive and intuitive. He leaves understanding: "Back always takes me to where I was before; I don't need the breadcrumb if I prefer the Back button."

---

## STORY-110: Rollup Metrics Teach Cost Composition and Timing Across All Subagents

**Persona**: Dennison (want to understand the total impact of all subagents on the session)  
**Trigger**: Sees the rollup line and wants to understand what each metric means

**Journey**:

1. **Load Subagents tab**
   - Rollup line appears:
     ```
     7 subagents · 3 roots · max depth 2 · 1 orphan · $0.978858 · 290/21,355 tok · span 2m 45s
     ```

2. **Hover over each metric** (if titles/tooltips are available)
   - `7 subagents`: "Total direct subagents (spawned by the Task/Agent tool) in this session. Subagents spawned inside a Workflow are shown on the Workflows tab instead."
   - `3 roots`: "Subagents spawned directly by the main session (depth 1) — the top level of the tree."
   - `max depth 2`: "Deepest nesting level reached: how many subagent→subagent spawn hops separate the furthest agent from the main session."
   - `1 orphan`: "Subagents whose spawning Agent tool-call could not be found in any transcript; they are re-homed under the main session and flagged. 0 is normal."
   - `$0.978858`: "Total reconstructed cost across all subagents. Cache-aware (cache_creation ×1.25, cache_read ×0.10) — an estimate from price tables, not a billed amount."
   - `290/21,355 tok`: "Total input / output tokens summed across every subagent."
   - `span 2m 45s`: "Wall-clock span from the earliest subagent start to the latest subagent end (includes idle gaps; not the sum of durations)."

3. **Interpret the rollup**
   - Dennison sees: 7 agents, 3 of which are direct children of main, and 4 are nested deeper
   - Cost is ~$0.98, which is expensive (might warrant optimization)
   - Tokens are 290 in, 21K out (high ratio of output tokens suggests long-running agents or code generation)
   - Wall span is 2m 45s (actual elapsed time from start to finish, with possible concurrency)

4. **Infer performance**
   - If he sees each subagent's duration in the table/timeline and sums them, he can compare to the span metric
   - If sum >> span, the agents ran concurrently (parallelization is good)
   - If sum ≈ span, the agents ran mostly serially (opportunity for parallelization)

**Why this story?** The rollup line is a dashboard; each metric answers a key question: "How many?" "At what depth?" "Was there an error (orphan)?" "How much did it cost?" "How long did it actually take?" Dennison leaves understanding: "The rollup tells me the composition of the subagent forest at a glance, and I can spot issues (orphans) or opportunities (cost, depth)."

---

## Summary

**10 stories covering the Subagents tab feature set**:

1. **STORY-101**: John understands 3 flat subagents; learns that Expand/Collapse all are disabled when there's no nesting.
2. **STORY-102**: Dennison expands/collapses a nested tree; learns how to fold subtrees and navigate the hierarchy.
3. **STORY-103**: John drills into one subagent and clicks timeline segments to see exact tool calls.
4. **STORY-104**: Dennison reads a subagent's full conversation and uses breadcrumb + Back to navigate.
5. **STORY-105**: Dennison spots an orphan subagent and investigates why the parent link is missing.
6. **STORY-106**: John uses Timeline view to compare cost and duration, spotting concurrent execution.
7. **STORY-107**: Dennison uses Flatten to get a simple cost-sorted list.
8. **STORY-108**: Jane debugs a failed tool call by clicking segments and reading the error message.
9. **STORY-109**: John uses browser Back/Forward to navigate between detail views and the list.
10. **STORY-110**: Dennison interprets the rollup metrics to understand cost, depth, and timing.

All stories reference **ACTUAL** labels and features from the code:
- View modes: Tree, Timeline, Table
- Controls: Expand all, Collapse all (disabled when flat), Flatten
- Detail sections: Trace (N steps), Task (prompt), Output (last assistant text), Conversation (every turn)
- Breadcrumb: "← all subagents / ↑ main conversation / this subagent"
- Rollup metrics: totalSubagents, roots, max depth, orphans, cost, tokens, span
- Status legend: done (green), running (blue), orphan (amber), session (gray)
- Tree visual: indented rows, chevrons (▼ expanded / ▶ collapsed), child counts
- Timeline: swimlane bars on shared time axis, hover tooltips, segment clicks
- Table: columns (Agent, Type, Status, Model, Duration, Cost, Tok I/O, Started), clickable rows
- Trace detail: Timeline SVG with segment click → drawer (inference vs tool), with exact input/output, error flags, thinking text, tokens/cost, stop reason
- Drawer: right-side panel, reused for inference vs tool detail, close on X or scrim
- Navigation: breadcrumb buttons, browser Back/Forward, hash-based history

