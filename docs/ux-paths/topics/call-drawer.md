# Topic: Call-Detail Drawer & Step Inspection (shared across tabs)

Personas: engineer debugging a slow agent; someone reading Claude's thinking; someone verifying a tool error.

## STORY-CD1: Engineer clicks a timeline segment to inspect a single inference step
**Type**: short · **Persona**: engineer debugging why an agent took 12 minutes
**Goal**: understand what one blue (inference) segment did
**Preconditions**: Workflows tab, a run expanded, timeline visible
### Steps
1. Hover segment → tooltip "Inference · 2.1 s" → click
2. Right drawer slides in: "Inference step" header
3. Metadata chips: output/input/cache-read/cache-write/cost/speed/stop/model
4. "decided to call:" lists tool names; model output text below
5. Close → drawer slides out
### Edge Cases
- Segment with merged turns shows "turns N" chip

## STORY-CD2: Trace-row click from full call detail
**Type**: short · **Persona**: same
**Preconditions**: Subagents tab, subagent detail open with "Trace — N steps"
### Steps
1. Click trace row #5 "Tool · Bash · 1.8 s"
2. Drawer opens with tool card: name + ✓ ok / ✗ error badge
3. Input JSON (highlighted), Result with char-count badge, scrollable
4. Close → returns to detail; trace rows persist

## STORY-CD3: Inspect a failed tool call
**Type**: medium · **Persona**: someone verifying a tool error
### Steps
1. Open a tool step whose call has isError
2. Red ✗ error badge; Input shows what was sent
3. Result shows the full error text (timeout, refusal, etc.)
4. User concludes root cause without leaving the dashboard
### ACs
- Error state visible at a glance; full error text scrollable, not truncated

## STORY-CD4: Read extended thinking
**Type**: short · **Persona**: someone reading Claude's reasoning
### Steps
1. Open an inference step that carried extended thinking
2. "Reasoning (extended thinking)" section renders as its own scrollable block (30vh)
3. Model output for the step follows separately
### Edge Cases
- No thinking → section absent entirely (no empty placeholder)

## STORY-CD5: Scroll a very long tool result
**Type**: short
### Steps
1. Open a tool step with a 47k-char result
2. Result block scrolls independently (max-height 46vh); drawer doesn't jump
3. Char-count badge shows true size

## STORY-CD6: Close and reopen across steps
**Type**: short
### Steps
1. Open step #3 → Close (button, scrim click, or Escape)
2. Open step #7 → drawer re-renders smoothly with new content

## STORY-CD7: Read metadata chips for cost/performance
**Type**: medium · **Persona**: engineer attributing cost
### Steps
1. Open an inference step
2. Hover each chip: output tok, input tok, cache-read (0.10×), cache-write (1.25×), cost, tok/s, stop reason, model
3. Compare step cost to neighbors; understand cache-read dominance

## STORY-CD8: Tool-only inference step (edge)
### Steps
1. Open an inference step with no text
2. Output block reads "(no text — this step only emitted a tool call)"
3. "decided to call:" still lists the tools
