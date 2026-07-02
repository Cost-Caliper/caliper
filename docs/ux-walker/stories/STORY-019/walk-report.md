# STORY-019 Walk Report — Insight-bar click → cross-tab jump + auto-expand

**Date**: 2026-07-01
**Session under test**: "Feed: call this agent 'Agent University'..." (rich session, 15 workflows, 3 subagents, $253/$622 total)
**Tool**: `agent-browser --session ux-walker-8787` against `http://localhost:8787`

## Verdict: FAIL — workflow (`wf`) jump does not auto-expand or scroll to the target row

## What I did

1. From Active Session / Waterfall, located the insight card's "Where the estimated cost went"
   leaderboard. Top bars: main conversation $253 (41%), degree-build $83.26 (13%), degree-build
   $60.77 (10%), degree-distill $42.56 (7%), degree-build $36.06 (6%).
2. Clicked the biggest **workflow** bar — "degree-build $83.26 · 13%" (24 agents, the
   `a89488c9-6e5` run, Jun 8 8:51 PM). The tab correctly switched to **Workflows**.
3. Checked every row's `aria-expanded` attribute via the accessibility snapshot and via direct
   DOM query: **all 15 rows read `expanded=false`**, including the target row
   `a89488c9-6e5` ("degree-build", 24 agents, $83.26, 16m 0s) which was clearly visible in the
   list but never opened. No scrollIntoView/centering occurred either — the list was simply
   sitting at whatever scroll position it had from the previous view, and a stale-looking
   `:hover`-style darkened row (a *different*, unrelated "degree-poc $3.10" row) was visible,
   which is not a real selection indicator, just leftover mouse-hover CSS.
4. Reproduced this from a hard page reload (`open http://localhost:8787/#/session` then a
   fresh click) to rule out state corruption from earlier testing — **same result**: tab
   switches, but the target row never expands and is not scrolled to or otherwise marked.
5. Checked `agent-browser errors` and `agent-browser console` at every step — **completely
   empty** both times. This is a silent failure, not a crashing one.
6. Verified the accordion mechanism itself is healthy: manually clicking the same row's
   `<tr role="button" aria-expanded="false">` flipped it to `aria-expanded="true"` immediately
   and rendered the full stat-card + timeline detail. So the bug is specifically in the
   insight-bar → `navigateToRun` → auto-expand wiring, not in the Workflows accordion itself.
7. Verified this isn't a CSS.escape/id-mangling edge case: the target run id
   (`a89488c9-6e5`) is a plain hyphenated alphanumeric string with nothing that would need
   escaping.
8. Browser **Back** from the Workflows tab correctly returned to `#/session` (Active Session
   tab) — hash-based navigation itself works fine, it's only the in-tab auto-expand/scroll that
   is missing.
9. Clicked a **subagent** waterfall bar (`data-nav-kind="sub"`, id `aca5aedc8158399a9`,
   "Automate free-tier signups via AgentMail") — this correctly jumped to the **Subagents**
   tab AND auto-opened the full subagent detail (identity chip, timeline, meta chips, 133-step
   trace, task text) with the node highlighted (green box) in the parent→child tree. This path
   works as specced.
10. Clicked the **"main conversation (this chat)"** row in the insight card — correctly jumped
    to the Subagents tab and opened the "main session" detail (471-step trace, cost
    $253.337847, task = the original session prompt). Identity strip stayed visible and
    correct throughout. This path also works as specced.

## Clarity judgment

The **subagent** and **main-conversation** jumps are clear and non-disorienting: the identity
strip persists, the opened detail is immediately and unambiguously labeled (own task text,
own cost, own trace), and the selected node is highlighted green in the tree above it. A
first-timer would have no trouble telling which item they landed on.

The **workflow** jump is disorienting by comparison: after the tab switch, the user is dropped
into a flat list of 15 rows (several sharing the same "degree-build"/"degree-poc" name) with
no visual indicator of which one corresponds to the bar they just clicked, no auto-expand, and
no scroll-to-center. A first-timer who clicked "degree-build $83.26" would have to manually
scan the Cost column for "$83.26" themselves — the exact manual work the auto-jump feature is
supposed to save them from.

## Findings

See `findings.json`. One high-severity functional finding (F-019-1: workflow auto-expand
silently no-ops) and one informational note confirming the subagent/main-conversation paths
work correctly for contrast.
