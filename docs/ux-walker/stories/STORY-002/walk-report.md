# STORY-002 Walk Report — Power user switches project folder

**Verdict: PASS**

## What I did
1. Started on Sessions tab with `~/develop/agent-university · 5 sessions` active (picker confirmed 203 known folders — even more than the story's "197 projects" premise, consistent with a large power-user machine).
2. Selected `~/develop/open-agents · 21 sessions` from the picker (a folder with many sessions, per the instructions).
3. Verified via DOM (`#project-picker`.value) that the underlying select correctly updated to the open-agents slug, and the picker label re-rendered to `~/develop/open-agents · 21 sessions`.
4. Session list re-fetched and changed completely: new date groups ("Yesterday", "Mon, Jun 29", "Sun, Jun 28", etc.), all with open-agents-specific titles, costs, and workflow/subagent badges. An "ACTIVE" pill correctly appeared on the row matching that project's currently-selected session (a different session than agent-university's).
5. Scrolled through further date groups (Tue Jun 9, Mon Jun 8 with 3 sessions, Sun Jun 7, etc.) — rollup headers and per-row data all rendered cleanly and consistently with the schema seen in agent-university.
6. Switched back to `~/develop/agent-university · 5 sessions` — confirmed via DOM value that it round-tripped correctly.

## Note on an initial false alarm
On my first attempt, immediately after a plain page reload the picker showed `~/conductor/workspaces/agent-university/islamabad` (not `~/develop/agent-university`, which had been in the very first screenshot of the whole session). This looked like a switch bug at first. Investigation showed this is **expected**: the active project is server-side state that persists across reloads, and a different automated process (a prior test/tool run) had last selected islamabad server-side before I reloaded. Once I retried the actual STORY-002 select against the correct, freshly-read `ref`, the switch to open-agents worked correctly and consistently on repeated tries. No bug.

## UX audit
- **Feedback**: pass — picker label, list, and date groups all update together with no stale/mixed state observed.
- **Labels**: pass — each option shows path abbreviation + session count, exactly as documented.
- **Happy-path clarity**: pass for the switch action itself.
- **Simplicity/scale**: warn — see findings.json. A flat list of 200+ options with no search is a real usability tax for a power user, though this matches the catalog's own already-known gap (not a regression, a standing limitation).

## Findings
1 suggestion-level finding (picker scale/no-filter) — already a known/documented gap in the catalog, reconfirmed live. No high/critical issues; the core switch-and-list-refresh mechanism works correctly and reliably.
