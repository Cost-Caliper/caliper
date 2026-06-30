export const meta = {
  name: 'over-budget-demo',
  description: 'Fires many haiku calls to deterministically trip the budget governor. Set a tiny cap (e.g. $0.00001) to see the red OVER BUDGET banner with no real spend.',
  phases: [
    { title: 'Spend' },
  ],
}

// ── Spend: fires several agents so a tight cap is reached quickly ──
phase('Spend')
const items = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig']
const results = await parallel(items.map((fruit) => () =>
  agent(`One word: is ${fruit} sweet? yes/no`, { label: `check:${fruit}`, model: 'haiku', phase: 'Spend' }),
))
log(`completed: ${results.filter(Boolean).length}/${items.length}`)
return { results }
