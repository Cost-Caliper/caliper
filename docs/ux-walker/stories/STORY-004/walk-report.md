# STORY-004 Walk Report — Toggle empty ("ghost") sessions on/off

**Verdict: FAIL** (one high-severity, clearly reproducible bug)

## What I did
1. On Sessions tab (`~/develop/agent-university`), found the toggle button at the bottom of the list: "Show 2 empty sessions (no turns, no cost)".
2. Clicked it. Result: a new "Yesterday" date group appeared showing "2 sessions · $0.000", with two ghost-styled rows: `(no prompt captured)` in dim/gray text, `$0.000` in muted color, one carrying an "ACTIVE" pill. Button label correctly flipped to "Hide empty sessions". This half of the toggle works exactly as documented.
3. Clicked "Hide empty sessions" to revert. **Nothing happened** — ghost rows stayed visible, button label stayed "Hide empty sessions".
4. Re-verified this was not a stale-ref artifact of my browser tool:
   - Re-read a fresh accessibility snapshot and clicked the new ref — no change.
   - Queried the DOM directly for `#sess-empty-toggle` and clicked that exact node via CSS selector — no change.
   - Ran `document.getElementById('sess-empty-toggle').click()` twice via `eval` (bypassing any automation-layer click quirks entirely) — still no change; `.sess-row-ghost` count stayed at 2 and the label stayed "Hide empty sessions".
5. Confirmed the state is recoverable: a full page reload correctly reset to the default (0 ghost rows visible, button reading "Show 2 empty sessions..."). So the bug is a client-side in-memory state/handler issue, not a persisted server-side corruption.

## UX audit
- **Happy-path clarity**: fail. The toggle is the story's entire purpose and the "un-toggle" direction is completely broken — a user who shows empty sessions has no in-page way to hide them again except reloading the whole app (which also loses any other UI state, e.g. scroll position, selected view).
- **Feedback**: fail for the second click — zero visual or textual feedback that the click was even registered.
- **Recovery**: partial pass — reload does recover correctly, so it's not a permanent dead end, just an undiscoverable one (nothing tells the user "reload to fix this").
- **Simplicity/copy**: pass for the toggle's copy and ghost-row styling itself (clear, well-labeled, appropriately de-emphasized visually).

## Findings
1 high-severity finding — see findings.json. This is the single worst finding across all 4 stories I walked: a documented, core interaction is broken in a way a real user would hit on their very first attempt to toggle empty sessions back off.
