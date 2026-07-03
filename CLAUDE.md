# CLAUDE.md — Caliper

Read `AGENTS.md` first — it is the canonical engineering standard for this
repo. The hard rules are repeated here because they are mandatory, not
advisory. If this file and `AGENTS.md` disagree, `AGENTS.md` wins.

## Project layout

- `packages/workflow-lens` — the library (instrumentation, replay, estimate,
  governor, router). Own test suite.
- `packages/control-tower` — the Caliper dashboard (`server.mjs`, `src/*.mjs`,
  browser UI in `public/app.js`). Own test suite. Depends on workflow-lens via
  relative imports.

## Strict testing regime — enforced

1. **TDD is required, not suggested.** New behavior: failing test first (red),
   then implementation (green). Bug fix: a regression test that reproduces the
   bug and fails against the broken code BEFORE the fix. Refactor: relevant
   suite green before and after. Do not write production code for which no
   test exists or is being written in the same task.
2. **Mutation-prove regression tests.** Temporarily break the guarded code,
   confirm the test goes red, restore, confirm green. Note the mutation in a
   comment near the test. A test never seen red proves nothing.
3. **Real wire shapes.** Fixture JSONL copies real transcript structure (see
   `packages/control-tower/test/fallbacks.test.mjs` header). Never commit real
   user transcripts — this repo is public; synthesize structure-faithful
   fixtures instead.
4. **No mocks of the thing under test.** Real parsers on real fixture files,
   real HTTP against a real spawned server. Stubs only at true process
   boundaries.
5. **Hermetic + deterministic.** `mkdtemp` fixtures cleaned in `finally`; zero
   network; zero API keys; no `Math.random`; no locale-pinned assertions.
   Tests touching `src/sessions.mjs` (even transitively, e.g. spawning the
   server) must sandbox HOME — `import './_env.mjs'` FIRST — or they will
   write into the user's real `~/.cache/workflow-lens/`.
6. **No secrets in code — ever.** Never hardcode a real credential (API key,
   token, password) in tests, fixtures, source, or docs — this repo is public.
   Tests are keyless by design; a test that exercises credential plumbing uses
   obviously-fake synthetic values (e.g. `'sk-ant-abc'`) passed as explicit
   env objects, never anything real. Real credentials live only in environment
   variables loaded from git-ignored `.env` files (`.env` / `.env.*` are
   ignored at the repo root) — never committed, never echoed into logs,
   fixtures, or assertion messages.
7. **Launch-number honesty.** A test that exposes a production bug means STOP
   and report with evidence. Never adjust production numbers or soften a test
   to get to green. Report real test output — actual counts, actual failures.
8. **Done means green.** `npm test` in BOTH packages before claiming any task
   complete. The 11 observer tests that skip without `WFLENS_TEST_SESSION_DIR`
   are env-gated by design; any OTHER skip or failure is your problem to
   resolve or report.

## Commands

```
cd packages/control-tower && npm test        # dashboard suite
cd packages/workflow-lens && npm test        # library suite
node --test test/<file>.test.mjs             # one file (from the package dir)
cd packages/control-tower && npm start       # run the dashboard (loopback-only)
```

## Claude-specific notes

- Commit trail should make TDD auditable: prefer a tests commit (red noted in
  the message) followed by the implementation commit (green), or a single
  commit whose message records the red → green evidence and the mutation used
  to prove each regression test.
- When a task says a number is launch-critical, treat the test's expected
  value as immutable input: derive it from fixtures/real data, never from the
  code under test.
- `docs/test-buildout-prompt.md` records the coverage plan that seeded this
  suite; keep its ground rules in sync with `AGENTS.md` if either changes.
