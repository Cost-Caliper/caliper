# STORY-060 — Savings methodology ("*") audit

**Verdict: PASS**

**Persona**: Skeptical finance lead auditing the "Potential savings" claim before trusting it in a budget.

**Session used**: `~/develop/agent-university` → "Feed: call this agent 'Agent University'…" (rich session: main conversation + 15 workflows + 3 subagents, $265 total est.)

## Walk

1. Opened http://localhost:8787, selected the rich session from the Sessions tab. Active Session tab loaded the Session Insight card automatically.
2. Insight card headline: "This session = the main conversation + **15 workflows** + **3 subagents** · **$265 estimated** · spanned 1d 4h · the top **3** account for ~60% of the spend." Stat tiles: MAIN CONVERSATION $97.64 (37%), WORKFLOWS $157 (59%), SUBAGENTS $10.22 (4%), BIGGEST SINGLE $97.64, POTENTIAL SAVINGS $201 (76% of Claude-tier spend).
3. "WHERE THE ESTIMATED COST WENT — by model" legend: opus $240 (91%), sonnet $20.54 (8%), haiku $3.62 (1%). No fable tier present (consistent with the caveat that fable only appears if fable usage exists — this session has none).
4. Scrolled to "POTENTIAL SAVINGS * — SWAP TO OPEN MODELS · OpenRouter list price · 2026-07-01" panel: three rows (opus→GLM-5.2 $240→$62.56 save $178, 3.8× cheaper; sonnet→DeepSeek V4 Flash $20.54→$0.841 save $19.70, 24× cheaper; haiku→GLM-4.7 Flash $3.62→$0.252 save $3.37, 14× cheaper), plus a rollup line "≈ $63.66 instead of $265 on these tiers — save $201 (76%, 4.2× cheaper)".
5. Clicked the "*" (native `<details>`/`<summary>`, confirmed via DOM: `tagName=DETAILS`, `open=true` after click, `summary` text = `* How "potential savings" is calculated & where the prices come from`). Expanded cleanly, no console errors.
6. Read the methodology in full:
   - **Formula** (as `<code>` block): `cost = input×in + cache_write_5m×in×1.25 + cache_write_1h×in×2.0 + cache_read×in×0.10 + output×out` — matches the current (updated) formula spec exactly, including the new 5-minute/1-hour cache-write split.
   - **Current model prices** ("Anthropic list, $ per million tokens — verified against OpenRouter 2026-07-01, matching Claude Opus 4.8 / Sonnet 4.6 / Haiku 4.5"): opus $5/M in, $25/M out, $6.25/M cache-write(5m)/$12.50(1h — shown as ×2.0), $0.50/M cache-read; sonnet $3/$15/$3.75/$0.30; haiku $1/$5/$1.25/$0.10. All three tiers present and consistent with the formula.
   - **Substitute prices used**, each tagged with an explicit OpenRouter model id: opus→GLM-5.2 (`z-ai/glm-5.2`) $0.93/M in, $3/M out, $0.18/M cache-read, cache-write at in rate; sonnet→DeepSeek V4 Flash (`deepseek/deepseek-v4-flash`) $0.098/$0.196/$0.02; haiku→GLM-4.7 Flash (`z-ai/glm-4.7-flash`) $0.06/$0.4/$0.01.
   - **"What this does NOT capture"** — bold heading with an orange left-border callout: "whether an open model would do the work as well. It assumes identical token usage; a cheaper model may need more attempts or produce worse results, which erodes the saving. Treat it as a ceiling on token economics, not a promise — and prices change, so re-check OpenRouter." Prominent, unmissable, appropriately hedged.
7. Verified the as-of date renders and is current: "OpenRouter list price · 2026-07-01" and "captured 2026-07-01" both match today's date (2026-07-01) — not stale.

## Reproducibility check (skeptical-lead math)

Recomputed the aggregate savings claim from the on-page numbers only:
- Sum of "before" column: $240 + $20.54 + $3.62 = $264.16 (displayed rollup: "$265" — rounds correctly with the "$265 estimated" headline figure).
- Sum of "after" column: $62.56 + $0.841 + $0.252 = $63.653 (displayed: "$63.66" — matches).
- Savings: $264.16 − $63.653 = $200.507 → displayed "$201" ✓; 200.507/264.16 = 75.9% → displayed "76%" ✓; 264.16/63.653 = 4.15× → displayed "4.2×" ✓.
- Per-tier multiples also check out: opus 240/62.56 = 3.84× (displayed 3.8×), sonnet 20.54/0.841 = 24.4× (displayed 24×), haiku 3.62/0.252 = 14.4× (displayed 14×).

**Conclusion: yes, a skeptical lead CAN reproduce the aggregate math shown** (sums, percentages, multiples all check out to rounding). The one thing that is *not* independently reproducible from the page alone is each tier's underlying token counts (input/cache-write/cache-read/output) that feed the $240/$20.54/$3.62 "before" figures — those come from the raw transcript, not shown in the methodology panel. This is an inherent, disclosed limitation (the panel explains the *formula and prices*, not a full per-tier token ledger) and did not read as an overclaim — the copy never asserts you can rebuild the per-tier dollar figures from the panel alone, only that the *calculation method* is transparent. I separately reproduced a single per-call cost figure to $0.001 precision using this exact formula during the STORY-064 walk (see that report), which independently corroborates the formula is real and not decorative.

## Findings

No high/critical findings. Two low-severity/suggestion items:

1. **[low]** The "*" affordance appears twice with slightly different semantics: a small blue superscript dot next to "POTENTIAL SAVINGS" (stat tile) and the actual clickable `*` link/summary text before "SWAP TO OPEN MODELS". A first-time skeptical reader might try clicking the stat-tile dot expecting it to expand the methodology (it doesn't appear to be interactive — only the lower "* How... is calculated" summary is). Minor discoverability friction, not a blocker.
2. **[suggestion]** The methodology's "Current model prices" section states the cache-write price textually as "in×1.25 for 5-min cache, ×2.0 for 1-hour" — this reads slightly awkwardly (it's "in×1.25" then a separate "×2.0" that isn't clearly "in×2.0" by symmetry). A finance-lead skimmer could misread the 1-hour multiplier as relative to the 5-minute price rather than to `in`. Suggest rephrasing to "in×1.25 (5-min cache) / in×2.0 (1-hour cache)" for parallel clarity.

## Screenshots

- `screenshots/01-insight-card.png` — savings panel + collapsed "*" summary
- `screenshots/02-insight-headline.png` — full insight card headline, stat tiles, by-model legend, leaderboard, savings panel (collapsed)
- `screenshots/03-methodology-expanded.png` — methodology expanded: formula, current prices, substitute prices (top half)
- `screenshots/04-methodology-scrolled.png` — methodology expanded: substitute prices (full) + "what this does NOT capture" caveat
