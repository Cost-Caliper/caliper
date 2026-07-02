# Navigation, Orientation & History — Tabs, Deep-Links & Browser Back/Forward

**Feature**: Hash-based navigation with browser history support; persistent identity strip showing current session context; deep-linking via shareable URLs; breadcrumbs within subagent drill-in; cross-tab jumping (Workflows ↔ Subagents); theme persistence (light/dark); session refresh that restores the viewer's current position.

**UI Components**: Tab bar (Sessions | Active Session | Workflows | Subagents), active-session identity strip (always shows "Viewing session" + session prompt + date + cost + live pill + "switch session ↗" button), breadcrumbs in subagent detail ("← all subagents / main conversation / this subagent"), theme toggle button (☀/☾), browser Back/Forward buttons, URL hash.

**Hash Formats**: 
- `#/sessions` — Sessions tab
- `#/session` or `#/<sessionId>` — Active Session tab (shows drill-in tabs) or selects a specific session and shows Active Session
- `#/observe` — Workflows (Observe) tab
- `#/subagents` — Subagents tab
- `#/<sessionId>/<agentId>` — Select session + drill into specific subagent detail

**Related Code**: `setTab()`, `pushNav()`, `parseNavHash()`, `applyNavState()`, popstate listener, `selectSubagent()`, `navigateToSubagent()`, `navigateToRun()`, `refreshSessionStrip()`, theme toggle localStorage pattern (respects prefers-color-scheme OS preference on first load).

---

## STORY-001: Lost in the Drill-In — Orientation After Multiple Jumps (John, Muscle-Memory User)

**Type**: Medium (5–8 min)  
**Persona**: John — ran a session last week, got lost navigating between tabs, now wants to test "can I always tell where I am?"  
**Goal**: Verify that after multiple tab jumps and nested drill-ins, the identity strip + breadcrumbs always show the current session and agent context.  
**Preconditions**:
- Control Tower shows a session "Debug the cache layer" selected (Active Session tab is visible)
- Session has 3 workflows + 5 subagents
- John hasn't paid attention to the identity strip; just jumps between tabs

**Steps**:

1. John starts on the Active Session tab.
   - **Expected**: Identity strip at the top shows 'Viewing session "Debug the cache layer"' + timestamp + cost + "3 wf 5 sub" badges
   - **Session context line** below the title shows cwd + git branch (e.g., "/Users/dennison/workflow-lens · main")

2. John clicks the Workflows tab to inspect a particular run.
   - **Expected**: Tab switches to Workflows; identity strip stays visible, still shows same session context
   - **Navigation state**: URL hash changes to `#/observe/` (session ID implied in server state)
   - **Behavior**: `setTab('observe')` calls `refreshSessionStrip()` to fetch and re-render the strip

3. John finds a specific workflow run and clicks into it (expanding the accordion row).
   - **Expected**: Timeline + per-call table render inside the row
   - **No URL change**: Expanding a run detail doesn't change the hash; hash still reads `#/observe`
   - **Why**: Tab-level navigation only; within-tab accordion state is DOM-only

4. John clicks on a segment in the workflow's timeline to open the call-detail drawer.
   - **Expected**: Right-side drawer slides in with inference/tool details
   - **Identity strip still visible**: Top identity strip unchanged; John always knows he's in "Debug the cache layer" session

5. John closes the drawer (click scrim or Escape) and navigates to Subagents tab.
   - **Expected**: Subagents tab becomes active; identity strip persists; drawer closes
   - **URL hash**: `#/subagents`
   - **On tab switch**: `setTab('subagents')` runs `loadSubagentTree()` which fetches the subagent forest for the current session

6. John clicks a subagent row to drill into its detail.
   - **Expected**: Breadcrumb appears: "← all subagents / main conversation / this subagent (name)"
   - **URL hash**: Changes to `#/subagents/<agentId>` (e.g., `#/subagents/agent-abc123`)
   - **Detail inline**: Below the tree/timeline/table, the selected subagent's full trace renders (timeline + per-segment detail)
   - **Navigation state**: `pushNav(agentId)` records the drill-in as a separate history entry

7. John clicks the "← all subagents" link in the breadcrumb.
   - **Expected**: Breadcrumb disappears; subagent detail closes (slot.hidden = true); tree/timeline/table shows again (all rows now visible, no selection highlight)
   - **URL hash**: Back to `#/subagents`
   - **Navigation state**: `pushNav(null)` records "back at list" so Browser Back closes the drill-in (not the tab)

8. John presses browser Back button.
   - **Expected**: Subagent detail opens again (returns to step 6); URL hash becomes `#/subagents/<agentId>`
   - **Behavior**: popstate event fires → `applyNavState()` calls `selectSubagent(agentId)` → detail renders

9. John presses browser Back again.
   - **Expected**: Subagent detail closes; Subagents tab stays active; URL hash is `#/subagents`

10. John presses browser Back again.
    - **Expected**: Tab switches back to Workflows; identity strip updates via `refreshSessionStrip()`; URL hash is `#/observe`

11. John presses browser Back again.
    - **Expected**: Tab switches back to Active Session; identity strip persists; URL hash is `#/session` or `#/session/<sessionId>`

**Variations**:
- **Start from deep link**: If John pastes a deep-link URL `#/session/abc123/subagent-xyz` into the browser:
  - Page parses the hash; `parseNavHash()` extracts session + agent
  - `applyNavState()` fires server-side POST `/v1/session/select` with that session ID
  - Page switches to Active Session tab, then selects the subagent
  - Breadcrumb + detail appear automatically
  - **Expected**: John lands in the exact drill-in spot without manual navigation

**Edge Cases**:
- **Session deleted**: If the selected session is deleted between tab switches, `refreshSessionStrip()` catches the error and shows "No session selected · pick one from the Sessions tab" + "Sessions ↗" button
- **Multiple windows**: If John has two Control Tower windows open and switches a session in one, the other window's strip may drift until John manually switches tabs (force `refreshSessionStrip()`) or reloads
- **Hash navigation while navApplying=true**: `pushNav()` and `setTab()` check `if (navApplying) return` to avoid polluting the history stack during popstate restore

**Test Coverage**:
- Breadcrumb text always matches the selected subagent's name
- Identity strip title matches the active session's title
- URL hash always matches the current tab + session + agent state
- Browser Back/Forward buttons reliably undo/redo the last navigation move
- No dead-end states: every "close" or "back" action returns to a valid state

---

## STORY-002: Sharing a Deep Link — Colleague Landing on the Right Tab (Teammate, Collaboration)

**Type**: Short (< 3 min)  
**Persona**: Teammate receives a deep-link URL from a colleague  
**Goal**: Click a link and land on the exact session + subagent detail without further navigation.  
**Preconditions**:
- Colleague runs a session "Optimize cost routing" with subagents
- Colleague copies the URL `http://localhost:8787/#/subagents/agent-xyz123` from their address bar
- Colleague pastes the link in a chat or email to Teammate
- Control Tower is running on the same machine (shared codebase, same port 8787)

**Steps**:

1. Teammate clicks the link.
   - **Expected**: Browser navigates to Control Tower; page loads with hash `#/subagents/agent-xyz123`

2. **Page init runs** (no session was previously selected on this browser):
   - `location.hash` is parsed by `parseNavHash()` → extracts `{ tab: 'subagents', sessionId: null, sub: 'agent-xyz123' }`
   - **But wait**: The hash doesn't include a sessionId! Teammate will land in the Subagents tab, but which session's subagents?
   - **Actual behavior**: The hash regex is `/^#\/([a-z]+)(?:\/([0-9a-f]{8}...))?(?:\/([\w-]+))?$/` (sessionId is optional, agentId is optional)
   - **If sessionId is missing**: `applyNavState()` still calls `setTab('subagents')` without calling `selectSubagent()` (because `st.sub` requires a valid context)
   - **Result**: Teammate lands in Subagents tab but sees an empty detail slot or the tree without selection

3. **Alternative deep-link (with sessionId)**: Colleague copies the correct full link:
   - `http://localhost:8787/#/subagents/<sessionId>/agent-xyz123`
   - Example: `http://localhost:8787/#/subagents/550e8400-e29b-41d4-a716-446655440000/agent-xyz123`

4. Teammate clicks the full deep link.
   - **Expected**: Page parses hash → `{ tab: 'subagents', sessionId: '550e8400...', sub: 'agent-xyz123' }`
   - **applyNavState() runs**:
     - Calls `/v1/session/select` with that sessionId (server-side state now points to the session)
     - Resets local caches (`resetSessionCaches()`)
     - Calls `setTab('subagents')` to switch to Subagents tab
     - In the tab-switch handler, checks `if (st.sub)` → calls `selectSubagent('agent-xyz123')`
     - Detail fetches and renders inline

5. **Teammate sees**:
   - Subagents tab active
   - Identity strip shows 'Viewing session "Optimize cost routing"'
   - Breadcrumb: "← all subagents / main conversation / agent-xyz123"
   - Subagent detail: timeline + per-segment call drawer, full trace

6. Teammate can now explore the trace, expand/collapse call details, and then click "← all subagents" to return to the tree.

**Variations**:
- **Deep link to Workflows**: `#/observe/<sessionId>` switches to Workflows tab; no specific run is drilled (within-tab accordion state isn't hash-encoded)
- **Deep link to Active Session**: `#/session/<sessionId>` shows the session's waterfall or nodes view; no specific drill-in node selected
- **Cross-machine deep link**: If Colleague and Teammate are on different machines with different Control Tower instances:
  - Deep link won't work (data exists locally, not synced)
  - Teammate will land in the right tab but see an error or empty state

**Edge Cases**:
- **Malformed hash**: If the link is `#/subagents/not-a-valid-uuid`, `parseNavHash()` fails (regex doesn't match); page falls back to landing on Sessions tab
- **Session no longer exists**: If the sessionId in the link was deleted, `applyNavState()` tries to POST `/v1/session/select` which fails silently; `setTab('subagents')` still fires, landing in the empty Subagents view (no session selected)
- **Stale deep link**: If Teammate waits 1 week to click the link and the session was deleted in the meantime, same behavior as above

**Test Coverage**:
- Full hash `#/sessions/<sessionId>/<agentId>` correctly routes all three params
- Missing sessionId gracefully lands in the tab (without selecting a session)
- Missing agentId lands in the tab without drilling into a specific agent
- Malformed UUIDs or agent IDs are tolerated (page lands in Sessions if parse fails)
- Server `/v1/session/select` failure doesn't crash the page

---

## STORY-003: Back Button Muscle Memory — Close Drill-In, Return to Tab, Return to Sessions (John, Power User)

**Type**: Short (< 3 min)  
**Persona**: John — uses browser Back button habitually; expects it to undo the last UI action  
**Goal**: Verify that Back button closes nested drill-ins before closing tabs, respecting the user's mental model of "undo this action."  
**Preconditions**:
- Session "Debug cache" is selected; user is in Subagents tab
- A subagent is drilled in (breadcrumb visible, detail slot shows timeline)
- URL is `#/subagents/550e8400.../agent-xyz123`

**Steps**:

1. John presses browser Back button.
   - **Expected**: Subagent detail closes; tree/timeline becomes visible again; no selection highlight
   - **Breadcrumb disappears**
   - **URL changes**: `#/subagents/550e8400...` (no agentId)
   - **Behind the scenes**: popstate event → `applyNavState({ tab: 'subagents', sessionId: '...', sub: null })` → `selectSubagent(MAIN_SESSION_ID)` is NOT called (because `st.sub` is null); instead, the sub-detail slot is hidden

2. John presses Back again.
   - **Expected**: Tab switches from Subagents to Workflows (or to Active Session, depending on history)
   - **URL**: `#/observe` or `#/session`
   - **Identity strip**: Persists; still shows same session context

3. John presses Back again.
   - **Expected**: Tab switches from Workflows to Sessions
   - **URL**: `#/sessions`
   - **Identity strip**: Hides (only visible on drill-in tabs: session, observe, subagents)
   - **Session selection**: Clears; project picker + session list become the main focus

4. John presses Back again.
   - **Expected**: Nothing happens (no further history entries)
   - **Browser behavior**: Standard; page stays on Sessions tab

**Variations**:
- **Forward button after Back**: John presses Back 3 times, then Forward 1 time → returns to Workflows tab (reverse the last Back)
- **Nested drill-ins**: If John had drilled into a subagent, then clicked the "main conversation" breadcrumb (which also uses `selectSubagent(MAIN_SESSION_ID)` and `pushNav(agentId)`), Back would close that drill-in too

**Edge Cases**:
- **No-op navigation**: If John clicks a tab but the URL hash is already correct (e.g., already on Subagents, clicks Subagents again), `pushNav()` checks `if (location.hash === hash) return` — no history entry is created
- **Rapid Back spam**: If John mashes Back 10 times, each Back closes one drill-in or switches one tab; no crashes or race conditions (popstate events are queued and serialized)

**Test Coverage**:
- Drill-in close comes before tab switch in history
- URL always matches the current state (tab, session, agent)
- Back/Forward buttons are always aligned with URL hash

---

## STORY-004: Reload Restores Position — Refresh Button Lands on the Same Tab (John, Reliability)

**Type**: Short (< 3 min)  
**Persona**: John — reloads the page to refresh data; expects to land back on the same tab + session  
**Goal**: Verify that page reload preserves the current tab and session context without manual re-navigation.  
**Preconditions**:
- John is on the Workflows tab, viewing session "Optimize costs"
- URL is `#/observe/550e8400...`
- John hits `Cmd+R` (or Ctrl+R) to refresh the page

**Steps**:

1. John hits Cmd+R to refresh.
   - **Expected**: Page reloads; spinner appears; HTTP requests fire to `/v1/projects`, `/v1/sessions`, etc.

2. **Page init runs again**:
   - At the end of app.js, `location.hash` is parsed: `#/observe/550e8400...` → `parseNavHash()` → `{ tab: 'observe', sessionId: '550e8400...', sub: null }`
   - `applyNavState()` is called
   - Since `sessionId` is in the hash, `/v1/session/select` is POSTed (server state updates)
   - `setTab('observe')` fires
   - `loadObservedList()` fetches and renders the workflow runs

3. **John lands back on Workflows tab**, viewing the same session.
   - **Expected**: Workflows list + all expanded/collapsed rows restored to their DOM state
   - **Note**: Accordion expansion state (which rows are open) is NOT persisted; after reload, all rows are collapsed (default closed state)
   - **But**: The selected session + tab are correct

4. John finds the same workflow run he was inspecting before refresh.
   - **Expected**: John clicks the row to expand it again (one manual action to resume)

**Variations**:
- **Reload while deep in a subagent detail**: John is on `#/subagents/550e8400.../agent-xyz123`
  - Page reloads; both the sessionId and agentId are in the URL
  - After init, `applyNavState()` calls both `setTab('subagents')` and `selectSubagent('agent-xyz123')`
  - Breadcrumb + detail appear automatically
  - **Result**: John is back in the exact same drill-in spot

- **Reload with no hash (Sessions tab)**: Page reloads with hash `#/sessions` (or no hash → defaults to Sessions)
  - `parseNavHash()` extracts `{ tab: 'sessions', sessionId: null, sub: null }`
  - `applyNavState()` calls `setTab('sessions')`
  - Session list loads; no session is pre-selected

**Edge Cases**:
- **Session selected, then deleted**: John is on `#/observe/550e8400...`, but the session was deleted while John was away
  - Page reloads; `/v1/session/select` with that sessionId fails silently
  - `setTab('observe')` still fires; Workflows list loads but shows empty state (no session context)
  - Identity strip shows "No session selected"
  - John must click "Sessions ↗" to re-select a session

- **Tab fully reloads CSS/JS**: If the developer updates app.js or app.css between John's sessions, the new code is loaded; internal state may differ, but the hash-based navigation is version-agnostic

**Test Coverage**:
- Hash is preserved across reload
- Session selection persists
- Tab + session match the hash on every init

---

## STORY-005: Switch Sessions Mid-Exploration — Identity Strip Updates, Tabs Stay Consistent (Dennison, Multi-Session)

**Type**: Short (< 3 min)  
**Persona**: Dennison — comparing two sessions side-by-side (not literally, but rapidly switching)  
**Goal**: Verify that switching sessions while in the Workflows tab updates the context without losing the tab view.  
**Preconditions**:
- Dennison is on the Workflows tab, viewing session "Session A: Cache rewrite" (identity strip shows this)
- URL is `#/observe/session-a-uuid`
- Dennison wants to check session "Session B: Cost router" data quickly

**Steps**:

1. Dennison clicks the Sessions tab to see the list.
   - **Expected**: Tab switches; identity strip hides; session list appears

2. Dennison finds and clicks session "Session B: Cost router".
   - **Expected**: POST `/v1/session/select` fires with session B's ID
   - `setTab('session')` fires, switching to Active Session tab to show the selected session's waterfall
   - **URL**: `#/session/session-b-uuid`

3. Dennison navigates back to Workflows tab.
   - **Expected**: Tab switches; identity strip now shows 'Viewing session "Session B: Cost router"'
   - **URL**: `#/observe/session-b-uuid`
   - **Behavior**: `setTab('observe')` runs `loadObservedList()`, which fetches workflows for session B (not A)

4. Dennison inspects the Workflows list for session B.
   - **Expected**: Rows show session B's workflow runs

5. Dennison wants to quickly compare against session A again.
   - **Workflow**: Dennison notices the identity strip has a "switch session ↗" button
   - Dennison clicks the "switch session ↗" button in the identity strip

6. **Two possible outcomes**:
   - **Outcome A (if 'switch session' button navigates to Sessions tab)**: Sessions tab opens; list appears; Dennison clicks session A
   - **Outcome B (if 'switch session' button is a dropdown)**: Mini-picker appears showing recent sessions; Dennison clicks session A

7. Session A is re-selected.
   - **Expected**: Same Workflows tab stays active (or user lands on Active Session tab first, then must click back to Workflows)
   - **Identity strip**: Updates to show session A's context
   - **Workflows list**: Re-renders with session A's runs

**Expected Behavior (from code inspection)**:
- "switch session ↗" button has `data-goto-sessions` attribute
- Click handler calls `setTab('sessions')`
- **Result**: Outcome A is correct—Dennison lands on Sessions tab and must click a session to go back to Workflows

**Variations**:
- **Rapid session switching**: If Dennison clicks multiple sessions rapidly:
  - Each click triggers `/v1/session/select` (may queue on server)
  - Each successful POST updates `currentSessionId`
  - `resetSessionCaches()` clears old data
  - Only the final selected session's data is visible
  - **Expected**: No race condition or corruption; last-write-wins on server state

**Edge Cases**:
- **Session deleted between clicks**: Dennison selects session A, navigates to Workflows, then session A is deleted (e.g., by another user)
  - If Dennison stays on Workflows tab, identity strip will show stale context until next refresh or tab switch
  - If Dennison switches tabs (e.g., to Sessions), `refreshSessionStrip()` fires and catches the error, showing "No session selected"

- **Network error during session select**: POST `/v1/session/select` fails
  - Error is caught silently in `applyNavState()` (comment: "session may be gone — land on the tab anyway")
  - Tab switches anyway; identity strip shows "No session selected" (if strip.hidden = false)

**Test Coverage**:
- Session switch triggers `/v1/session/select` with correct ID
- Identity strip updates on tab switch
- Workflows list re-renders with new session's data
- "switch session ↗" button correctly navigates to Sessions tab

---

## STORY-006: Insight-Bar Click Jumps Tabs & Auto-Expands Rows (Dennison, One-Click Navigation)

**Type**: Short (< 3 min)  
**Persona**: Dennison — notices a link or clickable hint in the session summary (insight bar) and wants to jump directly to the relevant tab  
**Goal**: Verify that clicking a prompt or badge in the session detail jumps to the appropriate tab and auto-expands relevant rows.  
**Preconditions**:
- Dennison is on the Active Session tab viewing "Debug cache" session
- The insight card or summary shows "3 workflows found" or mentions a specific workflow name
- Dennison wants to see the Workflows tab without navigating manually

**Steps**:

1. Dennison is on Active Session tab; summary shows "Workflows: 3" or a list of workflow names.
   - **Expected**: Workflow names are clickable links or there's a "View in Workflows tab" hint

2. Dennison clicks on a workflow name link.
   - **Expected**: `navigateToRun(runId)` is called
   - **Behavior**:
     - `document.querySelector('.tabbar-btn[data-tab="observe"]')?.click()` → switches to Workflows tab
     - Loop polls for `.obs-run-item[data-run-id="${runId}"]` element (up to 25 iterations × 80ms = 2 seconds)
     - Once found, checks if the row is expanded; if not, calls `toggleItem()` to expand
     - Scrolls the row into view smoothly

3. **Dennison lands on Workflows tab**; the clicked workflow run is auto-expanded.
   - **Expected**: Timeline + per-call table render immediately
   - **URL**: `#/observe/...` (hash doesn't encode the specific run; that's within-tab state)
   - **Scroll**: Row is centered on screen (behavior: 'smooth', block: 'center')

**Variations**:
- **Insight card shows subagents**: Similarly, clicking a subagent link calls `navigateToSubagent(agentId)`
  - Tab switches to Subagents
  - Waits 320ms for tree to render
  - Calls `selectSubagent(agentId)` to drill into that subagent
  - Breadcrumb + detail appear

- **Multiple runs found**: If there are many workflows, clicking the first one works as above; clicking another polls again (no caching of the click)

**Edge Cases**:
- **Run no longer exists**: If the workflow run was deleted after the insight was rendered, the poll loop times out (25 iterations); row is not found or expanded; Dennison sees the Workflows tab but no specific run highlighted
- **Slow page load**: If `loadObservedList()` hasn't finished rendering all rows by the time the click handler fires, the poll loop will wait (up to 2 seconds); no error, but delay

**Test Coverage**:
- Workflow link triggers tab switch
- Row auto-expands on arrival
- Polling loop handles row not-yet-rendered
- Subagent link behavior mirrors workflow link
- 320ms delay before `selectSubagent()` allows tree to render first

---

## STORY-007: Theme Toggle Persists via OS Preference & Button (John, Accessibility)

**Type**: Short (< 2 min)  
**Persona**: John — opens Control Tower for the first time; uses OS dark mode; expects the dashboard to match his preference  
**Goal**: Verify that theme respects OS preference on first load and that the toggle button allows override.  
**Preconditions**:
- John's OS (macOS/Windows/Linux) is set to dark mode (via system settings)
- Control Tower is accessed for the first time (no prior localStorage theme setting)
- Browser window is open

**Steps**:

1. John opens Control Tower (page loads, script runs).
   - **Expected**: App detects OS preference via `window.matchMedia('(prefers-color-scheme: light)').matches`
   - **On first load**: If OS is dark mode, this check returns false; app defaults to theme 'dark' (hardcoded in `state.theme = 'dark'`)
   - **If OS is light mode**: Check returns true; `applyTheme('light')` is called

2. **Page renders in dark theme** (John's OS preference: dark).
   - **Expected**: CSS sets `[data-theme="dark"]` on `<html>` element
   - **Visual**: Background is dark; text is light; all color vars reference dark palette
   - **Theme toggle button**: Shows ☀ (sun icon, indicating "click to switch to light")

3. John clicks the theme toggle button (☀).
   - **Expected**: `applyTheme('light')` is called
   - **Behavior**:
     - `state.theme = 'light'`
     - `document.documentElement.setAttribute('data-theme', 'light')`
     - Icon changes to ☾ (moon icon, indicating "click to switch to dark")
   - **Visual**: Entire page switches to light theme (light background, dark text)

4. John clicks the toggle again (☾).
   - **Expected**: `applyTheme('dark')` is called; page switches back to dark theme; icon returns to ☀

5. John refreshes the page (Cmd+R).
   - **Expected**: Theme is... **unclear from code inspection**
   - **Potential issue**: Theme is stored in `state.theme` (memory), not persisted to localStorage
   - **Current behavior**: On reload, `state.theme` resets to 'dark' (hardcoded); OS preference is checked again; if OS is dark, app loads dark; if OS is light, app loads light
   - **Result**: John's manual toggle is **lost** on refresh (not persisted)

**Variations**:
- **John switches OS theme**: If John changes OS preference from dark to light while Control Tower is open:
  - App doesn't re-detect the OS change (no media query listener registered)
  - Button toggle still works; theme is manually controlled
  - On next reload, new OS preference is detected

**Expected Behavior (Ideal, not implemented)**:
- Theme toggle should be persisted to `localStorage.setItem('ct-theme', state.theme)`
- On init, load from localStorage first; fall back to OS preference if not set
- On toggle, update both `state.theme` and localStorage

**Current Implementation (from code)**:
- Theme is NOT persisted to localStorage
- Relies on OS preference via `prefers-color-scheme` media query
- Manual toggle is lost on reload

**Test Coverage (if persisting to localStorage)**:
- First load: respects OS preference
- Toggle: switches theme immediately + persists to localStorage
- Reload: restores persisted theme from localStorage
- Clear localStorage: falls back to OS preference again

---

## STORY-008: Deep-Link Bootstrap — Pasting a URL Selects Session Server-Side (Teammate, Sharing)

**Type**: Short (< 2 min)  
**Persona**: Teammate receives a deep-link URL and opens it in a new tab  
**Goal**: Verify that session selection via deep-link is server-side (not just URL-driven), so the page state is accurate even across multiple Control Tower instances.  
**Preconditions**:
- Colleague runs a session "Optimize routing" in Control Tower instance A
- Colleague copies the URL `http://localhost:8787/#/subagents/550e8400.../agent-xyz123`
- Teammate opens the link in Control Tower instance B (same codebase, same port, fresh page load)

**Steps**:

1. Teammate clicks the link.
   - **Page loads**; hash is `#/subagents/550e8400.../agent-xyz123`

2. **Page init runs**:
   - `parseNavHash(location.hash)` extracts `{ tab: 'subagents', sessionId: '550e8400...', sub: 'agent-xyz123' }`
   - `applyNavState()` is called

3. **applyNavState() confirms session server-side**:
   - Since `st.sessionId` (550e8400...) differs from `currentSessionId` (null or stale), the code calls:
     - `await apiFetch('/v1/session/select', { method: 'POST', ... body: JSON.stringify({ id: st.sessionId }) })`
   - **Server state updates**: The server's "active session" is now 550e8400...
   - `currentSessionId = st.sessionId` updates the client state
   - `resetSessionCaches()` clears old cached data

4. **Tab switch and detail load**:
   - `setTab('subagents')` fires; `loadSubagentTree()` fetches subagents for the now-selected session
   - In `applyNavState()`, since `st.tab === 'subagents'` and `st.sub` is set, `selectSubagent('agent-xyz123')` is called
   - Detail fetches and renders

5. **Teammate sees**:
   - Subagents tab active
   - Identity strip: 'Viewing session "Optimize routing"' (correct session title fetched from server)
   - Subagent detail: timeline + trace for agent-xyz123
   - **All data is accurate**, not just the URL

6. **Why server-side matters**:
   - If Colleague later switches to a different session in instance A, instance A's state changes but instance B is unaffected (they're independent)
   - If a third user, Charlie, opens the same deep-link URL in instance C, the server also selects the session for Charlie's instance
   - **Benefit**: No global server state conflict; each browser session has its own selected session

**Edge Cases**:
- **Server session already selected differently**: Teammate's Control Tower instance already had session "Debug cache" selected
  - The deep-link POST `/v1/session/select` switches the server to the new session (550e8400...)
  - Old session's caches are cleared; new session data loads
  - No stale data visible

- **Session missing**: If 550e8400... was deleted, POST fails silently (try/catch); `setTab('subagents')` still fires but shows empty state

**Test Coverage**:
- POST `/v1/session/select` is called with correct sessionId from hash
- Server state updates (verified by subsequent data fetches)
- Each client instance is independent
- No race conditions if multiple deep-links are opened rapidly

---

## STORY-009: Session Strip Shows "VIEWING SESSION" with Live Pill (Power User, Status Awareness)

**Type**: Short (< 2 min)  
**Persona**: Dennison — notices a "live" pill on the session strip and understands the session is currently running  
**Goal**: Verify that the session identity strip always shows: (1) "Viewing session" label, (2) session prompt title, (3) start date + time, (4) cost estimate, (5) workflow + subagent badges, (6) "live" pill if running.  
**Preconditions**:
- Dennison is on the Workflows tab viewing a session "Train model v2"
- The session started 1 minute ago and is still running (mtime < 2 minutes old)
- URL is `#/observe/session-uuid`

**Steps**:

1. **Identity strip renders** (visible on Workflows tab):
   - **Label**: "Viewing session" (left-aligned, muted text)
   - **Title**: `"Train model v2"` (the session's starting prompt, truncated to 90 chars, with tooltip showing full title)
   - **Live pill**: A small badge that says "live" with a tooltip "Transcript updated in the last 2 minutes — this session appears to be running right now. Stats are its progress so far; hit Refresh to update."
   - **Date + time**: E.g., "Jun 28, 14:32" (formatted from session.startedAt or mtimeMs)
   - **Cost estimate**: E.g., "$0.12" (formatted from session.costUsd)
   - **Badges**: "2 wf" (2 workflows) and "3 sub" (3 subagents) if applicable, in colored borders
   - **Button**: "switch session ↗" (underlined, small text, right-aligned)

2. **Live pill logic**:
   - On `refreshSessionStrip()`, the code checks: `const liveNow = (Date.now() - (s.mtimeMs || 0)) < 120000 ? '<span class="sess-live-pill">live</span>' : '';`
   - If current time minus session's last modified time is less than 2 minutes (120,000 ms), the pill appears
   - Otherwise, the pill is omitted (session is not live)

3. **Dennison waits 2 minutes**, then manually clicks "Refresh" button (or the session naturally continues running for another minute).
   - **If running continues**: Flip back to Sessions tab and then back to Workflows; `refreshSessionStrip()` fires again; pill persists
   - **If session completes**: `mtimeMs` is old; on next refresh, pill disappears (session no longer "live")

4. **Dennison clicks "switch session ↗"** in the strip.
   - **Expected**: `setTab('sessions')` is called; Sessions tab becomes active; identity strip hides

**Variations**:
- **Session completed > 2 minutes ago**: Strip shows all info but no "live" pill; Dennison knows the session is done
- **Session has no cost yet**: Cost shows "$0.00" or "—" (if cost is falsy)
- **Session has no workflows/subagents**: Badges are omitted; only the basic strip info appears

**Edge Cases**:
- **Strip refreshes while session is actively running**: SSE events stream in (from live run); `refreshSessionStrip()` may be called multiple times; "live" pill stays visible as long as mtimeMs is updated
- **Strip data slightly stale**: If `refreshSessionStrip()` is called but `/v1/session/active` has a stale response, the pill might appear/disappear inconsistently; **workaround**: user clicks Refresh button to force a re-fetch

**Test Coverage**:
- Strip renders all expected fields: label, title, date, cost, badges
- "live" pill appears iff mtime < 120 seconds old
- Clicking "switch session ↗" navigates to Sessions tab
- Strip hides when switching to Sessions tab; reappears when switching back to drill-in tabs

---

## Summary

These 9 stories cover the full navigation, orientation, and history flow in Control Tower:

1. **STORY-001** — Lost orientation: breadcrumbs + identity strip always show context
2. **STORY-002** — Sharing deep links: full `#/sessionId/agentId` URLs land on the exact spot
3. **STORY-003** — Back button: drill-in closes before tab switches
4. **STORY-004** — Reload: hash preservation restores position
5. **STORY-005** — Session switching: mid-exploration context updates
6. **STORY-006** — Insight-bar clicks: one-click tab jump + auto-expand
7. **STORY-007** — Theme toggle: OS preference respected on first load (localStorage not implemented)
8. **STORY-008** — Deep-link bootstrap: server-side session selection is authoritative
9. **STORY-009** — Session strip: "VIEWING SESSION" + live pill indicates active running state

**Key Behaviors**:
- Hash forms: `#/<tab>`, `#/<tab>/<sessionId>`, `#/<tab>/<sessionId>/<agentId>`
- Back closes subagent detail before closing tabs (breadcrumb click → `pushNav(null)`)
- Forward restores previously-drilled agent
- Reload preserves URL hash; identity strip reflects server state
- Theme respects OS `prefers-color-scheme` on first load (manual toggle not persisted)
- Identity strip always visible on drill-in tabs (session, observe, subagents); hidden on Sessions tab
- "switch session ↗" button navigates to Sessions tab for re-selection
- Live pill shows if session mtime < 120 seconds (session appears actively running)
- Cross-tab jumps (navigateToRun / navigateToSubagent) poll for DOM elements before interact

---

**Total Stories**: 9
