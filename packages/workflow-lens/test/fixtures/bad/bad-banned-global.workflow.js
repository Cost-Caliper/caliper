export const meta = {
  name: 'bad-banned-global',
  description: 'L5: calls a BANNED non-deterministic global (Date.now) in the body — the lint must flag it and a resume-safe runtime must throw.',
  phases: [{ title: 'Run' }],
}

phase('Run')
// VIOLATION: Date.now() is resume-unsafe and banned inside a workflow body.
const stamp = Date.now()
const reply = await agent('say ok at ' + stamp, { label: 'stamped', model: 'haiku' })
return { reply, stamp }
