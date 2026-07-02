# Error Handling, Empty States & Honesty Cues — UX Story Catalog

**Topic**: Error handling, empty states, and guidance text that prevents user confusion and sets correct expectations.

**Context**: Control Tower reconstructs cost/latency/traces from local session transcripts and harness data. When sessions are missing, servers are down, or details fail to load, the UI must clearly explain what's happening and what to do next.

---

## STORY-001: Fresh Install — John's First Run with Nothing to Show

**Persona**: John, engineer running Claude Code for the first time in a fresh project folder with no sessions yet.

**Trigger**: User launches Control Tower dashboard in a project with zero prior conversations.

**Journey**:
1. Dashboard loads; the **Sessions tab** shows empty state
2. Displays icon (network diagram) + title **"No sessions in this folder yet"**
3. Sub-text: **"Run Claude Code in this project and its sessions will appear here."**
4. **Workflows tab** shows: **"No workflow runs yet"** + "Run a Workflow in this session and it'll appear here automatically…" + hint "Add a workflow to your project and run it"
5. **Subagents tab** shows: **"Subagents you launch with the Task/Agent tool appear here as a parent → child tree."** + "(Subagents spawned inside a Workflow show under the Workflows tab.)"
6. All stat cards show **"—"** (em-dash, muted gray)
7. **Workflow picker** is empty or shows **"— Select Workflow —"** placeholder
8. **Graph panel** shows blue-gray box: **"Select a workflow to view its graph."**

**What he sees**: Calm, honest messaging that explains what each section tracks. No red errors, no spinners. The UI acknowledges emptiness and guides him to next steps.

**Edge cases**:
- If ANTHROPIC_API_KEY is not set in live mode, **Credential Warning** banner shows: **"⚠ Set ANTHROPIC_API_KEY to run live · Replay is free"** and **Run button is disabled** (tertiary style, not primary).

**Validation**: 
- Empty state copy is exact from `ctEmptyHtml()` template
- All tabs are interactive (session picker works, mode toggle works) but offer no data to view
- Stat cards render as **"—"** via `resetStatCards()` with `.muted` class

---

## STORY-002: Server Not Configured — Forgotten Session Directory

**Persona**: A user whose server was launched without the `WFLENS_SESSION_DIR` environment variable set.

**Trigger**: Dashboard loads; server is running but session dir is not configured.

**Journey**:
1. When user navigates to **Workflows tab**, banner appears below the filter bar: **"Watching [session-dir]"** or **"Not watching a session — set `WFLENS_SESSION_DIR`."**
2. If workflows list is empty, the list body shows: **"Watching <code>~/path/to/session</code>"** in a small hint block
3. User clicks the **Sessions tab** → list shows empty + hint: **"Watching <code>~/path/to/session</code>"** OR **"Set <code>WFLENS_SESSION_DIR</code> to a session dir."**
4. If server responds with **HTTP 503 NOT_CONFIGURED** error on `/v1/sessions`, the list shows: **"Could not load sessions: WFLENS_SESSION_DIR is not set — no project dir to browse"**
5. **Subagents tab**: If server returns 503, message is: **"Could not load subagents: WFLENS_SESSION_DIR is not set — cannot observe native runs"**
6. The **Run button remains enabled** (user can still replay if cassettes exist)

**What he sees**: A friendly hint telling him exactly which environment variable to set and how (with a `<code>` block for copy-paste).

**Edge cases**:
- If WFLENS_SESSION_DIR is partially misconfigured (dir does not exist or is not readable), server returns empty list (graceful degradation) rather than error
- The hint helps distinguish "no data yet" from "server is misconfigured"

**Validation**:
- 503 error from `jsonErr(res, 'NOT_CONFIGURED', '…', 503)` is caught in `loadObservedList()` and `loadSubagentTree()`
- Hint is rendered by `setWatchingHint()` which fetches `/v1/health` and displays `bridge.sessionDir`
- Copy exact error message from server response

---

## STORY-003: Deep-Link to Deleted Session — Hitting a 404

**Persona**: A user with a bookmarked or shared URL like `#/tab/sessionId`, where the session has since been deleted or moved.

**Trigger**: User follows a deep-link to a session that no longer exists in the project folder.

**Journey**:
1. User navigates to hash `#/tab/12345abc`
2. Dashboard tries to load session via `apiFetch('/v1/sessions/:id')`
3. Server responds with **HTTP 404 NOT_FOUND**: **"No such session in this project"**
4. Dashboard catches error in `loadSessionDetail()` at the fetch catch block
5. **Session strip** (identity bar) shows: **"No session selected"** button text **"Sessions ↗"** to jump back to Sessions tab
6. The **Active Session tab** body shows placeholder: **"Could not load session: HTTP 404"** (or server's error detail)
7. All drill-in tabs (Session waterfall, Session nodes) are hidden/disabled
8. **Workflows & Subagents tabs** are still visible but show empty or "no data" states

**What he sees**: A clear "not found" message + a helpful button to go back to Sessions tab to pick a valid one.

**Edge cases**:
- If the session file was deleted between page load and tab click, the error appears only in the drill-in panel
- If user bookmarks a *subagent* deep-link (`#/tab/sessionId/agentId`) where the parent session is deleted, the session load fails first, and the subagent drill-in never opens

**Validation**:
- Error is caught and displayed by `showError()` which renders to `#error-banner`
- Banner shows code **"INTERNAL"** (the generic client-side error handler) + message from server
- User can click "Sessions ↗" button or the "Sessions" nav tab to recover

---

## STORY-004: Fetch Failures Mid-Run — Server Dies, Connection Lost

**Persona**: A power user running a live workflow; the server or network connection dies mid-run.

**Trigger**: User clicks "Run Workflow" in live mode. Telemetry streams over SSE. Network is interrupted or server crashes.

**Journey**:
1. Initial `/v1/runs` POST succeeds; SSE stream starts
2. **Run label** shows: **"Running…"** with spinner
3. **Timeline** shows incoming agent calls as they arrive (pending bars)
4. Mid-stream, SSE connection drops (error event with no data)
5. Client-side error handler in `listenToStream()` detects the disconnect
6. **Error banner** pops up red: **"INTERNAL: SSE connection lost"** with next-step: **"Reload and try again."**
7. **Run button is re-enabled** and says **"Run Workflow"** (no longer "Running…")
8. **Pending bars** (calls that started but didn't complete) freeze in place with a `.t-bar-frozen` class (faded gray color)
9. User can inspect partial results or reload to reset

**What he sees**: Honest acknowledgment that the connection was lost + clear recovery path (reload). Partial data remains visible (not wiped).

**Alternatives**:
- If server responds with an app-level error event (e.g., `MISSING_CREDENTIAL`), the error banner shows the code + message + contextual next steps (e.g., "Set the ANTHROPIC_API_KEY environment variable and restart the server")

**Validation**:
- SSE error event handler in `listenToStream()` checks `!e.data` to distinguish network loss from app errors
- Frozen bars get `.t-bar-frozen` class; pending bars that completed normally get `.t-bar-ok` (green) or `.t-bar-error` (red)
- Error banner is reset on next "Run Workflow" click via `clearRunState()`

---

## STORY-005: Partial Workflow Details — Load Fails for Some, Not All

**Persona**: A user inspecting a session with multiple workflows; some workflow details fail to load from disk or server.

**Trigger**: Dashboard is reconstructing a session that has 3 workflows. When fetching per-workflow detail, one of the three fetch calls fails.

**Journey**:
1. **Insight Card** (model-split breakdown) is being rendered
2. Client tracks failed detail fetches in `token.wfDetailsFailed`
3. In `renderSessionInsights()`, if some details failed:
   - The **model-split bar** is still shown with available data (e.g., only 2 of 3 workflows)
   - Below the bar, a **legend line** appears in muted gray: **"partial — 1 workflow detail unavailable"** (or "details" if >1)
4. The **potential savings chip** also shows "partial" if applicable
5. **Per-agent timeline** still renders, but only includes calls from the successful workflows
6. The failed workflow's row in the workflow list shows as grayed-out or with a warning indicator

**What he sees**: The UI gracefully degrades and labels itself "partial" so he knows some data is missing. He's not left wondering why the cost/model breakdown doesn't add up.

**Exact copy**:
- Legend: **"partial — {failedDetails} workflow detail{s} unavailable"** (conditional pluralization)
- When details are being computed: **"computing model split…"**
- When details cannot be loaded: **"model split unavailable"**

**Validation**:
- Message is built by `renderSessionInsights()` line 2690
- Conditional text is in parentNote: `failedDetails ? '… partial — {count} …' : ''`
- The insight card remains visible (not hidden) so user can see partial results

---

## STORY-006: Ghost Rows — Sessions with Zero Turns and Zero Cost

**Persona**: A user whose Claude Code run crashed or never ran a full conversation (0 assistant turns, 0 cost).

**Trigger**: Session file exists but has no conversation turns, hence no cost.

**Journey**:
1. **Sessions list** loads; some sessions show `turns: 0`, `costUsd: 0`
2. By default, these **empty sessions are hidden** from the list
3. A **toggle button** appears at the bottom: **"Show 3 empty sessions (no turns, no cost)"**
4. User clicks the button; the list expands and includes rows for zero-turn sessions
5. Each zero-turn row shows:
   - Session title: **"(no prompt captured)"** or a short user message (even if no turns followed)
   - `turns: 0`, `cost: $0.000000`, wall-clock: 0 ms
   - No model tag (or "unknown")
   - No "live now" or active pill (since it's closed)
6. User clicks one; the **Active Session tab** loads
7. **Stat cards** show: `calls: 0`, `cost: $0.00`, `tokens: 0 / 0`, etc.
8. **Timeline** shows placeholder: **"Waiting for first call…"** (because no calls were recorded)
9. **Main trace** section exists but is empty or shows **"Reconstructing the conversation…"** briefly, then **"No turns recorded"**

**What he sees**: Sessions that went nowhere are not cluttering his list by default. But he can peek at them if needed, and they're labeled honestly as "empty" so he knows what to expect.

**Exact copy**:
- Title when no prompt: **"(no prompt captured)"**
- Toggle button: **"Show {N} empty session{s} (no turns, no cost)"** → when shown: **"Hide {N} empty sessions"**
- Placeholder in timeline: **"Waiting for first call…"**
- Session row badge (when session is active now): **"live now"**

**Validation**:
- `turns: 0` and `costUsd: 0` together mark a session as "empty"
- `showEmptySessions` state toggles visibility via `applySessions()`
- Exact button text matches line 3075 of app.js

---

## STORY-007: "No Prompt Captured" — Missing or Malformed Conversation

**Persona**: A user viewing a session or call where the system prompt or initial user message could not be extracted.

**Trigger**: Session transcript is malformed, truncated, or the initial turn is missing from a call's task field.

**Journey**:
1. In **Sessions list**, if a session has no recognizable title (first user message), the row shows: **"(no prompt captured)"** as the session title
2. In **Active Session tab**, when viewing the **Main Conversation Trace** details:
   - If a call's `task` field is empty: **"(no prompt captured)"** in a `<pre>` block with muted styling
3. In **Workflows tab**, per-call detail drawer:
   - Task section shows: **"(no prompt captured)"** if `c.task` is falsy
   - Output section shows: **"(no text output — tool-only turn)"** if `c.output` is falsy (because the agent only called tools, no text)
4. In **Subagents tab**, per-agent detail inline:
   - Task section: **"(no prompt captured)"**
   - Output section: **"(no text output — tool-only turn)"**

**What he sees**: The UI never leaves text fields blank; it always provides a fallback label explaining why. Honesty prevents him from thinking the data is loading or missing.

**Exact copy**:
- When no prompt: **"(no prompt captured)"**
- When no text output: **"(no text output — tool-only turn)"**
- Cost footnote in observed run: **"Cost is reconstructed from harness transcripts (cache_creation × 1.25, cache_read × 0.10); timing is derived from transcript timestamps. Neither is a live billing API value."**

**Validation**:
- Copy is hardcoded in multiple places:
  - Line 1206, 1745 (call detail)
  - Line 2308 (session main trace fail)
  - Line 3065 (session title)

---

## STORY-008: Cost is an Estimate, Not Billed — Transparency on Pricing

**Persona**: An org lead or CFO reviewing cost data in Control Tower and wondering if these numbers match their actual bill.

**Trigger**: User reads a stat card or table showing cost values and wants to understand if it's a live API value or a reconstruction.

**Journey**:
1. **Stat card** for "Total Cost" shows: **"$X.XXXXXX"**
2. **Tooltip/footnote** under the card or in the observed run detail: **"$ = cache-aware estimate, not billed"** or **"Cost is reconstructed from harness transcripts… Neither is a live billing API value."**
3. When hovering the cost cell in the **per-call table**, a full tooltip appears: **"Reconstructed cost of just this step (cache-aware estimate)."**
4. In **Insight cards**, the model-split card includes small text: **"Cache-aware: cache_creation tokens ×1.25, cache_read ×0.10. An estimate from price tables, not a billed amount."**
5. In **observed run detail**, the stat card footer reads: **"Cost (cache-aware): Total reconstructed cost across all agents… Cache-aware: cache_creation tokens ×1.25, cache_read ×0.10. An estimate from price tables, not a billed amount."** (title attribute)

**What he sees**: Every cost number is clearly labeled as a reconstruction + estimation method, not a live billing value. Prevents misunderstanding or audit disputes.

**Exact copy**:
- Card label: **"$ = cache-aware estimate, not billed"**
- Caveat in observed detail: **"Cost is reconstructed from harness transcripts (cache_creation × 1.25, cache_read × 0.10); timing is derived from transcript timestamps. Neither is a live billing API value."**
- Stat card tooltip: **"Total reconstructed cost across all agents. Cache-aware: cache_creation tokens ×1.25, cache_read ×0.10. An estimate from price tables, not a billed amount."**

**Validation**:
- Caveat is rendered at line 1604 (`<p class="observed-caveat"…>`)
- Stat card is described in `buildDetailHtml()` at line 1585
- Every cost display uses `fmtUsd()` or `fmtUsdShort()` formatting

---

## STORY-009: Credential Gate & Budget Over — Prevent Runaway Costs

**Persona**: A user in live mode without API keys, or one who hits the budget cap.

**Trigger 1 (No Credentials)**:
1. Live mode is active; `ANTHROPIC_API_KEY` is not set
2. **Credential Warning** banner appears above the Run button: **"⚠ Set ANTHROPIC_API_KEY to run live · Replay is free"**
3. **Run button is disabled** and re-styled as tertiary (gray, not primary blue)
4. User can still switch to Replay mode; the warning vanishes

**Trigger 2 (Budget Over)**:
1. User sets a budget cap (e.g., `$5.00`) and runs a workflow
2. Halfway through, cumulative cost exceeds the cap
3. **Governor banner** pops up (red, prominent): **"Over Budget — spent $5.20 ≥ cap $5.00 at call 12"**
4. Remaining pending calls freeze in place (grayed-out, not completing)
5. Run status becomes "over-budget"
6. A **"Raise Cap & Re-run"** button appears in the banner
7. User clicks it; the cap is auto-suggested (1.5× last run cost): **"$7.80"** is filled into the cap input
8. User clicks **Run** again with the new cap

**What he sees**: Clear, honest feedback that he's hit limits + immediate recovery path (set credentials or raise cap). No silent failures or surprise bills.

**Exact copy**:
- Warning: **"⚠ Set ANTHROPIC_API_KEY to run live · Replay is free"**
- Governor banner: **"Over Budget — spent {spent} ≥ cap {cap} at call {tripCall}"**
- Button: **"Raise Cap & Re-run"**

**Validation**:
- Credential check in `updateCredentialState()` examines `state.health?.providers`
- Governor trip via SSE event in `listenToStream()` at line 574
- Cap suggestion formula: `((run.costUsd || 0) * 1.5).toFixed(4)`

---

## STORY-010 (Bonus): Model Split Unavailable — Computing vs Failed

**Persona**: A user viewing the insight card on a session that is still being reconstructed, or one where detail loading failed.

**Trigger 1 (Computing)**:
1. Session loads; Main Conversation Trace is fetching per-agent details
2. **Model-split section** shows: **"computing model split…"** in muted gray
3. Stat card shows "?" or "—" for model breakdown
4. After a moment, the model-split chart renders with actual percentages

**Trigger 2 (Unavailable)**:
1. Session load completes, but some workflow details failed to fetch (network glitch)
2. **Model-split section** shows: **"model split unavailable"** in muted gray
3. No chart is rendered; instead a placeholder message
4. The insight still shows total cost, but model tier breakdown is missing

**What he sees**: The UI explicitly tells him whether data is being computed (give it a moment) or permanently unavailable (investigate the error). No ambiguity.

**Exact copy**:
- Computing: **"computing model split…"**
- Failed: **"model split unavailable"**

**Validation**:
- Conditional at line 2698: `detailsLoaded ? 'model split unavailable' : 'computing model split…'`
- Part of the session insight card rendering in `renderSessionInsights()`

---

## Summary

**These 9 stories (STORY-001 through STORY-009) collectively cover**:
1. **Fresh start** — empty states on first launch
2. **Configuration** — missing environment variables (NOT_CONFIGURED 503)
3. **Deep-link recovery** — deleted sessions (NOT_FOUND 404)
4. **Network resilience** — server dies mid-run (SSE connection lost)
5. **Partial data** — some fetches fail, UI labels itself "partial"
6. **Ghost rows** — zero-turn sessions are hidden by default but toggleable
7. **Fallback text** — "(no prompt captured)" and "(no text output — tool-only turn)"
8. **Cost transparency** — every $ is labeled "estimate, not billed"
9. **Credential & budget gates** — prevent runaway costs, offer recovery paths

**All copy is quoted directly from the codebase** (app.js, server.mjs, sessions.mjs). **No features are invented**; the stories describe only what the code does.

---
