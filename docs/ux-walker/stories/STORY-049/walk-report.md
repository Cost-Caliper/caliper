# STORY-049 — Fresh install: all tabs empty [WALK]

**Type**: Short · **Persona**: John · **Result**: PASS

## Steps executed

1. From `~/develop/agent-university` (dark theme, Sessions tab), opened the
   PROJECT FOLDER native `<select>` (`#project-picker`, 206 options) and scanned
   for a zero-session folder. Many exist, e.g.
   `-Users-dennison-conductor-workspaces-agent-university-belgrade-...03-pocs ·
   0 sessions`. Selected that one via
   `agent-browser select "#project-picker" "<value>"`.
2. Confirmed empty state on **Sessions** tab: icon placeholder, "No sessions in
   this folder yet" heading, "Run Claude Code in this project and its sessions
   will appear here." guidance. Footer explainer text still visible below.
3. Switched to **Workflows** tab: "NO SESSION SELECTED · pick one from the
   Sessions tab" banner with a "Sessions ↗" recovery button, "No workflow runs
   yet" heading, guidance ("Run a Workflow in this session and it'll appear here
   automatically — with a per-agent timeline, cost, and tool/inference
   breakdown."), and the honest caveat "Not watching a session — set
   WFLENS_SESSION_DIR."
4. Switched to **Subagents** tab: same "NO SESSION SELECTED" banner, "No
   subagents in this session" heading, the Task/Agent-tool explainer + pointer
   ("Subagents spawned inside a Workflow show under the Workflows tab."), and
   "Set WFLENS_SESSION_DIR to a session dir."
5. Checked `console`/`errors` after each tab switch — clean throughout.
6. Switched PROJECT FOLDER to
   `~/conductor/workspaces/agent-university/islamabad · 1 session` (had to
   resolve the exact `<option value>` via `eval` first — the visible label text
   didn't match the `select` command's matcher on the first attempt, see
   Gotcha below). Confirmed 1 session, "yes lets spin one up." (ACTIVE,
   7 wf / 20 sub, $395) — no LIVE pill visible on this snapshot (the session's
   transcript mtime was outside the 2-min freshness window at the moment
   checked).
7. **Bonus finding while resolving the select-value gotcha**: landed briefly on
   `~/conductor/workspaces/open-agents/provo`, which had two rows showing a
   pulsing green **LIVE** pill. Extracted the live session row's real DOM via
   `eval`, confirming the exact tooltip copy on `.sess-live-pill[title]`:
   `"Transcript updated in the last 2 minutes — this session appears to be
   running right now. Stats are its progress so far; hit Refresh to update."`
   This matches the STORY-010 catalog description exactly — recording it here
   since it's the same shared pill component.
8. Switched PROJECT FOLDER back to `~/develop/agent-university` (5 sessions).
9. Tested the empty-sessions toggle: clicked "Show 2 empty sessions (no turns,
   no cost)" → a new "Yesterday" date group appeared with 2 ghost-styled rows:
   dimmed text, "(no prompt captured)" fallback title, `0t`, `$0.000`. One ghost
   row even carries an "ACTIVE" pill (server-selected but zero-turn — a valid
   edge case, not a bug).
10. Clicked "Hide the 2 empty sessions" → the "Yesterday" group disappeared,
    list reverted to the 3 normal sessions, button reverted to "Show 2 empty
    sessions (no turns, no cost)".
11. Clicked "Show" a third time → ghost rows reappeared correctly. Full
    Show → Hide → Show cycle confirmed — **the toggle correctly re-hides**,
    no stuck state, no duplicate rows, no console/page errors at any step.
12. Set end state: clicked the rich session row ("Feed: call this agent
    \"Agent University\"...") to land on Active Session tab with it active;
    confirmed theme is `dark` via
    `localStorage.getItem('ct-theme')` and folder is `~/develop/agent-university`.

## Gotcha (not a product bug — walker note)

The native `<select id="project-picker">` command needs the exact `<option
value>`, which for conductor/workspace paths is a slash→dash-sanitized slug
(e.g. `-Users-dennison-conductor-workspaces-agent-university-islamabad`), not
the pretty `~/conductor/workspaces/agent-university/islamabad` label shown in
the UI. `agent-browser select` matches loosely enough that an imprecise value
silently landed on a different, unrelated option (`open-agents/provo`) without
erroring — worth flagging to future walkers: verify the post-select value via
`eval "document.querySelector('#project-picker').value"` after any `select`
against this control.

## Result — empty/sparse state quality

- **Sessions tab empty state**: clear icon + heading + actionable guidance.
  Matches rubric "Empty states: helpful message with action suggestion" → pass.
- **Workflows/Subagents tabs when no session selected**: consistent
  "NO SESSION SELECTED" banner + one-click "Sessions ↗" recovery button on
  both tabs — good happy-path recovery, no dead end.
- **Workflows/Subagents tabs' deeper empty explainer text**: goes beyond a
  generic "no data" message — explains what would need to happen to populate
  the view (run a Workflow / use Task-Agent tool) and even names the exact env
  var to set (`WFLENS_SESSION_DIR`) for the misconfigured-server case. This is
  honest, specific, actionable copy — a step above the rubric's "warn" bar
  (generic "no data") straight to "pass" (helpful message + action).
- **Ghost/empty-session rows**: dimmed styling + "(no prompt captured)"
  fallback is a good honest-copy pattern (ties to catalog STORY-055's
  "nothing renders blank" principle) — no blank/undefined text leaked through.
- **Toggle correctness**: Show → Hide → Show is fully idempotent and
  bug-free — this was flagged in the task brief as "a fixed bug" and the fix
  holds up under three consecutive toggles.
- **Live pill**: present, correctly conditioned on transcript-mtime freshness
  (absent on the islamabad session outside the 2-min window, present on two
  genuinely-fresh sessions in a different folder), and carries the exact
  documented explanatory tooltip.

## Verdict: PASS — no findings.

Empty and sparse states across Sessions/Workflows/Subagents are consistent,
honest, and actionable. The empty-sessions toggle bug fix holds under a
three-step Show/Hide/Show cycle. No console or page errors were observed
across any of the 10 project-folder switches and tab changes in this walk.
