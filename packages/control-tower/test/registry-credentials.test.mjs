// test/registry-credentials.test.mjs — credential gate + workflow/cassette registry.
//
// credentials.mjs: probeCredentials/requireKey take an explicit env object, so these
// tests never touch process.env. Empty string must count as ABSENT (fail-closed gate).
//
// registry.mjs: loads at import time from the package's committed workflows/ and
// cassettes/ dirs (paths hardcoded relative to src/), so we assert against the
// committed fixtures (hello/fanout/over-budget workflows, hello cassette), which
// are deterministic in-repo. Reload-into-a-tmpdir is not possible without hacking
// module internals — see notes in the buildout output.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sep } from 'node:path'

import { probeCredentials, requireKey } from '../src/credentials.mjs'
import {
  listWorkflows, getWorkflow, getWorkflowPath,
  listCassettes, getCassetteById, getCassettePath,
} from '../src/registry.mjs'

// ── credentials.mjs ────────────────────────────────────────────────────────────

test('probeCredentials: both keys present → both true', () => {
  assert.deepEqual(
    probeCredentials({ ANTHROPIC_API_KEY: 'sk-ant-x', OPENROUTER_API_KEY: 'sk-or-y' }),
    { anthropic: true, openrouter: true },
  )
})

// MUTATION-PROVED: src/credentials.mjs — changed probeCredentials to
// `env.ANTHROPIC_API_KEY !== undefined` (empty string treated as present)
// → this test went RED ("Expected values to be strictly deep-equal ... anthropic: true");
// restored via git checkout → GREEN.
test('probeCredentials: empty string counts as ABSENT (fail-closed)', () => {
  assert.deepEqual(
    probeCredentials({ ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '' }),
    { anthropic: false, openrouter: false },
  )
})

test('probeCredentials: missing vars → both false', () => {
  assert.deepEqual(probeCredentials({}), { anthropic: false, openrouter: false })
})

test('requireKey returns the key value for each provider', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-abc', OPENROUTER_API_KEY: 'sk-or-def' }
  assert.equal(requireKey('anthropic', env), 'sk-ant-abc')
  assert.equal(requireKey('openrouter', env), 'sk-or-def')
})

// MUTATION-PROVED: src/credentials.mjs — removed `e.code = 'MISSING_CREDENTIAL'`
// on the anthropic branch → RED (code undefined !== 'MISSING_CREDENTIAL');
// restored → GREEN.
test('requireKey(anthropic) with missing key throws the documented error shape', () => {
  assert.throws(
    () => requireKey('anthropic', {}),
    (e) => {
      assert.equal(e.code, 'MISSING_CREDENTIAL')
      assert.equal(e.envVar, 'ANTHROPIC_API_KEY')
      assert.equal(e.provider, 'anthropic')
      assert.match(e.message, /MISSING_CREDENTIAL: ANTHROPIC_API_KEY is not set/)
      return true
    },
  )
})

test('requireKey(openrouter) with empty-string key throws MISSING_CREDENTIAL', () => {
  assert.throws(
    () => requireKey('openrouter', { OPENROUTER_API_KEY: '' }),
    (e) => {
      assert.equal(e.code, 'MISSING_CREDENTIAL')
      assert.equal(e.envVar, 'OPENROUTER_API_KEY')
      assert.equal(e.provider, 'openrouter')
      return true
    },
  )
})

test('requireKey with unknown provider throws (no .code — plain Error)', () => {
  assert.throws(
    () => requireKey('mistral', { ANTHROPIC_API_KEY: 'x' }),
    (e) => {
      assert.equal(e.message, 'Unknown provider: mistral')
      assert.equal(e.code, undefined)
      return true
    },
  )
})

// ── registry.mjs: workflows ────────────────────────────────────────────────────

test('listWorkflows: every entry carries the summary shape', () => {
  const list = listWorkflows()
  assert.ok(list.length >= 3, `expected the 3 committed workflows, got ${list.length}`)
  for (const w of list) {
    assert.equal(typeof w.id, 'string')
    assert.equal(typeof w.name, 'string')
    assert.equal(typeof w.description, 'string')
    assert.equal(typeof w.agentCount, 'number')
    assert.equal(typeof w.phaseCount, 'number')
    assert.equal(typeof w.lintOk, 'boolean')
    assert.ok(Array.isArray(w.lintFindings), `${w.id}: lintFindings must be an array`)
  }
})

// MUTATION-PROVED: src/registry.mjs — broke description extraction
// (`const description = ''` instead of the regex match) → RED on the
// description assertion; restored → GREEN.
test('listWorkflows: committed hello workflow has sane values', () => {
  const hello = listWorkflows().find((w) => w.id === 'hello')
  assert.ok(hello, 'hello workflow missing from registry')
  assert.equal(hello.name, 'fixture-hello')              // from meta.name via buildGraph
  assert.equal(hello.description, 'Minimal single-agent workflow: the smallest real run the toolkit can capture.')
  assert.equal(hello.agentCount, 1)                      // one agent() call site
  assert.equal(hello.phaseCount, 1)                      // one phase('Greet')
  assert.equal(hello.lintOk, true)
  assert.deepEqual(hello.lintFindings, [])
})

test('getWorkflow/getWorkflowPath: known id → full record + path under workflows/', () => {
  const w = getWorkflow('hello')
  assert.ok(w, 'getWorkflow(hello) returned null')
  assert.equal(w.id, 'hello')
  assert.equal(typeof w.src, 'string')
  assert.match(w.src, /fixture-hello/)
  const p = getWorkflowPath('hello')
  assert.equal(p, w.path)
  assert.ok(p.includes(`${sep}workflows${sep}hello.workflow.js`), `unexpected path: ${p}`)
})

test('getWorkflow/getWorkflowPath: unknown id → null', () => {
  assert.equal(getWorkflow('no-such-workflow'), null)
  assert.equal(getWorkflowPath('no-such-workflow'), null)
})

// ── registry.mjs: cassettes ────────────────────────────────────────────────────

test('listCassettes: committed hello cassette is listed with header fields', () => {
  const list = listCassettes()
  const hello = list.find((c) => c.id === 'hello')
  assert.ok(hello, 'hello cassette missing from registry')
  assert.equal(hello.metaName, 'fixture-hello')          // from _header.metaName
  assert.equal(hello.calls, 1)
  assert.equal(hello.recordedAt, '2026-06-23T18:36:01.347Z')
  assert.ok(hello.path.includes(`${sep}cassettes${sep}hello.cassette.json`), `unexpected path: ${hello.path}`)
})

test('listCassettes returns a copy — mutating it does not corrupt the registry', () => {
  const first = listCassettes()
  first.length = 0
  assert.ok(listCassettes().some((c) => c.id === 'hello'), 'registry was mutated through the returned array')
})

test('getCassetteById/getCassettePath: known id → record; unknown id → null', () => {
  const c = getCassetteById('hello')
  assert.ok(c, 'getCassetteById(hello) returned null')
  assert.equal(getCassettePath('hello'), c.path)
  assert.equal(getCassetteById('no-such-cassette'), null)
  assert.equal(getCassettePath('no-such-cassette'), null)
})
