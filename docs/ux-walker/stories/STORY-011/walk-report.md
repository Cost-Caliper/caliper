# STORY-011 — John's Zero-Workflow Session Comprehension

**Persona**: John (engineer who doesn't use workflows/subagents)
**Session under test**: "tell my frind about this user, be concise" — `~/develop/agent-university` project, Fri Jun 12 20:47, $0.808, 4 turns, 0 workflows, 0 subagents.
**Verdict: PASS** — no blocking or high-severity findings. The plain-session experience is clean, self-explanatory, and does not show confusing empty sections.

## Setup note (environment, not app UX)

The Control Tower server initially running on `:8787` was a **stale cached plugin build**
(`~/.claude/plugins/cache/workflow-lens/workflow-lens/0.1.0/`) that predates the Sessions /
Active Session / Subagents feature entirely — it only exposed "Control (shim)" and "Observe
(native)" tabs. Killed PID 56245 and started the real source server
(`~/develop/workflow-lens/packages/control-tower/server.mjs`) on the same port. After that,
Sessions/Active Session/Workflows/Subagents tabs appeared as expected. This is an environment
setup issue, not a UX defect in the app itself, but is worth flagging so future walks don't
silently test a dead build.

## Walk

1. **Sessions tab → project picker**: default project (`open-agents/provo`) showed
   `Could not load sessions: [object Object]` — a real error-surfacing bug (see finding
   F-011-1). Switched project via the picker to `~/develop/agent-university` (5 sessions) and
   found the target session immediately in the Jun 12 date group.
2. **Click session row → Active Session tab**: landed correctly and fast.
   - Identity strip: `VIEWING SESSION "tell my frind about this user, be concise" · Fri, Jun 12
     20:47 · $0.808` — title is quoted, date and cost present. Judged **against the 5-second
     comprehension test as John: pass**. No jargon, no ambiguity about what session I'm looking
     at.
   - Rollup line: "This session = the main conversation · $0.808 estimated · spanned 7s" — plain
     language, no dangling "+ 0 workflows + 0 subagents" wording (would have been noise) — the
     app cleanly omits the additive language when there's nothing to add. Good restraint.
   - Stat cards: MAIN CONVERSATION $0.808 (100%), BIGGEST SINGLE $0.808, POTENTIAL SAVINGS
     $0.676 (84%) — internally consistent, no contradiction for John to puzzle over.
   - "Where the estimated cost went": single bar "main conversation (this chat)" at 100%,
     model legend "opus $0.808 (100%)" — reads correctly as the only line item.
3. **Waterfall view**: Row 0 only, gray bar spanning full width, labeled "main conversation",
   duration "7.0 s" right-aligned. Note directly below: *"This session launched no workflows or
   subagents — the bar is the conversation itself. Click it to inspect the chat timeline."*
   This is exactly the honest, plain-language copy STORY-011 expects — a first-timer is told
   in one sentence why the waterfall looks sparse, and is invited to interact rather than left
   wondering if something failed to load.
4. **Click the waterfall bar** → automatically opened and scrolled to the "Main conversation
   trace" section (fully expanded), showing Timeline SVG, meta chips (model `fable-5`, wall
   7.0s, cost $0.808449, tok 33,460→906, cache, turns 4, tool calls 1), "Trace — 3 steps"
   (Inference/Tool·Read/Inference rows), Task box with the literal prompt, Conversation
   disclosure, and Output box. All legible on first look — no additional clicks needed to
   understand what happened in this chat.
5. Verified the identity strip persists correctly when switching away to Subagents and back —
   title/date/cost stay pinned in the strip across tabs.

## Findings

See `findings.json`. One medium-severity finding (raw `[object Object]` error surfaced on the
Sessions tab for a different project) — encountered incidentally while locating the target
session, not part of John's plain-session path itself, but real and worth fixing since it's the
literal opposite of the honest-error-copy pattern the rest of the app follows well.

## Screenshots

- `00-initial-load.png` — stale-build state before server fix (Control/Observe tabs only)
- `01-sessions-tab-initial.png` — correct build, Sessions tab, default project error
- `02-feed-project-sessions.png`, `02b-feed-project-scrolled.png` — wrong-project detour while searching
- `03-islamabad-project.png` — wrong-project detour (large active session, not the target)
- `04-agent-university-project.png` — correct project, target session visible
- `05-active-session-plain-landing.png` — Active Session landing for the plain session
- `06-savings-and-waterfall.png` — savings panel + waterfall Row 0 + note
- `07-click-waterfall-bar-opens-trace.png` — trace auto-opened after bar click
- `08-scrolled-top-identity-strip.png` — identity strip persists on Subagents tab
