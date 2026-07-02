# STORY-032 — Subagents Tree/Timeline/Table switching + Flatten

**Verdict: PASS**

## Path walked
1. From the rich session ("Feed: call this agent \"Agent University\"…"), opened the
   Subagents tab. Landed on Tree view (default): rollup line "3 subagents · 3 roots ·
   max depth 1 · 0 orphans · $10.215028 · 46,107/7,236 tok · span 8h 31m 42s", agent-type
   badge "general-purpose 3". This is a genuinely flat forest — MAIN_SESSION root with 3
   direct children, no chevrons.
2. Confirmed "Expand all" and "Collapse all" are disabled, each carrying the exact
   explanatory tooltip: "Nothing to fold — all subagents here are direct children (no
   nesting)" (checked via `.title` on both buttons).
3. Clicked "Flatten" → button became visually active (white background) and
   `aria-pressed="true"` / class `active`; view auto-switched to Table; MAIN_SESSION
   row disappeared; remaining 3 rows sorted by cost descending ($5.70 → $3.38 → $1.14);
   no indentation, no chevrons.
4. Switched to Timeline view (while Flatten remained on) → 3 swimlane bars on a shared
   time axis, tier-color dot per row, explanatory caption below ("Each bar is a subagent
   on a shared time axis. Overlapping bars ran concurrently…"). Flatten stayed visibly
   active across the view switch, confirming Flatten and view-mode are independent
   controls as documented.
5. Switched back to Table, then clicked "Flatten" again to unflatten →
   `aria-pressed="false"`; view returned to Table (the last non-flat view used, matching
   spec) with MAIN_SESSION reappearing showing a "(3)" child count.
6. Switched to Tree view to close the loop — tree rendered correctly with the 3 children
   again.

## Per-view clarity judgment
- **Tree**: clear at this flat depth; MAIN_SESSION root plus 3 named children in colored
  bordered boxes, legend below explains tier dots, status colors, and edge semantics
  (edge hue = spawning agent's tier, dashed = parent not found). Good for a first-look
  orientation.
- **Timeline**: very effective for the concurrency judgment this story asks about —
  overlapping bars are immediately visible on a shared axis, with per-bar duration/cost
  labels.
- **Table**: clean, sortable-looking columns (Agent, Type, Status, Model, Duration,
  Cost, Tok I/O, Started) match the spec exactly; best view for "what cost the most."

## Seg-control state clarity — minor finding
The view seg-control (Tree/Timeline/Table) and the Flatten toggle are accessibly correct
(`aria-pressed` is right on all four buttons, verified via DOM query), but they render
with the *same* white/"active" visual treatment and sit in the same button row. At a
glance it isn't obvious that "Table (active)" and "Flatten (active)" are two independent
kinds of control (one is a mutually-exclusive view selector, the other is a modifier
toggle) rather than one flat set of buttons. See finding F-032-1 (low severity).

## Screenshots
- `00-subagents-tree-landing.png` — Tree view, flat forest, disabled fold buttons
- `01-flatten-on-table.png` — Flatten active → Table, cost-sorted, no MAIN_SESSION
- `02-timeline-view.png` — Timeline view with Flatten still active
- `03-table-view-columns.png` — same as 01 (Table columns confirmed)
- `04-unflatten-restores.png` — Flatten off → Table view restored with MAIN_SESSION
- `05-back-to-tree.png` — Tree view restored
