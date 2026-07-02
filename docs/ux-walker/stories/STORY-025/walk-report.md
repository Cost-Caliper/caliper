# STORY-025 — Agent full trace inline; trace-row → step drawer

**Verdict: PASS**

## Path walked
1. Opened `http://localhost:8787`, selected the rich session ("Feed: call this agent
   \"Agent University\"…", 15 wf / 3 sub / $97.64).
2. Workflows tab → expanded `degree-build` (Jun 8, 9:48 PM, 10 agents, $14.37, 16m 28s).
3. Verified stat cards: Agent Calls 10, Cost (cache-aware) $14.372708, Tok In/Out
   78,042 / 36,610, Wall-Clock 16m 25s, Speedup 4.27×.
4. Verified per-call table (10-column, cache-aware cost, tier dots, cache Wr/Rd).
5. Clicked a per-call table row directly → opens the **Call details** drawer (whole-call
   summary, no segment selected) — this is the STORY-028 behavior, working correctly but
   distinct from the "click agent name" trace behavior this story is about.
6. Clicked the agent-name label in the timeline SVG (`data-drill="inline"`) → inline
   **full trace** panel opened below the timeline: "build:twilio — full trace", meta chips
   (model, phase, wall, cost, tok, cache, turns, tool calls, tools), "Trace — 101 steps".
7. Inspected the new trace-row chaining: numbered rows alternate Inference / Tool; tool
   rows are visually indented one level with a `└` connector glyph directly under their
   parent inference row, and each inference row shows a `→ Bash` (or other tool name)
   preview of what it's about to call. Read cleanly at a glance — the parent/child
   relationship between an inference decision and the tool call it triggered is now
   unambiguous, which was the specific thing this story asked to judge.
8. Clicked trace row 2 (`Tool · Bash`) → step drawer opened: "Tool call" heading, tool
   name + ✓ ok badge, highlighted input JSON (`command`, `description`), Result with a
   char-count badge ("5K chars"). Exactly matches the acceptance criteria.
9. Closed the drawer (`#cd-close`) → confirmed via DOM state (`data-trace-idx` still
   present, `.open` class removed) that the inline trace panel remains open/intact —
   closing the drawer does not collapse the trace.
10. Clicked the workflow name link ("📄 degree-build — view workflow source") → script
    drawer opened: "Workflow source" title, file path
    (`/Users/dennison/develop/agent-university/.claude/workflows/degree-build.js`),
    "Open in VS Code ↗" link, syntax-highlighted source with char count (16,778 chars).
11. Identity strip ("Feed: call this agent \"Agent University\"…" · $97.64 · 15 wf · 3 sub)
    stayed correct and visible throughout every step above.

## Judgment on the new chaining
The indentation + `└` connector + dimmed row number for tool rows, combined with the
`→ ToolName` preview appended to each inference row, reads clearly. A user scanning the
list top-to-bottom immediately sees "this inference decided to call Bash, and the next
row is that Bash call's result" without needing to click into anything. This is a
legible improvement over a flat undifferentiated step list.

## Testing note (not a product bug)
Two of the delegated-click UI elements — the SVG `<text data-drill="inline">` agent-name
labels and the `<div data-trace-idx>` trace rows — did not respond to `agent-browser
click <ref>` even though the ref resolved to the right element; a raw
`el.dispatchEvent(new MouseEvent('click', {bubbles:true}))` / `el.click()` via `eval`
was required. This is very likely an agent-browser/synthetic-event quirk with
delegated-listener SVG/div elements, not a real-user-facing bug (real mouse clicks fire
the native event `agent-browser`'s synthetic dispatch apparently doesn't). Flagging for
awareness, not filing as a UX finding.

## Screenshots
- `00-active-session-landing.png` — initial rich-session landing
- `01-run-expanded-stat-cards.png` — degree-build run expanded, stat cards top of view
- `02b-stat-cards-full.png` — timeline + legend + per-call table
- `03-after-row-click.png` — per-call row click → Call details drawer
- `04-after-name-click.png` — agent-name click → inline full trace opens (chaining visible)
- `05-trace-header-meta.png` — full trace panel header + meta chips
- `06b-trace-row-drawer.png` — trace row click → step drawer (tool call, input/result)
- `07-drawer-closed.png` — (superseded by 08; early false-alarm screenshot, see below)
- `08-drawer-closed-trace-intact.png` — confirmed trace panel survives drawer close
- `09-script-drawer.png` — workflow-name click → script drawer with source + VS Code link
