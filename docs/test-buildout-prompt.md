# Handoff: build out the Caliper test suite (regression-first)

You are extending the test suite for **Caliper** (repo `Cost-Caliper/caliper`, local
`~/develop/workflow-lens`), a Claude Code spend dashboard. Work in
`packages/control-tower`. Tests are plain `node --test` files under `test/`, run with
`npm test`. No framework — `import { test } from 'node:test'` + `node:assert/strict`.
Fixtures are written to a `mkdtemp` dir and parsed; zero network, zero API keys.

## Why this matters
This is pre-launch software whose headline stat ("you got switched off Fable N times")
goes on Twitter. A real bug already shipped a **wrong launch number** (showed 100, truth
was 104) because the code path that produced it had no test. The parser core is tested;
the aggregation and formatting paths that actually broke are not. Your job is to close
that gap **regression-first**: for each behavior, write a test that FAILS against a
plausible mutation, then confirm it passes against `main`.

## Ground rules (from the repo's engineering standard)
- **Behavior-first.** Write the test, watch it fail (or mutation-prove it), then rely on it.
- **Mutation-prove every regression test.** After writing it, temporarily break the code
  it guards (e.g. revert the specific line) and confirm the test goes red; restore and
  confirm green. A test that passes against the bug is worthless. There is a worked
  example of this in the last commit (`git show` the streamed-refusal test).
- **Use real wire shapes.** Copy transcript structures from actual `~/.claude/projects`
  transcripts, not invented ones. The existing `test/fallbacks.test.mjs` header documents
  the three real signatures (bare refusal, fallback-block switch, sticky turn). Match them.
- **No mocks of the thing under test.** Parse real fixture files through the real
  `parseAgentTranscript` / `summarizeSessionFile` / `aggregateMachine`.
- Keep each test isolated (`mkdtempSync` + `rmSync` in a `finally`). Deterministic only.

## What already exists (don't duplicate)
`test/fallbacks.test.mjs` (8 tests): parseAgentTranscript fallback rollup, usageByModel
split, light-mode carry, costOfParse per-model pricing, fallbacks=null on clean sessions,
event log (prompt+timestamp), and TWO streamed-refusal regression tests. Read this file
first — mirror its fixture helpers (`entry()`, `U0`, `writeFixture()`).

## Coverage gaps to fill (priority order)

### 1. `scanSubagentFallbacks` + `summarizeSessionFile` fallback rollup (HIGHEST — untested, holds the launch number)
`src/sessions.mjs`. This walks a session's `subagents/` tree — BOTH direct
`subagents/agent-*.jsonl` AND the workflow fan-out `subagents/workflows/wf_*/agent-*.jsonl`
— and rolls up into `summary.fallbacks {switches, refusals, sticky, main:{}, sub:{...,wfAgents}, categories}`.
Build a fake session dir on disk (a `<uuid>.jsonl` main transcript + a `<uuid>/subagents/...`
tree with fixture agent transcripts) and assert:
- Switches/refusals in **workflow** subagent transcripts (`subagents/workflows/wf_x/agent-*.jsonl`)
  are counted (this is the exact 71-of-78 case the first cut MISSED — mutation-prove by
  deleting the `wfDir` walk in `collectSubagentTranscripts` and confirming the count drops).
- Direct subagent transcripts (`subagents/agent-*.jsonl`) are also counted.
- `sub.wfAgents` counts only the workflow-dir transcripts.
- `main` vs `sub` split is correct; `mainTotal`/`subTotal` (switches+refusals by location)
  sum to the grand total (this is the "numbers must add up" invariant the banner depends on).
- A session with no subagents dir → `fallbacks` omitted (not present) when main is clean.
- The `FB_SIG_RE` substring pre-check gates the light parse (a transcript with no signature
  is skipped) — assert a signatureless subagent file doesn't get counted or crash.

### 2. `aggregateMachine` machine-wide rollup (untested)
`src/sessions.mjs`. Given a fake projects root with 2–3 session dirs, drive
`aggregateMachine(root, {budgetMs})` to `done` and assert:
- `totals.fallbacks` sums per-session: `subTotal + mainTotal === switches + refusals`.
- `byDay[].fallbacks` and `byRepo[].fallbacks` carry per-bucket switch+refusal counts
  (these drive the ⚠ bar flags).
- `sessionsAffected` counts distinct sessions with ≥1 event.
- `categories` merges across sessions.
- Incremental budget: calling with a tiny `budgetMs` returns `done:false` and resumes;
  the final totals equal a single big-budget run (no double-count across resumes — this
  is a real risk with the `aggState` accumulator; mutation-prove by making a resume
  re-add a session).

### 3. `dominantModel` + `costOfParse` edge cases (`src/observe-cost.mjs`, partially tested)
- `dominantModel` returns the model carrying the most COST (not most tokens) in a mixed
  transcript — a fable-heavy-tokens / opus-heavy-cost split should return opus.
- `costOfParse` with `usageByModel` prices each model at its own rate and equals the sum;
  with a single model equals `costOfUsage`. (One happy-path test exists; add the
  single-model-equivalence and the unknown-model-fallback cases.)

### 4. `fmtUsdShort` formatting (untested, just changed)
Pure function in `public/app.js` — extract-and-test or test via a tiny import shim.
Assert: `<1` → 3 decimals; `1–100` → 2 decimals; `≥100` → whole dollars WITH thousands
separators (`16965 → "$16,965"`, the fix that stops real values looking fake). Guard the
comma specifically — mutation-prove by removing `.toLocaleString`.

### 5. Sticky-turn + switch/refusal-distinctness invariants (partially tested)
Add a property-style test over a synthesized transcript: for any fixture, switches and
refusals never count the SAME requestId twice (the "distinct events, no double-count"
invariant the 104 total relies on). And a sticky turn (fallback_message iteration, no
block) upgrades to a switch if a block later arrives on the same requestId.

## Deliverable
- New/extended test files under `test/` (extend `fallbacks.test.mjs`; add
  `test/sessions-fallbacks.test.mjs` for the sessions.mjs aggregation).
- Every regression test mutation-proven (note the mutation you used in a comment).
- `npm test` green; report the new test count and, for each gap above, the one-line
  mutation that proves the test has teeth.
- Do NOT change production behavior — if a test reveals a real bug, STOP and report it
  (don't silently "fix" the code to make a test pass; the number is launch-critical).

## Run
```
cd ~/develop/workflow-lens/packages/control-tower
npm test                       # full suite
node --test test/fallbacks.test.mjs   # one file
```
