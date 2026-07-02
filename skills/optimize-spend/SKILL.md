---
name: optimize-spend
description: Analyze this machine's real Claude Code spend (from the Caliper dashboard data) and produce grounded cost-optimization recommendations — then, with consent, write a personalized cost-discipline skill. Use when the user asks to "optimize my spend", "make Claude cheaper", "analyze my usage costs", "where is my money going", or invokes /optimize-spend.
---

# Optimize Spend

Turn the user's real usage data into durable cost discipline. Everything you conclude must be grounded in their actual numbers — no generic advice, no invented figures.

## 1. Get the data

The Caliper dashboard (this plugin) reconstructs spend from `~/.claude/projects` transcripts. Prefer its API:

1. Find a running server: try `curl -s http://localhost:8787/v1/health`; if that fails, check other ports the launcher may have picked, or start one with this plugin's `scripts/launch-control-tower.mjs` (it prints the URL).
2. Pull, in order of value:
   - `GET /v1/aggregate` — machine-wide totals, by-day / by-repo / by-tier (poll until `done: true`; the first scan is incremental).
   - `GET /v1/sessions/all` — every session with per-session cost, model tier, wf/sub counts.
   - `GET /v1/observed` + `GET /v1/observed/:id` — workflow runs with per-call tier/cost/cache telemetry (for the currently selected session).
3. If no server can run, say so and analyze what the user pastes instead.

## 2. Analyze — find the levers

Ground each finding in a number you actually fetched. Look for:

- **Tier-task mismatch**: expensive tiers (fable/opus) doing mechanical work (repo exploration, file reads, formatting). Compare per-repo and per-session tier splits.
- **Delegation gaps**: sessions where the main conversation dominates cost — work that could have gone to cheaper subagents/workflow agents with isolated context.
- **Workflow model mix**: runs where every `agent()` call used the default tier; planning/review can justify opus, implementation usually shouldn't.
- **Cache economics**: cache reads are ~10× cheaper than fresh input, and 1-hour cache writes cost 2× the 5-minute rate. Reward stable system prompts/context; flag patterns that churn the cache.
- **Repeat spend**: the same repo/task shape recurring daily (visible in by-day/by-repo) — candidates for a skill, a workflow, or cached artifacts instead of re-derivation.

## 3. Recommend, then offer the skill

1. Present the 3–5 biggest levers with the evidence and an *estimated* impact each.
2. **Ask** whether to write a personalized skill at `~/.claude/skills/cost-discipline/SKILL.md` capturing the durable rules (e.g. "delegate repo exploration to haiku subagents", "use `opus for planning, sonnet for implementation` in workflow specs", "keep CLAUDE.md stable to protect the cache ratio"). Only write it after a yes.
3. The generated skill must cite the data snapshot (date + headline numbers) it was derived from, so it can be re-audited later.

## Honesty requirements (non-negotiable)

- Every dollar figure is a cache-aware **estimate** reconstructed from transcripts, not a billed amount — label them as such.
- State sample sizes; never turn one expensive session into a universal rule.
- Cheaper models can need more attempts: present substitutions as token-economics ceilings, not promised savings.
