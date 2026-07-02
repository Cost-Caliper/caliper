# STORY-010 Walk Report — Active & live pills

**Verdict: PASS with one medium finding** (active pill missing tooltip; live pill not directly observable in this window)

## What I did
1. On `~/develop/agent-university`, clicked the "Feed: call this agent..." session to activate it, returned to Sessions tab, and confirmed via screenshot that an "ACTIVE" pill correctly rendered on that exact row (styled as a bordered blue badge).
2. Cross-checked against the live `/v1/sessions` API response: `activeSessionId` matched the session I had clicked — server and UI state agree.
3. Inspected the pill's DOM node directly: `<span class="sess-active-pill">active</span>` — **no `title` attribute at all** (empty string). This is the story's headline finding.
4. Switched the project picker to `~/conductor/workspaces/agent-university/islamabad · 1 session` (the conductor workspace this very agent is running in, per the task brief, to try to catch the "live" pill in the act).
5. Checked the islamabad session's mtime via the API: it was already 351s old (past the 120s live-pill threshold) on first check, and still ~386s old after clicking Refresh and waiting — this agent's own transcript only flushes at Claude Code turn boundaries, which didn't land inside this observation window. So the "live" pill correctly did NOT render in either check (consistent with the documented rule), but I could not directly capture its rendered appearance/tooltip in a screenshot this session.
6. Opened the islamabad session into Active Session tab and confirmed the identity strip renders correctly: `VIEWING SESSION "yes lets spin one up." · Mon, Jun 29 21:00 · $794 · [7 wf] [15 sub] · switch session ↗` — title matched, badges correct, no live pill shown there either (consistent with the same mtime staleness).
7. Restored state: switched the project picker back to `~/develop/agent-university · 5 sessions`, confirmed via DOM value.

## UX audit
- **Feedback/state accuracy**: pass. Active-pill placement matches server state (`activeSessionId`) correctly and consistently across a project switch and a return-to-tab.
- **Accessibility/tooltips**: fail for the active pill (see finding 1) — this directly fails the task's own instruction to "verify tooltips explain the pills" for both pills; only the live pill (per source/docs) is documented to carry one.
- **Consistency**: the two pills are asymmetric in richness — live pill has a full explanatory sentence (per the docs); active pill has none. A first-timer seeing "active" for the first time has no in-app way to learn what it implies.
- **mtime rule correctness**: pass, as far as could be observed — the pill correctly stayed hidden once the session aged past 120s, and did not falsely appear.

## Findings
1 medium (active pill has zero tooltip — asymmetric with the live pill) + 1 low (evidence gap: could not catch the live pill actively rendering in this window, not a confirmed defect either way).
