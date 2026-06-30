export const meta = {
  name: 'bad-null-return',
  description: 'L5: the agent returns null (user-skip / terminal death after retries). The workflow must handle null without crashing.',
  phases: [{ title: 'Maybe' }],
}

phase('Maybe')
const maybe = await agent('this call is configured to be skipped', { label: 'skipper', model: 'haiku', phase: 'Maybe' })
// null-safe: a correct workflow must not assume a value came back.
const safe = maybe == null ? 'SKIPPED' : maybe
log('result: ' + safe)
return { maybe, safe }
