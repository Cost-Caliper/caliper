// editor.test.mjs — node:test suite for extractEditableAgents + applyEdits
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import * as lens from '../../workflow-lens/src/index.mjs'
import { extractEditableAgents, applyEdits } from '../src/editor.mjs'

// meta is a pure literal so lens.lint passes.
// Agent 0: Literal prompt, explicit model 'haiku'
// Agent 1: TemplateLiteral with expression (dynamic)
// Agent 2: Literal prompt, no model prop
const FIXTURE = `export const meta = { name: 'edit-fixture', description: 'editor test fixture' }
phase('Work')
const a = await agent('Reply with ok', { label: 'greeter', model: 'haiku' })
const b = await agent(\`Summarize: \${a}\`, { label: 'dyn', model: 'sonnet' })
const c = await agent('Static no-model prompt', { label: 'nomodel' })
return { a, b, c }
`

describe('extractEditableAgents', () => {
  it('returns 3 agents and correct modelOptions', () => {
    const { agents, modelOptions } = extractEditableAgents(FIXTURE)
    assert.equal(agents.length, 3)
    assert.deepEqual(modelOptions, ['haiku', 'sonnet', 'opus', 'fable'])
  })

  it('agent 0 has promptEditable === true and model "haiku"', () => {
    const { agents } = extractEditableAgents(FIXTURE)
    assert.equal(agents[0].promptEditable, true)
    assert.equal(agents[0].model, 'haiku')
    assert.equal(agents[0].modelExplicit, true)
  })

  it('agent 1 (dynamic template) has promptEditable === false', () => {
    const { agents } = extractEditableAgents(FIXTURE)
    assert.equal(agents[1].promptEditable, false)
  })

  it('agent 2 has promptEditable === true and modelExplicit === false', () => {
    const { agents } = extractEditableAgents(FIXTURE)
    assert.equal(agents[2].promptEditable, true)
    assert.equal(agents[2].modelExplicit, false)
  })
})

describe('applyEdits', () => {
  it('replaces prompt and model for agent 0', () => {
    const edited = applyEdits(FIXTURE, [{ index: 0, model: 'opus', prompt: 'Reply with yes' }])
    // Must re-parse cleanly
    assert.doesNotThrow(() => lens.parseSource(edited))
    // Must lint OK
    const lintRes = lens.lint(edited)
    assert.equal(lintRes.ok, true, 'lint failed: ' + JSON.stringify(lintRes.findings))
    // Model must be readable from graph
    const graph = lens.buildGraph(edited)
    assert.equal(graph.agentNodes[0].model, 'opus')
    // Prompt replacement uses JSON.stringify (double quotes)
    assert(edited.includes('"Reply with yes"'), 'edited source should contain "Reply with yes"')
  })

  it('inserts model into hasOpts && !modelExplicit path for agent 2', () => {
    const edited = applyEdits(FIXTURE, [{ index: 2, model: 'haiku' }])
    assert.doesNotThrow(() => lens.parseSource(edited))
    const lintRes = lens.lint(edited)
    assert.equal(lintRes.ok, true, 'lint failed: ' + JSON.stringify(lintRes.findings))
    const graph = lens.buildGraph(edited)
    assert.equal(graph.agentNodes[2].model, 'haiku')
    assert(edited.includes('model: "haiku"'), 'edited source should contain model: "haiku"')
  })

  it('returns byte-identical source for empty edits', () => {
    const result = applyEdits(FIXTURE, [])
    assert.strictEqual(result, FIXTURE)
  })

  it('no-ops a prompt edit on a dynamic (non-editable) agent', () => {
    const result = applyEdits(FIXTURE, [{ index: 1, prompt: 'attempted dynamic rewrite' }])
    assert.strictEqual(result, FIXTURE)
    assert.doesNotThrow(() => lens.parseSource(result))
  })

  it('throws EDIT_INVALID for an unknown model', () => {
    assert.throws(
      () => applyEdits(FIXTURE, [{ index: 0, model: 'gpt-4' }]),
      (e) => e.code === 'EDIT_INVALID'
    )
  })
})
