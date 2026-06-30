export const meta = {
  name: 'fixture-fanout',
  description: 'A phase + a parallel of 4 agents + a 2-stage pipeline, so genuine concurrency is exercised and the wall-clock-vs-sum gap is provable.',
  phases: [
    { title: 'Fan-out' },
    { title: 'Refine' },
  ],
}

// ── Fan-out: 4 agents run concurrently under one parallel() barrier. ──
phase('Fan-out')
const topics = ['oceans', 'mountains', 'deserts', 'forests']
const facts = await parallel(topics.map((t) => () =>
  agent(`In 5 words or fewer, state one fact about ${t}.`, { label: `fact:${t}`, model: 'haiku', phase: 'Fan-out' }),
))
log(`gathered ${facts.filter(Boolean).length} facts`)

// ── Refine: a 2-stage pipeline; each item flows draft -> polish with NO barrier between stages. ──
phase('Refine')
const refined = await pipeline(
  facts.filter(Boolean),
  (fact) => agent(`Rewrite as a tweet (<=12 words): "${fact}"`, { label: 'draft', model: 'haiku', phase: 'Refine' }),
  (draft) => agent(`Add ONE emoji to: "${draft}". Return only the line.`, { label: 'polish', model: 'haiku', phase: 'Refine' }),
)

return { facts, refined: refined.filter(Boolean) }
