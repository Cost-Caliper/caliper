# STORY-035 — Subagent drill-in: conversation + breadcrumb + browser Back

**Verdict: PASS (1 low-severity finding)**

## Path walked
1. From Subagents tab (Tree view, flat forest), clicked "Automate free-tier signups via
   AgentMail" → detail slot opened and auto-scrolled straight to the trace panel.
   Breadcrumb confirmed at the top of the slot: "← all subagents / ↑ main conversation /
   this subagent". The selected node in the tree diagram got a green highlight border.
2. Located and expanded "Conversation — every agent ↔ user text, in order (55 turns)".
   Content is readable: role label (`USER`/`AGENT`) in a left column, message text in a
   scrollable box that doesn't blow out the page, monospace-flavored styling consistent
   with the rest of the trace UI. Good readability for a debug/audit read-through.
3. Clicked "↑ main conversation" in the breadcrumb → detail slot switched to
   MAIN_SESSION: heading "main session — full trace", full-session timeline (28h 19m 9s),
   meta chips (opus-4-8, wall 28h 19m 9s, cost $97.639499, tok 100,563→318,389, turns 605,
   tool calls 251), Task section showing the actual original prompt ("Feed: call this
   agent \"Agent University\". Then get up to speed with what we have here."). Breadcrumb
   correctly changed to "← all subagents / main conversation (the thread itself)" (no
   longer offering "↑ main conversation" since we're already there).
4. Clicked "← all subagents" → detail slot closed entirely, list scrolled to top. Hash
   confirmed dropping the agent-id segment.
5. Re-selected a subagent ("Free-tier signups for 4 data/voice tools"), confirmed hash
   became `#/subagents/<sessionId>/<agentId>`. Clicked "↑ main conversation" — hash
   became `#/subagents/<sessionId>/__MAIN_SESSION__`.
6. **Browser Back #1**: hash reverted to `#/subagents/<sessionId>/<agentId>`, and the UI
   genuinely re-rendered the previous subagent's detail (not just the hash) — confirmed
   visually: heading "You are automating FREE-TIER signups for four developer tool —
   full trace", breadcrumb "← all subagents / ↑ main conversation / this subagent".
   Identity strip re-checked at this point and confirmed correct: "Feed: call this
   agent \"Agent University\"…" · $97.64 · 15 wf · 3 sub, with the Subagents tab still
   marked selected.
7. **Browser Back #2**: hash reverted to `#/subagents/<sessionId>` (no agent segment);
   UI closed the detail slot back to the plain list, matching the breadcrumb-driven "←
   all subagents" behavior exactly.
8. Checked `errors` and `console` after every step above — zero errors, zero console
   output throughout the whole drill-in / breadcrumb / Back sequence.

## Finding: stale tree-selection highlight survives navigation
When a subagent is selected in Tree view, its node gets a thick green selection border
(`stroke-width: 2.5` vs `1.25` for others — confirmed via DOM query). After navigating
away from that subagent via "↑ main conversation" (now viewing MAIN_SESSION) or via
"← all subagents" (now viewing nothing), the previously-selected node's thick green
border is never cleared and no other node picks it up. Reproduced twice, with two
different subagents, across both navigation paths. See finding F-035-1.

## Screenshots
- `00-drill-in-detail.png` — subagent detail opens (auto-scrolled to trace)
- `01-breadcrumb-top.png` — breadcrumb + selected-node highlight in tree
- `03-breadcrumb-found.png` — breadcrumb clearly visible above the trace panel
- `04-conversation-expanded.png` — Conversation section content (scrolled mid-view)
- `05-conversation-section.png` — Conversation section heading + first turns, readable
- `06-main-conversation-view.png` — after "↑ main conversation" click
- `07-breadcrumb-main-session.png` — breadcrumb changed + tree still shows stale highlight
- `08-back-to-list.png` — "← all subagents" closes detail, tree still shows stale highlight
- `09-back-1-reopens-subagent.png` — browser Back #1 reopens the exact previous subagent
- `10-identity-strip-check.png` — identity strip verified correct mid-flow
- `11-back-2-list-no-selection.png` — browser Back #2 lands on the plain list
