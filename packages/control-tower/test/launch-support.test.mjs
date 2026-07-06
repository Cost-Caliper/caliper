// test/launch-support.test.mjs — src/launch-support.mjs: the port-selection and
// session-dir-discovery logic shared by scripts/launch-control-tower.mjs (manual
// /caliper command) and scripts/hooks/session-start.mjs (automatic SessionStart hook).
// Extracted by a pure refactor out of launch-control-tower.mjs (no behavior change);
// added here because the extracted module is now independently testable and two
// callers now depend on it being correct.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import {
  probePort, pickFreePort, hasWorkflowRuns, newestSessionWithRuns,
  slugForCwd, discoverSessionDir, resolveSessionDir,
} from '../src/launch-support.mjs'

// ── port selection (real network, no mocking) ──────────────────────────────────
test('probePort: false against a port already bound, true once it is released', async () => {
  const srv = net.createServer()
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  assert.equal(await probePort(port), false)
  await new Promise((resolve) => srv.close(resolve))
  assert.equal(await probePort(port), true)
})

test('pickFreePort: returns a port that is actually free (real double-check bind)', async () => {
  const port = await pickFreePort()
  assert.ok(port >= 40000 && port < 60000, `expected a high port, got ${port}`)
  const srv = net.createServer()
  await new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', resolve)
  })
  await new Promise((resolve) => srv.close(resolve))
})

// ── session-dir discovery (fixture project trees) ──────────────────────────────
function makeProjectsRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ct-launchsupport-'))
  return root
}
function makeSessionWithRuns(projectDir, sessionId, mtimeSec) {
  const sessDir = join(projectDir, sessionId)
  mkdirSync(join(sessDir, 'workflows'), { recursive: true })
  writeFileSync(join(sessDir, 'workflows', 'wf_abc123.json'), '{}')
  utimesSync(sessDir, mtimeSec, mtimeSec)
}
function makeSessionWithoutRuns(projectDir, sessionId, mtimeSec) {
  const sessDir = join(projectDir, sessionId)
  mkdirSync(sessDir, { recursive: true })
  utimesSync(sessDir, mtimeSec, mtimeSec)
}

test('slugForCwd: replaces every path separator with a hyphen', () => {
  assert.equal(slugForCwd('/Users/dennison/develop/caliper'), '-Users-dennison-develop-caliper')
})

test('hasWorkflowRuns: true when workflows/wf_*.json exists, false for an empty or missing dir', () => {
  const root = makeProjectsRoot()
  try {
    makeSessionWithRuns(root, 'sess-a', 1750000000)
    assert.equal(hasWorkflowRuns(join(root, 'sess-a')), true)
    makeSessionWithoutRuns(root, 'sess-b', 1750000000)
    assert.equal(hasWorkflowRuns(join(root, 'sess-b')), false)
    assert.equal(hasWorkflowRuns(join(root, 'does-not-exist')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('newestSessionWithRuns: picks the run-bearing session with the highest mtime, skips run-less ones', () => {
  const root = makeProjectsRoot()
  try {
    makeSessionWithRuns(root, 'sess-old', 1750000000)
    makeSessionWithRuns(root, 'sess-new', 1750000500)
    makeSessionWithoutRuns(root, 'sess-norun', 1750001000) // newest mtime, but no runs
    const best = newestSessionWithRuns(root)
    assert.equal(best, join(root, 'sess-new'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('newestSessionWithRuns: null when no session under the project has any run', () => {
  const root = makeProjectsRoot()
  try {
    makeSessionWithoutRuns(root, 'sess-a', 1750000000)
    assert.equal(newestSessionWithRuns(root), null)
    assert.equal(newestSessionWithRuns(join(root, 'missing-project')), null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('discoverSessionDir: prefers the project matching cwd over a newer session elsewhere', () => {
  const projectsRoot = makeProjectsRoot()
  try {
    const cwd = '/Users/dennison/develop/caliper'
    const cwdProject = join(projectsRoot, slugForCwd(cwd))
    const otherProject = join(projectsRoot, '-some-other-project')
    makeSessionWithRuns(cwdProject, 'sess-cwd', 1750000000)
    makeSessionWithRuns(otherProject, 'sess-other-newer', 1750009999) // newer, but different project
    assert.equal(discoverSessionDir(projectsRoot, cwd), join(cwdProject, 'sess-cwd'))
  } finally { rmSync(projectsRoot, { recursive: true, force: true }) }
})

// MUTATION-PROVED: swapped the fallback loop to use `bestMtime >= m` (so it never
// updates past the initial -1 sentinel's first candidate) -> RED: expected the NEWER
// session across projects, got the older one. Restored -> GREEN.
test('discoverSessionDir: falls back to the newest run-bearing session across ALL projects when cwd has none', () => {
  const projectsRoot = makeProjectsRoot()
  try {
    const cwd = '/Users/dennison/develop/caliper'
    const projectA = join(projectsRoot, '-project-a')
    const projectB = join(projectsRoot, '-project-b')
    makeSessionWithRuns(projectA, 'sess-a', 1750000000)
    makeSessionWithRuns(projectB, 'sess-b-newer', 1750005000)
    assert.equal(discoverSessionDir(projectsRoot, cwd), join(projectB, 'sess-b-newer'))
  } finally { rmSync(projectsRoot, { recursive: true, force: true }) }
})

test('discoverSessionDir: null when the projects root does not exist', () => {
  assert.equal(discoverSessionDir('/no/such/projects/root', '/repo'), null)
})

// ── resolveSessionDir ──────────────────────────────────────────────────────────
test('resolveSessionDir: an explicit path wins over discovery, even one that does not exist', () => {
  const projectsRoot = makeProjectsRoot()
  try {
    const cwd = '/Users/dennison/develop/caliper'
    makeSessionWithRuns(join(projectsRoot, slugForCwd(cwd)), 'sess-discoverable', 1750000000)
    const result = resolveSessionDir({ explicit: '/some/explicit/path', projectsRoot, cwd })
    assert.equal(result, '/some/explicit/path')
  } finally { rmSync(projectsRoot, { recursive: true, force: true }) }
})

test('resolveSessionDir: falls through to discovery when no explicit path is given', () => {
  const projectsRoot = makeProjectsRoot()
  try {
    const cwd = '/Users/dennison/develop/caliper'
    const expected = join(projectsRoot, slugForCwd(cwd), 'sess-discoverable')
    makeSessionWithRuns(join(projectsRoot, slugForCwd(cwd)), 'sess-discoverable', 1750000000)
    const result = resolveSessionDir({ explicit: null, projectsRoot, cwd })
    assert.equal(result, expected)
  } finally { rmSync(projectsRoot, { recursive: true, force: true }) }
})
