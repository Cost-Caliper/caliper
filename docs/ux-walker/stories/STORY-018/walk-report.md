# STORY-018 — Main Conversation Trace: Lazy Load & Timeline

**Persona**: John (Active Session tab, main conversation trace deep-dive)
**Sessions under test**:
1. Plain session — "tell my frind about this user, be concise" ($0.808, 4 turns, 3 trace steps)
2. Rich session — "Feed: call this agent \"Agent University\"…" ($253/$622 total, 605 turns,
   471 trace steps, 228 conversation turns, 15 workflows, 3 subagents)

**Verdict: PASS** — the main-trace feature works correctly and stays responsive at both the
tiny-session and large-session (471 steps / 28h19m span) ends of the scale. No console errors
at any stage. One low-severity note on accessibility (timeline segments lack an accessible
name unlike the outer waterfall bar).

## Walk — plain session

1. Opened `<details id="session-main-trace">` via its summary. On a 7-second/4-turn session the
   fetch is effectively instant, so the "Reconstructing the conversation…" loading copy could
   not be visually confirmed (window too short to capture a frame in it) — not a defect, just a
   timing limitation of this particular fixture.
2. Rendered content: Timeline SVG (`main session` bar, 7.0s · 1% tool, blue/amber segments),
   meta chips (model `fable-5`, wall 7.0s, cost $0.808449, tok 33,460→906, cache 94,146wr/60,172rd,
   turns 4, tool calls 1, tools Read), "Trace — 3 steps" (Inference/Tool·Read/Inference rows with
   durations), Task box (verbatim prompt), Conversation disclosure, Output box.
3. **Trace-row click → drawer**: clicked row 2 ("Tool · Read"). Drawer opened correctly: "Tool
   call" header, "main session" breadcrumb, "Read ✗ error" badge, highlighted Input JSON
   (horizontally scrollable for the long path), Result box with a 102-char badge showing the
   real error text ("File does not exist. Note: your current working directory is
   /Users/dennison/develop/agent-university."). Exact match to the step clicked.
4. **Timeline-segment click → drawer**: clicked the first SVG segment (`data-seg-idx="0"`) via
   dispatched click (the segment itself has no accessible name in the a11y tree — see finding
   F-018-1). Drawer opened: "Inference step", decided-to-call "Read", output/input/cache-write
   token counts, cost, speed (74 tok/s), stop reason `tool_use`, model, turns — and the honest
   fallback "(no text — this step only emitted a tool call)" for the missing model-output text.
   Same underlying step as trace row 1, consistent with the shared-drawer-component design.
5. **Conversation section**: expanded "Conversation — every agent ↔ user text, in order (2
   turns)". USER/AGENT roles clearly labeled and color-coded, full text legible, good line
   length and spacing.
6. Closed the drawer via its own Close button — returned cleanly to the intact trace detail
   underneath, no layout shift or leftover overlay.

## Walk — rich session (605 turns, 471 trace steps)

1. Selected from Sessions tab → landed on Active Session; full rollup rendered immediately
   ($622 total est., 15 workflows, 3 subagents, top-3 ≈ 60% of spend, model-split and measured
   generation-speed lines all populated). No jank switching sessions.
2. Opened the main trace. Fully rendered: model `opus-4-8`, wall 28h 19m 9s, cost $253.337847,
   tok 299,215→877,777, cache 19,210,065wr/219,668,881rd, turns 605, tool calls 251, tools list
   (Skill, Bash, Read, Write, Workflow, TaskCreate, TaskUpdate, Agent, Edit, Monitor). "Trace —
   471 steps" — the count label correctly reflects a much larger N than the plain session,
   confirming the "Trace — N steps" wording is dynamic, not hardcoded.
3. Timeline SVG rendered the full 28h19m span with visibly dense inference/tool tick marks —
   no rendering breakage, no overflow, no visible truncation of the bar itself.
4. DOM size check inside `#session-main-trace`: ~3,585 nodes for 471 steps — not virtualized,
   but not pathological either; click round-trips measured ~160ms, no perceptible input lag.
5. **Trace-row click on a row deep in the (scrollable) list** opened the drawer correctly once
   using a freshly-taken element reference (see methodology note below — an earlier attempt
   using a stale reference from a prior snapshot clicked the wrong element after the DOM
   re-rendered; this was a test-tooling artifact, not an app bug, and is called out so it isn't
   mistaken for one).
6. **Conversation section** (228 turns) opened correctly (`details.open === true` verified via
   DOM), rendering real content including an authentic embedded error string — "API Error: 402
   Workspace has insufficient balance. Top up to continue." — shown honestly in the "Output —
   its last assistant text" box rather than being swallowed or prettied over. Good adherence to
   the honesty-copy doctrine (STORY-056) even for embedded/nested error text.
7. `agent-browser errors` and `agent-browser console` were both checked after every major step
   (session switch, trace open, row click, segment click, conversation expand) — clean at every
   checkpoint, no console errors, no dropped network requests observed.

## Methodology note (not an app finding)

Element references returned by the browser-automation snapshot tool go stale the moment the
DOM changes (e.g., after a drawer opens/closes and re-renders siblings). A ref captured before
such a change can silently resolve to a different element afterward. This produced one false
alarm during the walk (a "missing drawer" that was actually a click landing on an unrelated
waterfall bar). Re-snapshotting immediately before each click avoided the problem. Recorded
here so the next walker doesn't mistake stale-ref clicks for real app bugs.

## Findings

See `findings.json` — one low-severity accessibility finding on timeline-segment naming.

## Screenshots

Plain session: `00-active-session-plain.png`, `01-trace-opening-loading.png`,
`02-trace-row-click-drawer-tool.png`, `03-timeline-segment-click-drawer.png`,
`04-conversation-expanded.png`.

Rich session: `05-sessions-tab-for-rich.png`, `06-rich-session-active-view.png`,
`07-rich-trace-loading.png`, `08-rich-trace-scrolled-into-view.png`,
`09-rich-trace-row-click-drawer.png`, `10-rich-trace-row7-drawer-retry.png`,
`11-rich-conversation-228-turns.png`.
