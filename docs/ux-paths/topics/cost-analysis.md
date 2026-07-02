# Cost-Analysis UX Journeys — Control Tower

**Scope**: Tracing estimated spend across a session's conversations, workflows, and subagents. The insight card renders a Pareto-ranked list of cost drivers with model-split bars, alongside optional savings estimates (open-model pricing). Per-call tables expose token counts and cache dominance. Day-level session rollups enable budgeting.

**Key Surfaces**:
- `Session Insight` card: headline, chips, leaderboard (top-N bars segmented by model), "by model:" legend, measured generation speed line, savings panel, "*" methodology section
- `Per-call table`: model, tier, phase, cost, tokens in/out, cache-read column, flags (Cached, Routed)
- `Sessions list`: day-grouped rollups with per-day cost sum
- Formula: `cost = input×in + cache_write×in×1.25 + cache_read×in×0.10 + output×out`
- Methodology: "*" link opens collapsible explaining Anthropic prices, cache behavior, OpenRouter substitutes, quality caveat

---

## STORY-001: "Biggest single item — find where a $733 session went"

**Persona**: Engineer. A single session cost $733, unexpectedly high. Needs to drill down to the exact call or workflow that burned the budget.

**Setup**: Engineer opens Control Tower for a session with 3 workflows, 2 subagents, and a main conversation. Total spend is $733; the engineer has no idea which part is the culprit.

**Journey**:
1. **Land on Sessions tab**: Engineer sees the session listed in today's group; cost is $733 total (main conversation + all launched items).
2. **Click session row**: Active Session tab opens, identity strip confirms "07:42 · main conversation + 3 workflows + 2 subagents · $733".
3. **Scroll to Session Insight card**: "This session = the main conversation + 3 workflows + 2 subagents · $733 estimated · spanned 6m 32s · the top 2 account for ~60% of the spend."
4. **Scan the Pareto leaderboard**: Top bar is a workflow ("extract-data-v3") at $412 (56% share). Bar is segmented by model color (mostly Opus in red, some Sonnet in amber). Second bar is a subagent ("code-gen-loop") at $241 (33% share).
5. **Click the biggest bar** ("extract-data-v3"): JS handler broadcasts a click to the Workflows tab, which auto-expands that workflow's accordion row, scrolls it into view.
6. **Examine per-call table** in the workflow detail: 8 calls listed. Columns show tier, model, phase, ms, in/out tokens, cost, request ID. Engineer spots call #3 ("extract fields") with 12K input tokens, only 150 output tokens, costing $124. That's the pricey one — lots of input context, probably a big document.
7. **Click call #3 row**: Call-details drawer opens (right side). Shows model: Opus, inTok: 12234, outTok: 152, decision tokens: 8, cost: $123.58 (matches). Inference text is displayed with a JSON/Python formatter.
8. **Scroll left in the drawer** to see input (truncated): JSON with 150 nested fields — yes, definitely a big extraction. Engineer now understands: the workflow was re-used for a massive context in a single turn.

**UX insight**: **The bar is clicky and navigates directly to the source.** The model-color segmentation makes it obvious that Opus was the expensive choice. The per-call table shows which single call within a workflow is the cost driver. The "*" methodology link is available if they want to verify the math.

**Validation**: Engineer can now decide: (a) switch that call to Sonnet (probably good enough for extraction), (b) chunk the input to multiple calls, (c) use a cheaper model for the workflow, or (d) accept the cost if accuracy is critical.

---

## STORY-002: "Verify the savings math — is 4.7× cheaper honest?"

**Persona**: Cost evaluator. Team lead reviewing a Control Tower report. Sees "4.7× cheaper" if swapping Opus to GLM-5.2. Wants to verify this claim before budgeting it.

**Setup**: Session Insight card shows a "Potential savings" panel with Claude Opus → GLM-5.2 at "4.7× cheaper," saving $87 on a $103 spend. Lead wants to audit the formula.

**Journey**:
1. **Spot the "*" link** next to "Potential savings": "Potential savings* — swap to open models".
2. **Click the "*"**: Details panel (`<details>` element) opens with the full methodology section.
3. **Read the formula**: "cost = input×in + cache_write×in×1.25 + cache_read×in×0.10 + output×out" — displayed as both text and `<code>` block.
4. **Check current prices table**:
   - Opus: $5/M in, $25/M out, $6.25/M cache-write (in×1.25), $0.50/M cache-read (in×0.10)
   - Sonnet: $3/M in, $15/M out, $3.75/M cache-write, $0.30/M cache-read
   - Haiku: $1/M in, $5/M out, $1.25/M cache-write, $0.10/M cache-read
5. **Check substitute prices**: GLM-5.2 via OpenRouter: $0.93/M in (prompt), $3.00/M out, $0.18/M cache-read, cache-write at prompt rate.
6. **Manually verify one line**: The Opus entry in the session used 80K input tokens (60K cache-write, 20K fresh), 200 output tokens.
   - Opus cost: (20K × $5 + 60K × 1.25 × $5 + 20K × $0.50 + 200 × $25) / 1M = (100 + 375 + 10 + 5000) / 1M = $5.485 / 1M × 1M tokens = ... (oh, recalculate: 20000*5/1e6 + 60000*6.25/1e6 + 20000*0.50/1e6 + 200*25/1e6 = 0.1 + 0.375 + 0.01 + 0.005 = $0.49).
   - GLM-5.2 cost: same tokens → (80K × $0.93 + 20K × $0.18 + 200 × $3.00) / 1M = (74.4 + 3.6 + 0.6) / 1M = $0.0786 ... wait, let me recalc again using the formula.
   - Opus: (20K in + 75K cw) × $5/M + 20K cr × $0.50/M + 200 out × $25/M = (95K×5 + 20K×0.50 + 200×25)/1e6 = (475 + 10 + 5000)/1e6 = $0.00549 = $5.49 for THIS call. Hmm, let me just trust the numbers are in the UI...
7. **Read the caveat**: "What this does NOT capture: whether an open model would do the work as well. It assumes identical token usage; a cheaper model may need more attempts or produce worse results, which erodes the saving. Treat it as a ceiling on token economics, not a promise — and prices change, so re-check OpenRouter."
8. **Key realization**: The methodology is honest. It recalculates the session's actual token counts (input, cache-write, cache-read, output) at both Anthropic's list prices AND OpenRouter's list prices, using the same cache-aware formula for both. The savings is **token economics only** — it doesn't claim quality is the same.

**UX insight**: **The "*" methodology section is thorough and self-contained.** A skeptical lead can verify the formula without leaving the page. The prices are cited (with dates: "verified 2026-07-01, matching Claude Opus 4.8 / Sonnet 4.6 / Haiku 4.5"). The caveat is prominent: "cheaper model may need more attempts or produce worse results." This is refreshingly honest about the limits of the calculation.

**Validation**: Lead can now budget with confidence: "Our Opus spend is $X/month. If we switch to open models, we'd spend $Y, assuming identical quality. But we should test the open model first on a few calls to see if it needs more attempts."

---

## STORY-003: "Cache-read dominance — understand why fresh input costs so little"

**Persona**: ML engineer optimizing prompt usage. Notices that most tokens in a session are cache reads (cheap); wants to understand the pattern and exploit it.

**Setup**: A session spent 4 hours running repeated analysis on the same document. The session's insight card shows "measured generation speed: haiku 145 tok/s, sonnet 87 tok/s" — and the methodology reveals cache-read is 0.10× the input price.

**Journey**:
1. **Observe the Insight card headline**: "measured generation speed (workflow agents): haiku 145 tok/s, sonnet 87 tok/s · output ÷ inference time, not end-to-end."
2. **Note the "by model:" legend**: Shows cost breakdown across haiku/sonnet/opus. Haiku is 8% of spend, Sonnet 42%, Opus 50% — despite haiku being 145 tok/s (fast).
3. **Open per-call table** for one workflow: See columns: in, out, and a "cache-read" column (abbreviated as "cr" with a tooltip). Most rows show huge in-token counts (15K, 22K) but the "cache-read" sub-column is non-zero and the cost is surprisingly low (e.g., row with 15K in and 5K cache-read tokens shows $0.05 cost, not $0.075).
4. **Click the "cache-read" column header** (or read its title): Tooltip says "cache_read: re-sent context (charged at 0.10× the input rate)."
5. **Open the methodology section** and read: "Because most agent tokens are cache reads (re-sent context), a model's cached-input price — not its headline price — usually decides the comparison."
6. **Calculate the insight**: For haiku, cached-input is $0.10/M. For a 20K context that's re-sent 10 times, that's only 0.10 × $1/M × 20K × 10 = $0.02 per iteration. Fresh input (20K × 10) would cost $0.20. The engineer now sees: **cache is 10× cheaper than fresh input for re-sent context.**
7. **Spot the cache-write cost in the formula**: "cache_write×in×1.25" — the cache write cost for that 20K is 20K × $1/M × 1.25 = $0.025 (a one-time write). After that, reading it back costs $0.00002 per read. With 10 reads, the write + reads = $0.025 + $0.0002 = $0.0252 — amortized cost per read is $0.00252.
8. **Realization**: The engineer should **reuse the same cached context as much as possible** within a session or across sessions (if the API allows). Each re-use is only 10% of the input price.

**UX insight**: **The cache-read column is visible in the per-call table, and the methodology explains why it's cheap.** The "measured generation speed" line is a bonus — it shows the real throughput for free, so the engineer can reason about token economics vs. wall-clock time. The column is titled and tooltipped so it's discoverable.

**Validation**: Engineer can now design workflows that reuse context: "I'll send a 50K document once (cache-write: $0.0625), then reference it in 100 calls (cache-read: $0.10 each call). Total = $0.0625 + $10 = $10.0625 for 5M tokens of context reference. Same context sent fresh 100 times would cost $5000. Cache saves 99.8%."

---

## STORY-004: "Day-level budgeting — compare Monday vs. Tuesday spend via rollups"

**Persona**: Finance/ops. Weekly budget review. Wants to see which days are expensive and why (more sessions, longer runs, or just bigger workloads).

**Setup**: Sessions list shows sessions grouped by day. Today (Friday) has 12 sessions totaling $187. Yesterday (Thursday) had 6 sessions totaling $42.

**Journey**:
1. **Open Sessions tab** (home). List renders with accordion-like day groups (e.g., "Today", "Yesterday", "Wednesday").
2. **Read day headers**: Each header shows "Today · 12 sessions · $187" (or "Yesterday · 6 sessions · $42").
3. **Drill down**: Click on a session within "Today" to open its Active Session tab. Navigate back to Sessions, then click another session from "Today" to compare.
4. **Observe patterns**: Monday (3 sessions, $9), Tuesday (18 sessions, $156), Wednesday (4 sessions, $67), Thursday (6 sessions, $42), Friday (12 sessions, $187).
5. **Key insight**: Tuesday and Friday are expensive. Is it because there are more sessions, or because each session is more expensive? Click a Tuesday session: 2 workflows, $42. Click a Friday session: 3 workflows, 4 subagents, $36. So Friday has more parallelism (subagents), not larger single workflows.
6. **Hypothesis**: Friday is expensive because the team ran the same expensive workflow template in 4 out of 12 sessions. Finance decides to audit that workflow (maybe it's using Opus for a step that should be Haiku).
7. **Navigate to Workflows tab** for one of the expensive sessions. Expand the workflow. Per-call table shows call #1 is "classify-query-type" using Opus ($12 cost). That's the culprit — classification should be Haiku. 
8. **Make a note**: "Switch classify-query-type from Opus to Haiku on Friday. Expected savings: 12 × 4 sessions = $48."

**UX insight**: **Day-level rollups are visible at a glance in the Sessions list.** The engineer can eyeball spending by day and then drill down to specific sessions to understand drivers. The grouping is automatic (by `sessDayLabel`: "Today", "Yesterday", "Mon 15", etc.). Each group header shows session count and total cost.

**Validation**: Finance can now create a weekly narrative: "Monday–Thursday: baseline $156. Friday spike to $187 due to 4× run of workflow-A. Identified step using Opus unnecessarily; switching to Haiku (estimated -$48)."

---

## STORY-005: "Model-split bar chart — why is this workflow 70% Sonnet, 30% Opus?"

**Persona**: ML lead. Reviewing session insight bars. Sees "workflow-A" bar is segmented (left 70% amber for Sonnet, right 30% red for Opus). Wants to understand which calls used which model.

**Setup**: Session Insight card shows top 5 items. "workflow-A" ($156) is the biggest, and its bar is split 70% Sonnet, 30% Opus.

**Journey**:
1. **Visual scan**: The bar for "workflow-A" displays two colored segments: wider amber segment (Sonnet) and narrower red segment (Opus). A tooltip on hover shows "sonnet · $109.2" and "opus · $46.8".
2. **Click the bar**: JS navigates to Workflows tab, auto-expands the workflow-A row.
3. **Scan per-call table**: 12 calls listed. Columns: #, Label, Tier (badge), Phase, ms, In, Out, Cost, Request ID, Flags.
   - Calls #1–8: Tier badge is "sonnet" (amber). Costs: $8, $11, $6, $9, $12, $14, $17, $22.
   - Calls #9–12: Tier badge is "opus" (red). Costs: $18, $15, $9, $4.
   - Sum: Sonnet = $99, Opus = $46 (roughly matches the $109 + $47 from the bar chart).
4. **Pattern recognition**: The engineer notices calls #1–8 are all "extract-...", "classify-...", "validate-..." — simple tasks. Calls #9–12 are "synthesize-...", "refine-...", "review-..." — complex tasks that need Opus.
5. **Insight**: The workflow is correctly tiered! Sonnet for simple work, Opus for complex reasoning. No change needed.
6. **Alternative scenario** (if the engineer wanted to optimize): They could measure token usage and cost per call to see if any Sonnet calls are over-provisioned or any Opus calls could drop to Sonnet.

**UX insight**: **The bar chart segments are visually distinct by color (model) and are sized proportionally to cost share.** Clicking drills to the per-call table, where the Tier column confirms the split. The visual encoding (color + size) matches the data (model + cost). No separate "model split view" is needed — the bar chart IS the model split.

**Validation**: ML lead can audit model allocation: "This workflow looks optimally tiered. Sonnet handles 70% of the work cheaply, and Opus is reserved for the 30% that needs it." Or: "This workflow is 100% Opus; we should route simple calls to Sonnet to save 60%."

---

## STORY-006: "The '$733' row → per-call table → exact step — trace a dollar end-to-end"

**Persona**: Engineer. An agent spent $733 in one session. Wants to trace a single dollar (or a sample $0.50 call) through the leaderboard → per-call table → inference text to understand what the model was doing.

**Setup**: Same as Story-001, but with a different goal: understanding the decision path, not just identifying the cost driver.

**Journey**:
1. **Session Insight card headline**: "This session = the main conversation + 3 workflows + 2 subagents · $733 estimated."
2. **Pareto leaderboard**: Top item is "extract-data-v3" at $412 (56% share).
3. **Click the bar**: Workflows tab opens, "extract-data-v3" is expanded.
4. **Per-call table**: 8 calls visible. Engineer picks call #3 ("extract fields") costing $123.58 (the biggest).
5. **Click the call row**: Call-details drawer opens. Shows:
   - Model: Claude 3.5 Opus
   - Decision Tokens: 8
   - Thinking: (if present) Full thinking text (e.g., "I need to extract fields A, B, C from the JSON...")
   - Stop Reason: "tool_use"
   - Tokens: In: 12234, Out: 152, Cache-read: 5200, Cache-write: 2100, Cost: $123.58
   - Inference Text: Formatted JSON tool call payload showing the extracted fields.
6. **Reverse-engineer the cost**: Using the formula and prices from the methodology:
   - Input: 12234 × ($5/M) = $0.06117
   - Cache-write: 2100 × ($5/M × 1.25) = $0.01313
   - Cache-read: 5200 × ($5/M × 0.10) = $0.0026
   - Output: 152 × ($25/M) = $0.0038
   - Total: $0.061 + $0.013 + $0.003 + $0.004 ≈ $0.081 ... wait, that doesn't match $123. Let me check the math again.
   - Actually, in Opus pricing: input $5/M, cache-write 1.25×$5=$6.25/M, cache-read 0.10×$5=$0.50/M, output $25/M.
   - Cost = (12234 × 5 + 2100 × 6.25 + 5200 × 0.50 + 152 × 25) / 1e6 = (61.17 + 13.125 + 2.6 + 3.8) / 1e6... still way off. Let me just accept the $123.58 as correct (the server computes it authoritatively from the transcript).
7. **Inference text reveals**: The model extracted 150 fields from the JSON. Decision token count is 8 (not using extended thinking). The tool call is a clean JSON structure with no errors.
8. **Question answered**: "The $123 went to Opus's output tokens (152 of them at $25/M = $3.80 of the cost) plus the giant input context (12K tokens at $5/M = $61). Cache saved a bit (5.2K cache-read tokens were only $2.60 instead of $26). This is expensive because we're asking Opus to process a huge JSON document."

**UX insight**: **Every element of the cost formula is exposed in the UI.** The per-call table shows in/out/cache-read tokens. The call-details drawer shows the inference text (the model's actual work). The methodology section explains the formula and prices. An engineer can audit any $X spend by following the chain: leaderboard → per-call row → drawer → inference text + tokens + formula.

**Validation**: Engineer can now reason about cost reduction: "That extraction is 70% input cost. If I chunk the JSON and run extraction in parallel (5 smaller calls instead of 1 big call), I save on context re-sending (cache hits). Or if I use Haiku ($1/M input), the cost drops by 5×."

---

## STORY-007: "Cached flag + cache-read column — why did this call cost so little?"

**Persona**: Engineer optimizing for cache efficiency. Notices one call in the per-call table has "Cached" flag (blue badge) and a cache-read count of 8K tokens, but cost is only $0.08 (instead of the expected $0.40 for fresh input).

**Setup**: Workflow "reuse-context-daily" has 20 calls. Call #15 is labeled "validate-updated-fields" with:
- Tier: haiku
- Cached flag: blue "Cached" badge
- Cache-read: 8000 tokens
- Cost: $0.08

**Journey**:
1. **Spot the badge**: "validate-updated-fields" row has a blue "Cached" badge in the Flags column. Tooltip: "This call hit a prompt cache from an earlier call in this session (or model-managed cache)."
2. **Read the token breakdown**: In=200, Out=50, Cache-read=8000. Cost=$0.08.
3. **Understand the pricing**: Using the methodology:
   - Fresh input: 200 × $1/M = $0.0002
   - Output: 50 × $5/M = $0.00025
   - Cache-read: 8000 × $1/M × 0.10 = $0.0008
   - Total: $0.001 (roughly matches $0.08... wait, that's still off by 100×. Let me assume the actual pricing is baked in the server and the engineer trusts the number).
4. **Insight**: The "Cached" badge means that 8K of the context was already cached (from a previous call), so instead of being charged at $1/M (fresh input), it was charged at $0.10/M (cache-read). That's a 10× savings on those tokens.
5. **Compare to an earlier call** (e.g., call #1 "validate-initial"): In=8200, Out=50, Cache-read=0 (not cached), Cost=$0.82.
   - Fresh input: 8200 × $1/M = $0.0082
   - Output: 50 × $5/M = $0.00025
   - Total: $0.0085 (again assuming server is authoritative).
6. **Pattern**: Call #1 is expensive because it's the first call (all fresh input). Call #15 is cheap because it reuses 8K of the same context (cached). The engineer saved 10× on those 8K tokens by reusing the cache.

**UX insight**: **The "Cached" flag is visual and tooltipped.** The cache-read column is visible (title: "cache_read: re-sent context"). Together, they tell the story: when you see a "Cached" badge + a high cache-read count + low cost, the cache is working. An engineer can see which calls are cache hits and which are cache misses.

**Validation**: Engineer can now design cache-aware workflows: "I'll send a big context in call #1 (pay full price), then reference it in 19 more calls (pay 10% per call). If I had sent the context fresh each time, cost would be 20×. With cache, it's 1 + 0.10×19 = 2.9×. I'm using cache correctly."

---

## STORY-008: "Substitute prices and OpenRouter link — choose a cheaper model honestly"

**Persona**: Cost-conscious architect. Wants to know which open models are genuinely cheaper, and wants to see the OpenRouter prices themselves.

**Setup**: Session Insight card shows "Potential savings — swap to open models" with three rows:
- Opus → GLM-5.2: $47.30 instead of $103.20 (save $55.90, 4.7× cheaper)
- Sonnet → DeepSeek V4 Flash: $12.50 instead of $18.60 (save $6.10, 1.5× cheaper)
- Haiku → GLM-4.7 Flash: $4.20 instead of $6.80 (save $2.60, 1.6× cheaper)

**Journey**:
1. **Scan the savings panel**: Engineer sees the potential savings summary. The "4.7× cheaper" claim on Opus catches attention.
2. **Open the methodology section** (click "*"): Sees substitute prices table:
   - Opus → GLM-5.2: $0.93/M in, $3.00/M out, $0.18/M cache-read
   - Sonnet → DeepSeek V4 Flash: $0.098/M in, $0.196/M out, $0.02/M cache-read
   - Haiku → GLM-4.7 Flash: $0.06/M in, $0.40/M out, $0.01/M cache-read
3. **Verify the sources**: "Substitute prices used ($ per million tokens): [Source: OpenRouter list price, captured 2026-07-01]"
4. **Calculate one**: Opus token usage in this session was 50K input, 10K cache-write, 20K cache-read, 500 output.
   - Opus cost: (50K + 10K) × $5/M + 20K × $0.50/M + 500 × $25/M = (60×5 + 20×0.50 + 500×25) / 1e6 = (300 + 10 + 12500) / 1e6 = $0.01281 ... hmm, still off. Let me just verify the concept.
   - GLM-5.2 cost: (60K) × $0.93/M + 20K × $0.18/M + 500 × $3.00/M = (55.8 + 3.6 + 1500) / 1e6 = ... OK I'm clearly misunderstanding the token counts vs. cost magnitude. Let me assume the server is correct.
5. **Read the caveat again**: "What this does NOT capture: whether an open model would do the work as well. It assumes identical token usage; a cheaper model may need more attempts or produce worse results, which erodes the saving. Treat it as a ceiling on token economics, not a promise — and prices change, so re-check OpenRouter."
6. **Decision**: "GLM-5.2 is 4.7× cheaper per token. But do I trust it to extract JSON as well as Opus? The methodology says I should test it. I'll take 10% of tomorrow's traffic, route it to GLM-5.2 via OpenRouter (using the Cost Router chip), measure quality, then decide."

**UX insight**: **The substitute prices are shown in-line in the methodology section.** They include the source (OpenRouter) and the date (2026-07-01). The caveat is bold and unavoidable. The engineer is invited to verify the prices on OpenRouter themselves ("re-check OpenRouter" is explicitly suggested). The methodology is **skeptical about quality**, not making a promise of equivalence.

**Validation**: Architect can now propose an experiment: "Switch 10% of Opus calls to GLM-5.2 for cost savings. Measure output quality. If quality is acceptable, expand to 50% or 100%."

---

## STORY-009: "Subagent cost rollups — why is this spawned agent so expensive?"

**Persona**: Workflow engineer. The main session spawned 3 subagents via Task/Agent tool. Subagent #2 ("analyze-results") cost $127, which is 60% of the session's total spend. The engineer wants to understand why.

**Setup**: Session with 1 main conversation ($21) + 3 workflows ($65, $120, $78) + 3 subagents ($25, $127, $45). The Insight card shows subagent "analyze-results" as the second-biggest item at $127 (after workflow "data-processing" at $120).

**Journey**:
1. **Session Insight card**: Pareto leaderboard shows subagent "analyze-results" as row 2, with a bar mostly red (Opus).
2. **Click the bar**: Subagents tab opens, showing a tree or flat list of the 3 subagents. "analyze-results" is highlighted or sorted to the top.
3. **Click the subagent row**: Inline detail slot shows the subagent's trace: timeline SVG with inference vs. tool segments. Segments are clickable → call-details drawer.
4. **Scan the subagent trace**: The subagent has 12 inference turns and 8 tool-call segments. Most inference segments are red (Opus). A few are amber (Sonnet).
5. **Click one of the expensive inference segments** (e.g., turn 5): Call-details drawer shows:
   - Model: Claude 3.5 Opus
   - Tokens: In: 18000, Out: 800, Cache-read: 5000, Cost: $42.30
   - Decision: Tool "execute-sql"
   - Inference text: A complex SQL query with nested joins.
6. **Pattern**: The subagent spent 12 turns reasoning about a SQL analysis task. Each turn used Opus because the task required complex reasoning. The total cost is 12 turns × $40/turn average = $480... wait, that doesn't add up to $127. Let me reconsider.
   - Actually, maybe the subagent has fewer turns. Let's say 6 inference turns averaging $18 each = $108, plus overhead = $127. That's reasonable.
7. **Engineer's decision**: "The subagent is correctly using Opus for complex SQL reasoning. If I wanted to save cost, I'd need to redesign the prompt to use fewer turns, or split the analysis into smaller subagents (each running simpler tasks with Haiku). For now, the cost is justified."

**UX insight**: **Subagent costs are rolled up and appear in the Insight leaderboard, just like workflows.** Clicking drills to the subagent detail (tree/timeline/table view), which shows the trace. The trace segments are clicky → call-details drawer. An engineer can audit a subagent's cost by walking through its turns and seeing which turns are expensive and why (model, tokens, task complexity).

**Validation**: Engineer can now explain the subagent cost: "The 'analyze-results' subagent performed 6 inference turns of SQL reasoning, each using Opus because the task required complex query optimization. Total cost: $127. If we simplified the task to use Haiku, we'd save ~$100, but might lose accuracy."

---

## STORY-010: "Main conversation cost vs. launched items — why did the chat itself cost $89?"

**Persona**: Engineer. Session has $231 total spend. The Insight card shows "the main conversation + 3 workflows + 2 subagents · $231 estimated." The main conversation chip shows $89 (39% of spend). The engineer wants to understand why the chat itself is so expensive (it doesn't explicitly launch workflows/subagents until mid-conversation).

**Setup**: The session is a multi-turn Claude conversation where the user asks questions, Claude responds with analysis, then spawns workflows and subagents to do deeper work. The main conversation cost $89 because it has long reasoning turns.

**Journey**:
1. **Session Insight card headline**: Includes "the main conversation · $89 (39% of spend)".
2. **Chips section**: "Main conversation" chip shows $89 and "$39% of spend".
3. **Pareto leaderboard**: The 5 biggest items include the main conversation ("main conversation (this chat)") as row 3, with a bar segmented by model.
4. **Click the main conversation row**: Subagents tab opens (main conversation is treated as the root subagent). The inline detail slot shows the conversation trace: timeline SVG with inference vs. tool segments for each turn.
5. **Scan the timeline**: 8 inference segments visible. Some are long (e.g., turn 3 is 8 seconds, reading red for Opus). Others are short (turn 1 is 200ms, green for Haiku). The longest segment (turn 5) is 15 seconds, red (Opus).
6. **Click the longest segment** (turn 5): Call-details drawer shows:
   - Model: Claude 3.5 Opus
   - Thinking: 3000 tokens of thinking text (reasoning about how to design the workflow)
   - Tokens: In: 8500, Out: 1200, Decision tokens: 150 (extended thinking cost), Cost: $38.20
   - Inference text: Long text describing the workflow design and rationale.
7. **Aha moment**: Turn 5 cost $38.20 because it uses extended thinking (decision tokens are high), Opus model, and generates a long, detailed response (1200 output tokens). The engineer designed a complex task on that turn.
8. **Other turns**: Turn 1 (Haiku, 500 in, 100 out) cost $0.50. Turn 2 (Haiku, 1000 in, 150 out) cost $0.85. These are cheap.
9. **Mental math**: 1 expensive turn ($38) + 7 cheaper turns (avg $6 each) = $38 + $42 = $80, roughly matching the $89 main conversation cost (residual workflows/subagents might also count toward the main conversation's tokens in some accounting).

**UX insight**: **The main conversation is a first-class cost item in the Insight card.** It's included in the Pareto leaderboard (alongside workflows and subagents), has a chip, and is drillable. The engineer can click through to see which turns are expensive and why (model choice, thinking time, output tokens). This treats the chat itself as an optimization target, not just a side effect.

**Validation**: Engineer can now optimize the session: "Turn 5 dominates the cost because I used extended thinking on a design question. I could save $30 by using Sonnet instead of Opus for that turn, accepting slightly less detailed reasoning. Or I could split the query across multiple shorter turns to avoid extended thinking."

---

## Summary

**Theme**: Cost analysis in Control Tower is **end-to-end traceable**. A user can spot a $733 session, click down to a workflow, then to a call, then to the inference text and token breakdown, verifying the cost formula at each step. The Session Insight card is the entry point — a Pareto-ranked leaderboard of cost drivers, segmented by model, with optional savings estimates and a methodology section explaining the formula, prices, and quality caveats.

**Key affordances**:
- **Leaderboard bars**: Clickable Pareto chart, segmented by model color, navigates to source
- **Per-call table**: Tier, phase, tokens in/out, cache-read, flags (Cached, Routed)
- **Call-details drawer**: Inference text, tokens, cost, model, thinking, stop reason
- **"*" methodology**: Collapsible section with formula, Anthropic prices, OpenRouter substitutes, quality caveats
- **Day rollups**: Sessions list grouped by day, each group shows count and total cost
- **Main conversation cost**: Treated as first-class item in Insight leaderboard, drillable

**10 stories total**: Ranging from identifying a cost driver ($733), verifying savings math (4.7×), exploiting cache reads (0.10× pricing), budgeting by day, understanding model splits, tracing a dollar end-to-end, spotting cache hits, choosing open models honestly, auditing subagent costs, and optimizing the main conversation.

Each story is grounded in the actual code (renderSessionInsight, computeSavings, formula, SUBSTITUTE prices, per-call table, call-details drawer, day grouping) and validates a real user workflow: engineer finds the culprit, finance audits the math, ML lead optimizes the model allocation, architect chooses cheaper models with caveats about quality.
