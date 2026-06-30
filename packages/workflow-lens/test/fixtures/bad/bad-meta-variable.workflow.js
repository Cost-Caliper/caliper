const DESC = 'built from a variable'

export const meta = {
  name: 'bad-meta-variable',
  // VIOLATION: meta must be a PURE literal. This value is an identifier reference,
  // which makes meta non-static and resume-unsafe — the lint must flag it.
  description: DESC,
  phases: [{ title: 'Go' }],
}

phase('Go')
const reply = await agent('say ok', { label: 'go', model: 'haiku' })
return { reply }
