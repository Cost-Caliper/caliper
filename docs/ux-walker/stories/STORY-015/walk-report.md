# STORY-015 Walk Report — Nodes view fold/unfold + hover branch-highlight

**Date**: 2026-07-01
**Session under test**: "Feed: call this agent 'Agent University'..." (rich session, 15 workflows, 3 subagents, $253/$622 total, 227 total nodes)
**Tool**: `agent-browser --session ux-walker-8787` against `http://localhost:8787`

## Verdict: PASS (with one real navigation-target ambiguity noted, not a functional bug)

## What I did

1. Activated the rich session from the Sessions tab.
2. On Active Session, switched the seg-control from Waterfall to Nodes.
3. Verified the collapsed overview: 18 top-level nodes (workflows + direct subagents) fanning
   out from a pinned "main session" node at depth 0, each showing a `▸ N` collapsed badge
   (rendered as "workflow-name  ▸ 41" style text inside the SVG node). Hint text read
   **"18 of 227 nodes shown · click ▸ to expand · drag/two-finger to pan · ⌘/Ctrl+scroll to
   zoom · hover to trace a branch"** — matches spec.
4. Clicked a node body directly (via accessibility ref) — this navigated to the **Workflows
   tab** and opened that run there (see finding F-015-1). This is a *different, legitimate*
   click target (`.snode`, `data-nav-kind="wf"`) from the fold chevron.
5. Found the real fold chevron is a separate child SVG group (`.sfold`, no text label,
   accessibility-invisible) nested inside each `.snode`. Dispatching a click on `.sfold`
   correctly expanded exactly one workflow in place (`degree-poc · 12 inside` → showed its 2
   `wagent` children, node count 18→20), leaving every other row collapsed. Re-collapsing via
   the same target worked too.
6. Clicked "Expand all" — all 227 nodes rendered (button flipped to "Collapse all", hint text
   updated to "227 of 227 nodes shown"). Screenshot confirms a full, readable (if very tall —
   scrollHeight ~4708px at 100%) faint tree.
7. Hovered a depth-2 node ("audit:langchain") — it and its ancestor ("degree-scout") both
   brightened while all 225 other nodes dimmed to a faint gray. Screenshot captured
   (`15-nodes-hover-branch-highlight.png`) — this is the single most convincing screenshot of
   the whole story.
8. Hovered the ancestor itself ("degree-scout", fully expanded, 41 descendants) — full branch
   (all descendants, since everything was already expanded) stayed lit, confirming the
   ancestor+descendant highlight logic.
9. Tested zoom: Zoom In → 100%→125% (label updated correctly); Zoom Out ×2 → 125%→100%→80%
   (label updated correctly each step, node text visibly scaled). Fit did not change the 100%
   label or shrink vertically — confirmed by design (spec: "fit-to-width... no vertical
   shrink"); the canvas remains a ~4700px-tall scrollable area at 100% zoom regardless.
10. Collapsed everything again via "Collapse all", then expanded exactly one workflow
    ("verify-learnings-search", 5 inside) via its `.sfold` chevron (node count 19→24). Clicking
    this fold did **not** navigate tabs (stayed on Active Session) — confirms fold vs. navigate
    are cleanly separate for this target.
11. Toggled to Waterfall, then back to Nodes: node count was still 24 and the same workflow
    ("verify-learnings-search") was still expanded showing its 5 children (`build+test`,
    `reindex`, `live-search+mcp`, `tdd-repair`, `reverify`) — **fold state correctly persisted**
    across the view toggle, matching spec ("sessionCollapsed Set retained").

No JavaScript errors were reported by `agent-browser errors` at any point in this story.

## Clarity judgment (first-timer test)

A first-timer would understand the collapsed overview immediately — the pinned "main session"
root, the fan-out, the color legend (Workflow / Workflow agent / Subagent), and the caveat
sentence directly below the tree ("Everything the session ran, nested... Workflows start
folded — click ▸ to open one, or Expand all to see every node faintly and hover to trace a
branch. Click a workflow/subagent to open it.") are all in view together.

However, that same caveat sentence is where the one real point of friction lives: it says
**"click ▸ to open one"** immediately followed by **"click a workflow/subagent to open it"** —
two different actions on what visually reads as the same clickable node, with only a tiny
(text-less, accessibility-invisible) chevron glyph distinguishing "expand in place" from
"navigate away to another tab." In my testing, the very first time I tried this (clicking what
I intended as "the node"), I landed on the Workflows tab instead of getting an in-place
expand — which is *correct per the app's own design* (the chevron and the node label are
different hit-targets) but is very easy for a real user to trigate by accident, especially
since the whole node rect appears clickable (`cursor:pointer` is set on the `.snode` group, not
narrowed to just the chevron).

## Findings

See `findings.json`. One informational/UX finding (F-015-1) about the dual-purpose click
target and the chevron's accessibility invisibility. No functional defects found — fold,
expand-all, zoom, hover-highlight, and fold-state persistence all worked exactly as specced.
