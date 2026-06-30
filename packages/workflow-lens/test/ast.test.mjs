// test/ast.test.mjs — keyless static-analysis tests (buildGraph + lint).
// Ported from capstone test-capstone.mjs steps 2/3 and L5 fixture checks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIX = join(__dirname, 'fixtures')

import { buildGraph, lint } from '../src/ast.mjs'

const helloSrc = readFileSync(join(FIX, 'fixture-hello.workflow.js'), 'utf8')
const fanoutSrc = readFileSync(join(FIX, 'fixture-fanout.workflow.js'), 'utf8')
const badBannedSrc = readFileSync(join(FIX, 'bad', 'bad-banned-global.workflow.js'), 'utf8')
const badMetaSrc = readFileSync(join(FIX, 'bad', 'bad-meta-variable.workflow.js'), 'utf8')

// ── buildGraph ────────────────────────────────────────────────────────────────

test('buildGraph: fixture-hello — metaName, 1 phase, 1 agent, sequential edge', () => {
  const g = buildGraph(helloSrc)
  assert.equal(g.metaName, 'fixture-hello')
  assert.equal(g.phaseNodes.length, 1)
  assert.equal(g.phaseNodes[0].title, 'Greet')
  assert.equal(g.agentNodes.length, 1)
  assert.equal(g.agentNodes[0].model, 'haiku')
  assert.equal(g.agentNodes[0].label, 'greeter')
  assert.equal(g.edges.length, 1)
  assert.equal(g.edges[0].kind, 'sequential')
  assert.equal(g.edges[0].from, 'root')
})

test('buildGraph: fixture-fanout — metaName, 2 phases, 3 agent nodes, parallel+pipeline edges', () => {
  const g = buildGraph(fanoutSrc)
  assert.equal(g.metaName, 'fixture-fanout')
  assert.equal(g.phaseNodes.length, 2)
  assert.deepEqual(g.phaseNodes.map(p => p.title), ['Fan-out', 'Refine'])
  // AST sees 3 agent call-sites: 1 template inside parallel, 2 inside pipeline
  assert.equal(g.agentNodes.length, 3)
  // At least one parallel and one pipeline edge
  const kinds = g.edges.map(e => e.kind)
  assert.ok(kinds.includes('parallel'), 'should have a parallel edge')
  assert.ok(kinds.includes('pipeline'), 'should have a pipeline edge')
})

// ── lint ──────────────────────────────────────────────────────────────────────

test('lint: hello fixture is clean', () => {
  const result = lint(helloSrc)
  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 0)
})

test('lint: fanout fixture is clean', () => {
  const result = lint(fanoutSrc)
  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 0)
})

test('lint: bad-banned-global flags no-nondeterminism', () => {
  const result = lint(badBannedSrc)
  assert.equal(result.ok, false)
  const rules = result.findings.map(f => f.rule)
  assert.ok(rules.includes('no-nondeterminism'), `expected no-nondeterminism, got: ${rules}`)
})

test('lint: bad-meta-variable flags meta-literal', () => {
  const result = lint(badMetaSrc)
  assert.equal(result.ok, false)
  const rules = result.findings.map(f => f.rule)
  assert.ok(rules.includes('meta-literal'), `expected meta-literal, got: ${rules}`)
})

test('lint: source with import statement is flagged', () => {
  const src = `export const meta = { name: 'bad-import' }
import { foo } from './foo.mjs'
const r = await agent('do something')
return r`
  const result = lint(src)
  assert.equal(result.ok, false)
  assert.ok(result.findings.some(f => f.rule === 'no-import'))
})

test('lint: source with require() is flagged', () => {
  const src = `export const meta = { name: 'bad-require' }
const fs = require('fs')
const r = await agent('read')
return r`
  const result = lint(src)
  assert.equal(result.ok, false)
  assert.ok(result.findings.some(f => f.rule === 'no-import'))
})

test('lint: source with Math.random() is flagged', () => {
  const src = `export const meta = { name: 'bad-random' }
const x = Math.random()
const r = await agent('roll ' + x)
return r`
  const result = lint(src)
  assert.equal(result.ok, false)
  assert.ok(result.findings.some(f => f.rule === 'no-nondeterminism'))
})

test('lint: source with argless new Date() is flagged', () => {
  const src = `export const meta = { name: 'bad-date' }
const d = new Date()
const r = await agent('now ' + d)
return r`
  const result = lint(src)
  assert.equal(result.ok, false)
  assert.ok(result.findings.some(f => f.rule === 'no-nondeterminism'))
})

test('lint: new Date(x) with arg is NOT flagged', () => {
  const src = `export const meta = { name: 'ok-date-arg' }
const d = new Date(0)
const r = await agent('epoch ' + d)
return r`
  const result = lint(src)
  // no-nondeterminism should not fire for new Date(0)
  assert.ok(!result.findings.some(f => f.rule === 'no-nondeterminism'), 'new Date(x) should not be flagged')
})
