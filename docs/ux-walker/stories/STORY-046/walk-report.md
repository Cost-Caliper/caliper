# STORY-046 — Deep-link reload restores tab/session/drill-in position

**Type**: Short · **Persona**: John · **Result**: PASS

## Steps executed

1. Opened `http://localhost:8787` (session `ux-walker-8787`), landed on Sessions tab,
   project folder already `~/develop/agent-university · 5 sessions`.
2. Clicked the rich session row — `"Feed: call this agent \"Agent University\"..."`
   (15 wf · 3 sub · $97.64). URL became `#/session/738d4acc-35fb-492c-bcec-153e4b8d1d68`.
   **Note**: the actual hash format is `#/session/<uuid>` (singular "session"), not
   `#/observe/<sessionId>` as one catalog example suggested. Recording actual format
   per catalog gap note #6.
3. Clicked "Subagents" tab → `#/subagents/738d4acc-35fb-492c-bcec-153e4b8d1d68`.
4. Clicked the "Automate fre..." subagent node in the tree → drilled in.
   Final URL: `#/subagents/738d4acc-35fb-492c-bcec-153e4b8d1d68/aca5aedc8158399a9`.
   Confirmed detail panel open: timeline, meta chips (model opus-4-8, wall 12m 43s,
   cost $3.375190, tok 22,770→3,678, cache 101,121wr/5,074,768rd, turns 120, tool
   calls 66), 133-step trace, Task block, breadcrumb
   "← all subagents / ↑ main conversation / this subagent".
5. Fresh `agent-browser open` of the exact full URL (new navigation, not history
   back/forward) — a true cold reload of the hash-encoded state.
6. Captured screenshots at 0s, 1s, and ~2.5s after the open to look for a flash of
   wrong state (e.g., landing on Sessions tab first, or an intermediate empty state).
7. Checked `console` and `errors` — both clean, no output.
8. Scrolled to top and re-screenshotted to verify tab selection + identity strip;
   scrolled to the detail-panel top to verify the breadcrumb.

## Result — restore quality

- **Tab**: Subagents tab correctly shown selected/underlined immediately. No flash of
  Sessions tab or any other tab.
- **Session**: Identity strip correctly reads `"Feed: call this agent \"Agent
  University\". Then get up to speed with what w…" · Mon, Jun 8 11:34 · $97.64 ·
  15 wf · 3 sub` — the exact same session, restored server-side (matches doctrine:
  reload re-POSTs `/v1/session/select` before rendering).
- **Drill-in**: The exact same subagent ("Automate fre…", $3.38, 12m 43s) is
  reopened with its full detail: tree shows it highlighted (green selection ring),
  detail panel shows the identical timeline/meta/trace/task content as before the
  reload, and the breadcrumb `← all subagents / ↑ main conversation / this
  subagent` is present and correctly wired.
- **Flash of wrong state**: none observed. The immediate (0s) screenshot already
  showed the fully-restored drill-in view — no intermediate "Sessions tab" or blank
  frame was caught across three screenshots at 0s/1s/2.5s. This looks like the
  hash is parsed and the session-select + subagent-select happen before first
  paint (or fast enough that no frame was caught mid-transition).
- **Console/page errors**: none.

## Judgment (rubric)

- **Happy-path clarity / Navigation** (pass): user always knows where they are —
  tab, identity strip, and breadcrumb are all internally consistent after reload.
- **Error handling** (pass, not exercised here): not applicable — no error path hit
  in this run (session existed and was valid). STORY-051 covers the deleted-session
  variant.
- **Known limit** (per catalog): accordion/expansion state elsewhere in the app is
  documented as NOT hash-encoded — this story doesn't hit that limit since the
  subagent drill-in itself IS hash-encoded and did restore.

## Verdict: PASS — no findings.

This is a genuinely strong deep-link implementation: session reselect, tab switch,
and subagent drill-in are all restored in a single reload with no visible
flash-of-wrong-state and no console errors.
