export const meta = {
  name: 'fixture-hello',
  description: 'Minimal single-agent workflow: the smallest real run the toolkit can capture.',
  phases: [{ title: 'Greet' }],
}

phase('Greet')
const reply = await agent('Reply with the single lowercase word: ok', { label: 'greeter', model: 'haiku' })
log('agent replied: ' + reply)
return { reply }
