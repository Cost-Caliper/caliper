# Engineering standard — Caliper

This file is the canonical testing and TDD standard for every agent (and human)
working in this repo. `CLAUDE.md` mirrors the hard rules and adds
Claude-Code-specific notes; if the two ever disagree, this file wins.

Caliper is pre-launch software whose headline numbers (spend totals, the
"switched off Fable N times" stat) get published. A wrong number already
shipped once (showed 100, truth was 104) because the code path that produced it
had no test. The rules below exist so that never happens again.

## The testing regime (non-negotiable)

### 1. TDD — test first, always

- **New behavior**: write the failing test BEFORE the implementation. Watch it
  fail for the right reason (red), implement (green), then commit. The red →
  green order must be visible in your process; when practical, keep it visible
  in the commit trail.
- **Bug fix**: regression-first. Reproduce the bug in a test that FAILS against
  the broken code before you touch the fix. A fix without a failing-first test
  is not done.
- **Refactor**: no new tests required, but the relevant suite must pass before
  AND after, and you must run it both times.

### 2. Mutation-proof every regression test

After writing a test that guards a specific behavior, temporarily break the
code it guards (revert the fix, delete the branch, invert the comparison), run
the test, and confirm it goes RED with a meaningful message. Restore exactly
and confirm green. Record the mutation you used in a comment near the test.
A test that passes against the bug it claims to guard is worse than no test —
it certifies broken code. `git log` has worked examples (see the
streamed-refusal regression tests in `packages/control-tower/test/fallbacks.test.mjs`).

### 3. Real wire shapes only

Transcript/JSONL fixtures must copy structures from real Claude Code
transcripts, not invented ones. The header of
`packages/control-tower/test/fallbacks.test.mjs` documents the three real
fallback signatures (bare refusal, fallback-block switch, sticky turn) — match
them. Never commit real user transcripts as fixtures (privacy: this repo is
public); synthesize files that copy the real structure with synthetic content.

### 4. No mocks of the thing under test

Parse real fixture files through the real parser. Drive real HTTP routes
against a real spawned server. Minimal stubs are allowed only at true process
boundaries (a fake `res` object for an SSE channel, a captured event
collector). If you find yourself mocking the module you are testing, stop.

### 5. Hermetic and deterministic

- Every fixture lives in `mkdtempSync(join(tmpdir(), ...))` and is removed in a
  `finally { rmSync(dir, { recursive: true, force: true }) }`.
- Any test that touches `packages/control-tower/src/sessions.mjs` (directly or
  transitively — including spawning the server) must sandbox HOME:
  `import './_env.mjs'` as the FIRST import (the summary disk cache writes to
  `~/.cache/workflow-lens/` otherwise), or set a temp HOME in the child env.
- Zero network, zero API keys. Tests that need live credentials or
  machine-local sessions must be explicitly env-gated (`WFLENS_TEST_SESSION_DIR`
  pattern) and skip VISIBLY via `t.skip('<reason>')` — never a silent `return`
  that hides an outage as green.
- Deterministic only: no `Math.random`, no assertions pinned to locale/TZ
  output (test locale-dependent helpers on their deterministic branches or with
  shape regexes).

### 6. No secrets in code, no secrets in git

Never hardcode a real credential — API key, token, password, webhook secret —
anywhere in the repo: not in tests, not in fixtures, not in source, not in
docs or commit messages. This repo is public. The rules that follow from this:

- Tests are keyless by design (rule 5). A test that exercises credential
  plumbing (e.g. `requireKey`) uses obviously-fake synthetic values like
  `'sk-ant-abc'`, passed as an explicit env object — never a value that works
  anywhere.
- Anything that genuinely needs a real credential at runtime reads it from an
  environment variable and fails closed (412 / visible skip) when absent.
- Real values live only in git-ignored `.env` files (`.env` / `.env.*` are
  ignored at the repo root) or the shell environment — never committed. Before
  committing, check the diff for anything that looks like a live key.
- Never echo a real credential into logs, fixtures, assertion messages, or
  test output.

### 7. Launch-number honesty

If a test reveals a real production bug, STOP: report it with evidence. Do not
silently "fix" production code to make a test pass, and never soften a test to
make broken code pass. Headline numbers are launch-critical; a plausible-but-
wrong number is the worst outcome this repo can produce.

### 8. Definition of done

Work is not done until:

- `cd packages/control-tower && npm test` is green (env-gated observer tests
  skip by design on machines without the fixture session; everything else
  passes).
- `cd packages/workflow-lens && npm test` is green.
- Every new behavior and every fixed bug has a test that would fail without
  the change (see rule 2).
- Test results are reported faithfully — actual counts, actual failures, no
  "should pass".

## Running tests

```
cd packages/control-tower && npm test        # full dashboard suite
node --test test/<one-file>.test.mjs         # a single file
cd packages/workflow-lens && npm test        # library suite
```

Tests are plain `node --test` files under each package's `test/` —
`import { test } from 'node:test'` + `node:assert/strict`. No framework, no
test dependencies. Node ≥ 20. `node --test` runs each file in its own process,
so per-file env overrides (like `test/_env.mjs`) are safe.

## Conventions

- Test files: `test/<area>.test.mjs`, one file per behavioral area; file-header
  comment states scope and, for fixture-based files, where the wire shapes came
  from.
- Regression tests carry a `REGRESSION:` prefix in the test name and a comment
  describing the original bug and the mutation used to prove the test.
- Prefer exact assertions (`assert.equal(x, 104)`) over loose ones
  (`assert.ok(x > 0)`) wherever the fixture makes the exact value knowable.
- Keep production code out of test commits where practical: tests-first commit,
  then the implementation commit that turns them green.
