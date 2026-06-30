// test/segments.test.mjs — unit tests for buildSegments(): partition an agent's
// transcript events into inference vs tool-execution spans. Pure + keyless.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildSegments } from '../src/observer.mjs'

// Project just the structural fields (segments also carry a `detail` payload).
const structural = (segments) => segments.map(({ kind, startMs, endMs, tools }) => ({ kind, startMs, endMs, tools }))

// A typical agentic loop: prompt -> infer -> tool_use(infer) -> tool runs -> infer.
test('buildSegments: classifies inference vs tool and merges adjacent spans', () => {
  const events = [
    { tsMs: 0, type: 'prompt' },        // agent receives the prompt
    { tsMs: 1000, type: 'assistant' },  // 1000ms inference (text)
    { tsMs: 1200, type: 'assistant' },  // +200ms inference (emits tool_use) -> merges
    { tsMs: 5000, type: 'tool_result' },// 3800ms tool execution
    { tsMs: 6000, type: 'assistant' },  // 1000ms inference
  ]
  const { segments, inferenceMs, toolMs } = buildSegments(events)

  assert.deepEqual(structural(segments), [
    { kind: 'inference', startMs: 0, endMs: 1200, tools: [] },
    { kind: 'tool', startMs: 1200, endMs: 5000, tools: [] },
    { kind: 'inference', startMs: 5000, endMs: 6000, tools: [] },
  ])
  assert.equal(inferenceMs, 2200) // 1200 + 1000
  assert.equal(toolMs, 3800)
})

test('buildSegments: tool spans are labelled with the requesting turn\'s tool names', () => {
  const events = [
    { tsMs: 0, type: 'prompt' },
    { tsMs: 1000, type: 'assistant', tools: ['Bash', 'Grep'] }, // requests two tools
    { tsMs: 4000, type: 'tool_result' },
    { tsMs: 4100, type: 'tool_result' },                         // parallel -> merges, same labels
    { tsMs: 5000, type: 'assistant', tools: [] },                // inference, no tools
  ]
  const { segments } = buildSegments(events)
  assert.deepEqual(structural(segments), [
    { kind: 'inference', startMs: 0, endMs: 1000, tools: [] },
    { kind: 'tool', startMs: 1000, endMs: 4100, tools: ['Bash', 'Grep'] },
    { kind: 'inference', startMs: 4100, endMs: 5000, tools: [] },
  ])
})

test('buildSegments: parallel tool_results stay one merged tool span', () => {
  const events = [
    { tsMs: 0, type: 'prompt' },
    { tsMs: 500, type: 'assistant' },     // infer 500
    { tsMs: 2000, type: 'tool_result' },  // tool 1500
    { tsMs: 2100, type: 'tool_result' },  // tool +100 (parallel) -> merges
    { tsMs: 3000, type: 'assistant' },    // infer 900
  ]
  const { segments, inferenceMs, toolMs } = buildSegments(events)
  assert.deepEqual(structural(segments), [
    { kind: 'inference', startMs: 0, endMs: 500, tools: [] },
    { kind: 'tool', startMs: 500, endMs: 2100, tools: [] },
    { kind: 'inference', startMs: 2100, endMs: 3000, tools: [] },
  ])
  assert.equal(inferenceMs, 1400)
  assert.equal(toolMs, 1600)
})

test('buildSegments: captures per-segment detail (tool input+result paired by id, inference text)', () => {
  const events = [
    { tsMs: 0, type: 'prompt' },
    { tsMs: 1000, type: 'assistant', text: 'Let me check the files.', tools: ['Bash'], toolUses: [{ id: 'tu1', name: 'Bash', input: 'ls -la' }], usage: { output_tokens: 42, input_tokens: 5, cache_read_input_tokens: 1000 }, stopReason: 'tool_use', model: 'claude-sonnet-4-6' },
    { tsMs: 3000, type: 'tool_result', results: [{ id: 'tu1', content: 'file1\nfile2', isError: false, len: 11 }] },
    { tsMs: 4000, type: 'assistant', text: 'Two files found.', tools: [], toolUses: [], usage: { output_tokens: 8 }, stopReason: 'end_turn', model: 'claude-sonnet-4-6' },
  ]
  const { segments } = buildSegments(events)

  assert.equal(segments[0].kind, 'inference')
  assert.equal(segments[0].detail.text, 'Let me check the files.')
  assert.deepEqual(segments[0].detail.decided, ['Bash'])
  // per-step inference metadata
  assert.equal(segments[0].detail.outTok, 42)
  assert.equal(segments[0].detail.cacheReadTok, 1000)
  assert.equal(segments[0].detail.stopReason, 'tool_use')
  assert.equal(segments[0].detail.model, 'claude-sonnet-4-6')
  assert.equal(typeof segments[0].detail.costUsd, 'number')

  assert.equal(segments[1].kind, 'tool')
  assert.deepEqual(segments[1].detail.calls, [{ name: 'Bash', input: 'ls -la', result: 'file1\nfile2', isError: false, resultLen: 11 }])

  assert.equal(segments[2].kind, 'inference')
  assert.equal(segments[2].detail.text, 'Two files found.')
  assert.equal(segments[2].detail.outTok, 8)
  assert.equal(segments[2].detail.stopReason, 'end_turn')
})

test('buildSegments: fewer than two events yields no segments', () => {
  assert.deepEqual(buildSegments([]), { segments: [], inferenceMs: 0, toolMs: 0 })
  assert.deepEqual(buildSegments([{ tsMs: 0, type: 'prompt' }]), { segments: [], inferenceMs: 0, toolMs: 0 })
})
