---
name: distill-fable
description: Use Fable (claude-fable-5), before it's removed from Claude Code, as a planner/analyzer over the user's own real past coding sessions on this machine, and — with consent — write a personal skill that captures its concrete heuristics so Opus can approximate its thinking style. Use when the user asks to "capture Fable's thinking", "preserve how Fable works", "teach Opus to think like Fable", "distill Fable's approach into a skill", or invokes /distill-fable.
---

# Distill Fable's thinking into a portable skill

Fable is being removed from Claude Code. This turns real evidence of how it actually
worked — its own past assistant turns, machine-wide, in main sessions AND subagents —
into a personal skill Opus can load afterward. Everything you conclude must be grounded
in a real excerpt; no invented heuristics, no "Fable was great at X" without a citation.

## 1. Gather evidence

`packages/control-tower/src/fable-evidence.mjs::gatherFableEvidence(projectsRoot, opts)`
already does the hard part: a cheap shortlist pass over every session on the machine
(main session tier, or `fallbacks.from === 'claude-fable-5'` for a session that started
on Fable and got switched away mid-run), then a per-turn extraction pass that reads each
qualifying transcript directly — so a Fable turn immediately followed by a post-fallback
Opus turn in the *same file* is never misattributed either way.

Call it directly (adjust the raw string escaping for your shell):

```sh
node -e "
import('${CLAUDE_PLUGIN_ROOT}/packages/control-tower/src/fable-evidence.mjs').then(({ gatherFableEvidence }) => {
  const os = require('os'); const path = require('path')
  const root = path.join(os.homedir(), '.claude', 'projects')
  // The function's own defaults (200 excerpts / 150K chars) are conservative; a real
  // distillation run wants more raw material to draw a genuinely diverse sample from.
  const { excerpts, manifest } = gatherFableEvidence(root, { maxTotalChars: 400000 })
  console.log(JSON.stringify({ manifest, excerpts }))
})
"
```

- Report the manifest to the user before doing anything else: how many projects/sessions
  were scanned, how many genuine Fable turns were found vs. kept, and the date range.
  This machine's real numbers — never invented ones.
- If `excerpts` is empty, say so plainly and stop. There is nothing to distill; do not
  fabricate heuristics from zero evidence.
- Note the sampling bias out loud: excerpts are chosen by length (most substantive
  turns), which can cluster around a few sessions. When you batch excerpts for the
  Workflow below, deliberately spread each batch across DIFFERENT `sessionId`/
  `projectSlug` values rather than just taking them in the returned order, so the
  Introspect phase sees genuinely varied scenarios, not five long turns from one task.

## 2. Run a `Workflow`

This step calls the LIVE Fable model (and whatever model does the synthesis) — real API
spend, unlike the rest of Caliper, which is keyless. Tell the user this before running,
the same way `workflow-lens learn` already flags its own keyed path.

Use the `Workflow` tool with an inline script (not a bundled file — this does real work
against this user's real evidence, unlike the keyless demo fixtures under
`packages/control-tower/workflows/`, which exist only for workflow-lens's own
replay/estimate tooling). Shape it roughly like:

```js
export const meta = {
  name: 'distill-fable-thinking',
  description: 'Fable introspects on its own past excerpts; synthesize a grounded skill.',
  phases: [{ title: 'Introspect' }, { title: 'Synthesize' }],
}

phase('Introspect')
// Batch excerpts (diverse across sessionId/projectSlug, per step 1) into groups of
// ~5-8. Each batch asks Fable to analyze ITS OWN past work and name concrete,
// citable heuristics — not generic advice.
const batches = /* group args.excerpts here */
const introspections = await parallel(batches.map((batch, i) => () =>
  agent(
    `Here are excerpts of YOUR OWN past real work (each tagged with an id):\n${JSON.stringify(batch)}\n` +
    `Analyze your own patterns: how you scoped problems, what you checked before acting, ` +
    `how you communicated, what heuristics drove your decisions. Be concrete. For every ` +
    `heuristic you name, cite the excerpt id it comes from — no citation, no heuristic.`,
    { model: 'claude-fable-5', label: `introspect:${i}`, phase: 'Introspect' },
  )
))

phase('Synthesize')
// One pass on the session's own default model: merge/dedupe, and enforce the
// grounding rule — drop anything that doesn't trace back to a real excerpt id.
const draft = await agent(
  `Merge these introspection outputs into ONE skill draft (SKILL.md body) teaching ` +
  `Opus to approximate this thinking style. DROP any heuristic that doesn't cite a ` +
  `real excerpt id from the input — do not soften or keep it anyway.\n` +
  JSON.stringify(introspections.filter(Boolean)),
  { label: 'synthesize', phase: 'Synthesize' },
)

return { draft, manifest: args.manifest }
```

Pass `args: { excerpts, manifest }` from step 1 into the `Workflow` call.

## 3. Present, then ask consent

Show the user: the manifest (real counts, not estimates), the draft skill body, and
which excerpts/sessions it actually drew from. Ask an explicit yes/no. Only proceed to
step 4 after an explicit yes — identical gate to `/optimize-spend`.

## 4. Write the skill (only on consent)

Write to `~/.claude/skills/fable-thinking/SKILL.md` (a personal skill — not committed
to this plugin's repo). The file must open with a header the user can re-audit later:

```markdown
---
name: fable-thinking
description: Heuristics distilled from claude-fable-5's own past work before it was removed from Claude Code, so Opus can approximate its approach.
---

<!-- Derived {date} from {N} sessions across {M} projects on this machine
     (date range {from}–{to}); {K} excerpts cited. LLM-synthesized interpretation
     of past behavior, not verbatim fact — re-run /distill-fable to refresh. -->
```

## Honesty requirements (non-negotiable)

- Every heuristic must cite a real excerpt id; drop ungrounded ones, never soften them
  into vaguer-but-uncited claims instead.
- State the real sample size (sessions/excerpts scanned and kept) — never imply more
  evidence than `gatherFableEvidence`'s manifest actually reports.
- This step spends real money on live Fable + synthesis model calls — say so before
  running, and let the user decide whether to proceed.
- 100% local except the live model calls themselves, which go through the user's own
  already-authenticated Claude Code session — no new external service, no telemetry.
