# Sessions Home — Project & Session Discovery

**Feature**: Browse all Claude Code sessions in a project folder; filter by project; discover conversations by date; toggle empty sessions; activate a session to drill into Active Session, Workflows, and Subagents tabs.

**UI Components**: Project folder picker (dropdown), date-grouped session list (newest first), empty-session toggle, per-session cards with time, title, badges (workflows/subagents), duration, turn count, cost, model tier dot, "active" / "live" pills, per-day cost rollup, refresh button, "N folders known to Claude Code" hint, session context line (cwd, git branch).

**Related Backend Endpoints**: 
- `GET /v1/projects` — list all project folders + active project slug
- `POST /v1/project/select` — switch active project
- `GET /v1/sessions?limit=200` — sessions in active project
- `POST /v1/session/select` — activate session to populate drill-in tabs

---

## STORY-001: First Load — Plain Sessions Only (John, Engineer)

**Type**: Short (< 5 min end-to-end)  
**Persona**: John (first-time engineer, Claude Code conversations but no workflows)  
**Goal**: Understand the cost/tokens of recent conversations; no expectations about complex dashboard features.  
**Preconditions**:
- John has run Claude Code in `~/myproject` 5 times over the past week
- No workflows or subagents spawned (plain conversation-only sessions)
- Control Tower is live at `http://localhost:8787`
- John's session data exists in `~/.claude/projects/myproject/` (transcripts, session metadata)

**Steps**:

1. John opens Control Tower in a browser.
   - **Expected**: Sessions tab auto-loads (default landing tab)
   - **UI state**: Header shows brand "Control Tower — workflow-lens observability"; tab bar shows "Sessions" highlighted as active

2. Page displays "Reading sessions…" message briefly.
   - **Expected**: Spinner or text appears while `/v1/projects` and `/v1/sessions` are fetched

3. Project folder picker appears populated with "myproject" (or the full path abbreviation, e.g., "~/myproject · 5 sessions").
   - **Expected**: Dropdown shows active project selected; footer hint reads "1 folders known to Claude Code"
   - **Logic**: John's `~/.claude/projects/` contains only one project

4. Session list renders, grouped by date (newest first): "Today" (2 sessions), "Yesterday" (1 session), "Last week" (2 sessions).
   - **Expected**: Each date group shows a header like "Today · 2 sessions · $0.05"
   - **Cost rollup**: Per-day total displayed at group header (sum of costUsd for that day's sessions)

5. Each session card shows:
   - Time: "14:32" (hh:mm from startedAt)
   - Title: Truncated first user message, e.g., "What are the top 3 frameworks…"
   - Badges: Empty (no "wf" or "sub" badges, since no workflows spawned)
   - Duration: "2m 14s" (from ms)
   - Turns: "8t" (8 assistant turns)
   - Cost: "$0.01" (conversation cost only, not including workflows—none exist)
   - Model tier dot: Green (haiku), tan (sonnet), red (opus) indicator to the right
   - **No pills**: "active" and "live" pills absent (session not currently selected, not running)

6. John clicks a session row, e.g., "What are the top 3 frameworks…"
   - **Expected**: Session activates; identity strip appears above tabs saying 'Viewing session "What are the top 3 frameworks…"'; Active Session, Workflows, and Subagents tabs become visible and load data
   - **Behind the scenes**: POST `/v1/session/select` with that session id; caches reset; `setTab('session')` fires, loading waterfall/trace
   - **Result**: John moves to Active Session tab and sees the waterfall visualization (main trace only, since no workflows)

7. John clicks "Sessions" button in the identity strip (or the Sessions tab) to return to the list.
   - **Expected**: Sessions tab shows again; identity strip hides; project picker and session list remain in their last state

**Variations**:
- **No sessions yet**: If `~/myproject` has never been run, list shows "No sessions in this folder yet · Run Claude Code in this project and its sessions will appear here." (empty state icon + text)
- **Multiple projects**: If John has run Claude Code in 3 projects, picker shows all 3; John can switch between them; session list re-fetches each time

**Edge Cases**:
- **Empty conversation** (no turns, no cost): Session appears in the list with ghost styling (lower opacity, lighter text) unless "Show N empty sessions" toggle is used
- **Session still running**: If a session's transcript was updated < 2 minutes ago, a "live" pill appears with tooltip "Transcript updated in the last 2 minutes — this session appears to be running right now. Stats are its progress so far; hit Refresh to update."
- **Fetch error**: If `/v1/sessions` fails, error message appears: "Could not load sessions: [error detail]"

---

## STORY-002: Power User Switches Project Folder (Dennison, Power User)

**Type**: Short  
**Persona**: Dennison (power user with 197 project folders)  
**Goal**: Quickly navigate between projects to find a specific old session across multiple codebases.  
**Preconditions**:
- `~/.claude/projects/` contains 197 subdirectories (various repos, tools, experiments)
- Dennison wants to find a session from "workflow-lens" project created 3 days ago
- Control Tower shows Dennison's current active project is "my-app"

**Steps**:

1. Dennison lands on Sessions tab with "my-app" project active.
   - **Expected**: Project picker shows "~/my-app · 42 sessions" selected
   - **Hint text**: "197 folders known to Claude Code" appears below the picker (from `projectsData.projects.length`)

2. Dennison clicks the project picker dropdown to view all available projects.
   - **Expected**: Dropdown opens, showing all 197 projects alphabetically or by recency
   - **Format**: Each option displays the cwd abbreviation (e.g., "~/work/workflow-lens") and session count

3. Dennison searches or scrolls to find "workflow-lens" and clicks it.
   - **Expected**: POST `/v1/project/select` fires with the new project slug
   - **UI response**: Dropdown closes; "Reading sessions…" message appears briefly
   - **Result**: Session list refreshes to show sessions from "workflow-lens"

4. "workflow-lens" sessions appear, grouped by date.
   - **Expected**: Groups like "3 days ago" show sessions from that project; each session shows its own cost/turns
   - **Data state**: `projectsData.activeProjectSlug` is updated; `sessionsData` refetched

5. Dennison sees a session titled "Add CLI flag for --debug" from "3 days ago".
   - **Expected**: The session appears in the "3 days ago" group (or "Wed, Jun 28" if showing full date)
   - **Clicking it**: Activates that session, switches to Active Session tab, loads its waterfall

**Variations**:
- **No sessions in selected folder**: Picker switches, list shows empty state: "No sessions in this folder yet"
- **Picker has favorites**: Future enhancement (not implemented); for now, Dennison must scroll or search the 197-item list
- **Alphabetical vs recent**: Order not specified in code; assume alphabetical or reverse-chrono by last activity

**Edge Cases**:
- **Project switched from another window**: If another instance of Control Tower changed the active project via POST `/v1/project/select`, Dennison's picker state may drift on next refresh (server is authoritative; picker reflects last POST)
- **Selected project deleted**: If Dennison's active project folder is deleted from disk before switching, error: "Could not switch project: [error]"

---

## STORY-003: Find a Specific Old Session by Date (Dennison, Power User)

**Type**: Medium (5–10 min)  
**Persona**: Dennison  
**Goal**: Locate a session from 6 weeks ago to compare optimization metrics against today's run.  
**Preconditions**:
- Dennison is in the "workflow-lens" project with 200+ sessions over 8 weeks
- Sessions list caps at 200 most recent (query: `?limit=200`)
- Dennison wants the session from "May 20" (6 weeks ago), which is outside the top 200

**Steps**:

1. Dennison opens the Sessions tab in the "workflow-lens" project.
   - **Expected**: List shows date groups: "Today", "Yesterday", "Last week", "2 weeks ago", … (up to ~6 weeks)
   - **Limit**: Only 200 most recent sessions shown (footer note: "Showing the 200 most recent of 1000+ sessions.")

2. Dennison scrolls down through date groups, but doesn't find "May 20" (it's beyond the 200-session limit).
   - **Expected**: Footer shows "Showing the 200 most recent of X sessions" (X > 200)

3. Dennison's workaround (current UI limitation):
   - Option A: Use browser DevTools to access server API directly: `/v1/sessions?limit=1000`
   - Option B: Visit the drill-in tabs (Active Session) if a recent session was already selected, then use the Workflows/Subagents tabs to navigate by date via other means
   - Option C: Manually navigate to `~/.claude/projects/workflow-lens/` and inspect session files (UUID.jsonl)

4. **Alternative behavior** (if limit is increased or pagination added in future):
   - Dennison clicks "Load more sessions" or "Show next 200" button
   - Server refetches with offset, appending older sessions to the list
   - Dennison finds "May 20" session, clicks it

**Expected result**: Dennison either locates the session and activates it, or acknowledges the limitation and uses another method.

**Variations**:
- **Custom limit query param**: Future enhancement: `?limit=500` or `?offset=200&limit=100` to paginate
- **Date filter**: Future: input field to jump to sessions on/after a specific date
- **Search by title**: Future: text field to search session titles by keyword

**Edge Cases**:
- **Session file corruption**: If session data is unreadable (corrupted .jsonl), the server may skip it or return an error; Dennison sees fewer than 200 sessions in the list
- **Very large sessions (>1MB)**: Fetch may timeout or be slow; UI should show "Reading sessions…" longer
- **Clock skew**: If system clock is wrong, session times may appear out of order (chronological sort uses startedAt timestamp or mtimeMs)

---

## STORY-004: Toggle Empty Sessions (Dennison, Power User)

**Type**: Short  
**Persona**: Dennison (power user with many exploratory, low-cost sessions)  
**Goal**: Hide quick 1-turn, $0.00 sessions to focus on substantial conversations; then show them again.  
**Preconditions**:
- "workflow-lens" project has 50 sessions total: 30 have 0 turns and $0.00 cost (empty), 20 have > 0 turns or cost
- Empty sessions are shown by default in the list

**Steps**:

1. Dennison views the Sessions list (20 shown, 30 empty hidden by default).
   - **Wait**: Re-read the code. Default is to hide empty sessions.
   - **Correction**: By default, only non-empty sessions are shown (showEmptySessions = false in global state)

2. At the bottom of the list, a toggle button appears: "Show 30 empty sessions (no turns, no cost)"
   - **Expected**: Button text conditional: if showEmptySessions is true, text is "Hide X empty sessions"; if false, text is "Show X empty sessions (no turns, no cost)"
   - **Count X**: hiddenCount = all.length - shown.length (30 in this case)

3. Dennison clicks "Show 30 empty sessions".
   - **Expected**: showEmptySessions flips to true; renderSessionsList() re-runs; all 50 sessions now appear
   - **Visual change**: Empty sessions appear with ghost styling (CSS class `sess-row-ghost`): lower opacity, gray text, lighter background

4. Dennison scrolls through and sees the 30 empty sessions interspersed in their date groups.
   - **Empty session card**: Same layout as regular session, but appears faded
   - **No cost badge**: Shows "$0.00" but in gray

5. Dennison clicks "Hide empty sessions" to toggle off.
   - **Expected**: showEmptySessions flips to false; list reverts to 20 non-empty sessions; toggle text updates to "Show 30 empty sessions…"

**Variations**:
- **All sessions are empty**: hiddenCount = all.length; toggle shows "Show X empty sessions" but no non-empty sessions appear
- **No empty sessions**: hiddenCount = 0; toggle button is not rendered at all

**Edge Cases**:
- **Empty session selected (active)**: If Dennison had an empty session active and toggles to hide empty sessions, the identity strip still shows that session (session remains selected server-side); list just doesn't display the empty row

---

## STORY-005: Refresh Sessions & Observe Live Session Changing (Dennison, Power User)

**Type**: Medium  
**Persona**: Dennison  
**Goal**: Watch a running session's cost update in real-time without leaving the Sessions tab; refresh to see latest stats.  
**Preconditions**:
- Dennison has an active Claude Code session running in the "workflow-lens" project (e.g., running a batch workflow)
- The session's transcript is being written to `~/.claude/projects/workflow-lens/<uuid>.jsonl`
- Control Tower shows the Sessions list with this session already visible

**Steps**:

1. Dennison is viewing the Sessions list; sees a session "Optimize batch processing" with cost "$0.02", last updated "14:32".
   - **UI state**: No "live" pill yet (session not updated in last 2 minutes)

2. After 30 seconds, the Claude Code session is still running; cost grows to "$0.05".
   - **Expected**: No live update on the Sessions list UI (the page doesn't auto-refresh; no polling or WebSocket)
   - **Limitation**: List is static; stats are from the last server read

3. Dennison clicks the "Refresh" button (top-right of Sessions card).
   - **Expected**: POST `/v1/sessions?limit=200`; "Reading sessions…" message appears
   - **Result**: Session "Optimize batch processing" now shows cost "$0.05", time updated to "14:42"
   - **Live pill**: If the transcript was modified < 120 seconds ago (2 minutes), the "live" pill appears: `<span class="sess-live-pill" title="Transcript updated in the last 2 minutes — this session appears to be running right now. Stats are its progress so far; hit Refresh to update.">live</span>`

4. Dennison clicks the session to open Active Session tab.
   - **Expected**: Session activates; waterfall and trace load; stats reflect the refreshed data ($0.05 cost)

**Variations**:
- **Session finished**: After refresh, the session no longer has the "live" pill (transcript mtime is now > 2 minutes old)
- **Auto-refresh (future)**: Enhancement to add a "Refresh every 5 seconds" toggle for live monitoring

**Edge Cases**:
- **Session completed + new session started**: After refresh, Dennison sees both the old session ($0.05, finished) and a new session just starting (cost $0.00)
- **Transcript corruption**: If the session transcript becomes unreadable (e.g., file moved), server error occurs; "Could not load sessions: [error]"

---

## STORY-006: Activate Session & Transition to Active Session Tab (John & Dennison)

**Type**: Short (< 2 min)  
**Persona**: John or Dennison  
**Goal**: Click a session in the list; immediately see its waterfall, main trace, and drill-in tabs become available.  
**Preconditions**:
- Sessions tab is open; session list is fully rendered
- A session is visible and clickable, e.g., "What are the top 3 frameworks…"
- No session is currently active (or a different session is active)

**Steps**:

1. John/Dennison sees the session in the list and clicks the row.
   - **Expected**: Click handler on `[data-session-id]` element fires
   - **Backend call**: POST `/v1/session/select` with session id

2. Server responds with success (or error).
   - **Expected**: Session is now marked active in the server's memory
   - **Session cache reset**: lastSession, sessionCollapsed, sessionTree, sessionNestedIndex, subCache, runCache all reset
   - **Navigation**: setTab('session') is called, triggering the Active Session tab to load

3. Page shows the "Active Session" tab.
   - **Expected**: Header says "Session · waterfall"; view toggle shows "Waterfall" | "Nodes"
   - **Identity strip** (above the tabs): "Viewing session "What are the top 3 frameworks…" · Today 14:32 · $0.01 · [badges if any] · switch session ↗"

4. Session waterfall begins rendering.
   - **Expected**: SVG shows main conversation bars (no workflows in John's case, or multiple bars in Dennison's case)
   - **Status**: "Reconstructing the conversation…" spinner appears briefly while main trace is fetched

5. Main conversation trace lazy-loads in a collapsible `<details>` section.
   - **Expected**: `<summary>` text: "Main conversation trace — the chat itself, turn by turn (inference vs tool, full text)"
   - **Status**: "Reconstructing the conversation…" message in the body while data loads

6. Dennison clicks "Sessions" button in the identity strip.
   - **Expected**: Sessions tab shows again; selectedSession ID is retained server-side; tabs (Active Session, Workflows, Subagents) stay populated but tab panel is hidden

**Variations**:
- **Switching between sessions**: Dennison clicks another session; POST `/v1/session/select` fires; all caches reset; Active Session tab reloads the new session's data
- **Session has been deleted**: POST fails with error; alert shown: "Could not select session: [error]"

**Edge Cases**:
- **Session with no trace data**: Active Session tab shows empty state or error: "No trace data found for this session"
- **Double-click**: If Dennison double-clicks a session row, only one POST fires (click handler is on the row, not on its children, so bubbling is caught once)

---

## STORY-007: Zero Sessions in Folder (John, Onboarding)

**Type**: Short  
**Persona**: John (new user, never run Claude Code in this folder)  
**Goal**: Understand that sessions will appear once a conversation is started; no confusion about missing data.  
**Preconditions**:
- John creates a new project folder (e.g., `~/new-experiment`) but hasn't run Claude Code in it yet
- `~/.claude/projects/new-experiment/` does not exist or is empty
- John navigates to Control Tower and selects this project

**Steps**:

1. John switches to "new-experiment" project via the dropdown.
   - **Expected**: Project picker shows "~/new-experiment · 0 sessions"
   - **Backend**: POST `/v1/project/select` with slug="new-experiment"

2. Session list renders empty state.
   - **Expected**: Large SVG icon (network diagram); heading "No sessions in this folder yet"; subheading "Run Claude Code in this project and its sessions will appear here."
   - **HTML**: ctEmptyHtml('No sessions in this folder yet', 'Run Claude Code in this project and its sessions will appear here.', '')

3. John closes Control Tower and runs Claude Code in `~/new-experiment`.
   - **Expected**: Claude Code creates `~/.claude/projects/new-experiment/` and writes session transcripts

4. John returns to Control Tower and refreshes the Sessions tab (or page-reload).
   - **Expected**: Session list now shows the newly-created session(s)

**Variations**:
- **Refresh without leaving tab**: John clicks "Refresh" button; `/v1/sessions` is called; list updates
- **Project folder exists but is unreadable**: Error message: "Could not load sessions: [error]"

**Edge Cases**:
- **Race condition**: John runs Claude Code while Control Tower is open; he refreshes Sessions tab; new session appears immediately

---

## STORY-008: Context Line on Sessions Tab (Dennison, Power User)

**Type**: Short  
**Persona**: Dennison (power user with many codebases)  
**Goal**: Understand which project folder and git branch a session came from without leaving the Sessions list.  
**Preconditions**:
- Dennison has sessions in the "workflow-lens" project from multiple branches (main, feature/optimize, bugfix/edge-case)
- Dennison wants to compare a session from "feature/optimize" against one from "main"

**Steps**:

1. Dennison views the Sessions list for "workflow-lens" project.
   - **Expected**: Below the project picker, a context line appears: "[full project path] · cwd: [working directory] · branch: main" (or git branch if available)
   - **HTML**: `<div id="sessions-context" class="project-context"></div>` renders after loadProjectsPicker()
   - **Note**: The discovery doc mentions this for Workflows/Subagents tabs; Sessions tab may or may not display the context line. Assume it does (or refer to actual UI).

2. Dennison clicks a session to activate it; switches to Active Session tab.
   - **Expected**: The same context line persists in the Active Session tab (shared in `#session-context`)
   - **Info**: Helps Dennison confirm which cwd and branch the session ran in

3. Dennison switches back to Sessions tab.
   - **Expected**: Context line remains visible

**Variations**:
- **No git branch** (detached HEAD or not a git repo): Branch field is empty or shows "n/a"
- **Different cwd per session**: If sessions ran in different subdirectories of the same project, cwd is the same (project root); cwd reflects the project folder, not per-session working directory (check discovery doc for exact spec)

**Edge Cases**:
- **Project path very long**: Path may wrap or truncate; no scrolling container specified; CSS may use `overflow:hidden` and `text-overflow:ellipsis`

---

## STORY-009: Per-Day Cost Rollup (Dennison, Cost Auditor)

**Type**: Short  
**Persona**: Dennison (cost evaluator, tracking spend per day)  
**Goal**: Quickly see how much was spent on a given day (e.g., Tuesday) without summing individual session costs.  
**Preconditions**:
- "workflow-lens" project has 10 sessions on "Today", ranging from $0.001 to $0.15 each
- Total cost for today: ~$0.47

**Steps**:

1. Dennison views Sessions list, scrolled to "Today" group.
   - **Expected**: Group header shows "Today · 10 sessions · $0.47"
   - **Calculation**: dayCost = g.items.reduce((a, b) => a + (b.costUsd || 0), 0)
   - **Format**: Displayed as `fmtUsdShort(dayCost)` → "$0.47" (or similar, depending on rounding)

2. Dennison glances at the cost to see if today was expensive.
   - **Expected**: Rollup makes quick auditing easy; no need to sum 10 individual session costs

3. Dennison scrolls down to "Yesterday" group.
   - **Expected**: "Yesterday · 3 sessions · $0.02" (lower cost than today)

**Variations**:
- **Single session in a day**: Group header still shows the rollup, e.g., "Wed, Jun 28 · 1 session · $0.005"
- **Zero-cost day**: Group header shows "Today · 2 sessions · $0.00" (empty sessions)

**Edge Cases**:
- **Very small costs**: "Today · 1 session · $0.00" (rounding artifact; actual cost is $0.00001, which rounds to "$0.00")

---

## STORY-010: Cost Tooltip Nuance (John, Cost-Conscious User)

**Type**: Short  
**Persona**: John  
**Goal**: Understand that the cost shown on a session card is the conversation's cost only, not including workflows or subagents.  
**Preconditions**:
- A session "Optimize batch processing" launched 2 workflows
- Session's own cost: $0.02
- Workflow costs (combined): $0.35
- Total cost (session + workflows): $0.37

**Steps**:

1. John views the Sessions list; sees the session "Optimize batch processing" with cost "$0.02".
   - **Expected**: Cost displayed as "$0.02" on the session row (conversation only)
   - **UI tooltip**: On hover over the cost cell, tooltip appears: "conversation cost — workflows/subagents add more (see Active Session for the full total)"

2. John hovers over the cost "$0.02".
   - **Expected**: Tooltip shows: "conversation cost — workflows/subagents add more (see Active Session for the full total)"
   - **HTML**: title attribute on the `<span class="sess-cost">` element

3. John clicks the session to open Active Session tab.
   - **Expected**: Stat cards show full cost rollup: "Total Cost: $0.37" (including workflows)
   - **Clarity**: "Every workflow and subagent here was launched by the main session…" caveat text below the waterfall explains the relationship

**Variations**:
- **Session with no workflows**: Cost on card = total cost; no additional spend in Active Session tab
- **Active Session tab waterfall legend**: Shows main session cost separately from workflows, so John can see the breakdown

**Edge Cases**:
- **Cost tooltip text cut off**: Very long tooltip may overflow screen; browser's default tooltip (title attr) clips or wraps
- **Accessibility**: Tooltip is visual only; screen reader does not announce it; alt text needed if ARIA labels are added

---

## STORY-011: Model Tier Indicator (John & Dennison)

**Type**: Short  
**Persona**: John or Dennison  
**Goal**: Quickly see which model family a session primarily used (haiku, sonnet, opus) via a color-coded dot.  
**Preconditions**:
- Sessions list is visible; sessions have `s.model` and `s.tier` fields

**Steps**:

1. John/Dennison views the Sessions list.
   - **Expected**: Far right of each session row, a small colored dot appears
   - **Color mapping**: 
     - Green (#3b8e6e) = haiku
     - Tan (#9c6b2e) = sonnet
     - Red (#a33) = opus
   - **HTML**: `<span class="tier-dot" title="[model name]" style="background:[color]"></span>`

2. John sees mostly green dots (haiku) and occasionally tan (sonnet).
   - **Expected**: Confirms his conversations used cheaper models
   - **Quick scan**: Dennison can spot a red dot (opus) at a glance and drill in to see why it was expensive

3. John hovers over a dot to see the full model name.
   - **Expected**: Tooltip (title attr) shows e.g. "claude-3-5-haiku-20241022"
   - **Implementation**: title="[s.model]"

**Variations**:
- **Unknown model**: Dot appears gray; tooltip says "unknown" (fallback in tierColor() function)
- **Multi-model session**: Tier reflects the primary/last model used (s.tier field); doesn't show a mix

**Edge Cases**:
- **Color-blind user**: Dots alone are not sufficient for accessibility; text label or pattern would help (not currently in UI; future enhancement)

---

## STORY-012: Active & Live Pills (Dennison, Power User Monitoring)

**Type**: Short  
**Persona**: Dennison  
**Goal**: Instantly see which session is currently active (in the drill-in tabs) and which sessions are still running.  
**Preconditions**:
- "workflow-lens" project has 3 sessions; one is selected (active); one is currently running
- Control Tower has been open for the past 10 minutes while Dennison works

**Steps**:

1. Dennison views the Sessions list; notices the session "Optimize batch processing" has a light blue pill: "active".
   - **Expected**: Pill appears on the row where `s.id === activeId` (from GET `/v1/sessions`)
   - **HTML**: `<span class="sess-active-pill">active</span>` (defined in renderSessionsList)
   - **Color**: Styled with `--blue` (highlight color)
   - **Position**: Inline after the session title, before badges

2. Dennison notices another session "Add CLI flag for --debug" has an orange pill: "live" with a tooltip.
   - **Expected**: Pill appears when `(Date.now() - (s.mtimeMs || 0)) < 120000` (modified < 2 minutes ago)
   - **HTML**: `<span class="sess-live-pill" title="Transcript updated in the last 2 minutes — this session appears to be running right now. Stats are its progress so far; hit Refresh to update.">live</span>`
   - **Tooltip**: Explains that stats are in-progress; user should refresh to get the latest

3. Dennison clicks Refresh.
   - **Expected**: `/v1/sessions` is fetched again; the "live" pill may disappear if the session finished (mtime is now old)

4. Dennison switches to the "Optimize batch processing" session and opens Active Session tab.
   - **Expected**: In the identity strip (title area), the "active" pill is not shown (only in Sessions list); "live" pill may be shown if the session is still running

**Variations**:
- **Multiple active sessions (future)**: If the server is extended to track a session-per-tab, multiple rows could have "active" pills
- **Completed session**: "live" pill disappears after the session finishes (mtime > 2 minutes old)

**Edge Cases**:
- **Clock skew**: If system clock is wrong, mtime check gives incorrect results; session may show "live" incorrectly or vice versa
- **Partial session**: Session with 0 turns and 0 cost still shows "live" pill if recently modified (even though it's empty)

---

## Summary

These 12 stories cover the full Sessions Home journey: initial load, project switching, session browsing and filtering, activation, live monitoring, cost rollups, and UI affordances. Personas John (plain sessions, first-time) and Dennison (power user, 197 projects) explore realistic workflows from session discovery to drill-in, with context-sensitive tooltips and cost transparency. All stories reference actual UI labels and backend endpoints from the codebase.

**Stories produced**: 12 (STORY-001 through STORY-012)

