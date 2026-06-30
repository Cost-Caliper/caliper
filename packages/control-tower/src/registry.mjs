// src/registry.mjs — workflow + cassette registry.
//
// On boot, scans workflows/ for *.workflow.js and cassettes/ for *.cassette.json.
// Each workflow is read, lint'd, and graph'd once and cached.
// The registry is read-only after boot; re-scan requires a restart (or --watch mode).

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as lens from '../../workflow-lens/src/index.mjs'

const __dir = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dir, '..')
const WORKFLOWS_DIR = join(ROOT, 'workflows')
const CASSETTES_DIR = join(ROOT, 'cassettes')

// ── Workflow registry ──────────────────────────────────────────────────────────

const _workflows = new Map()  // id -> {id, name, description, path, src, lintFindings, graph}

export function loadWorkflows() {
  _workflows.clear()
  if (!existsSync(WORKFLOWS_DIR)) return
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.workflow.js')).sort()
  for (const file of files) {
    const id = basename(file, '.workflow.js')
    const path = join(WORKFLOWS_DIR, file)
    try {
      const src = readFileSync(path, 'utf8')
      // lens.lint returns {ok:bool, findings:[]} — store the full object
      const lintResult = lens.lint(src)
      let graph = { metaName: id, phaseNodes: [], agentNodes: [], edges: [] }
      try { graph = lens.buildGraph(src) } catch { /* if AST fails, use empty graph */ }
      const name = graph.metaName || id
      // Pull description from meta literal if available
      const descMatch = src.match(/description\s*:\s*['"`]([^'"`]+)['"`]/)
      const description = descMatch ? descMatch[1] : ''
      _workflows.set(id, { id, name, description, path, src, lintResult, graph })
    } catch (e) {
      console.error(`[registry] failed to load workflow ${file}: ${e.message}`)
    }
  }
  console.log(`[registry] loaded ${_workflows.size} workflow(s)`)
}

export function listWorkflows() {
  return [..._workflows.values()].map(({ id, name, description, lintResult, graph }) => ({
    id,
    name,
    description,
    agentCount: (graph.agentNodes || []).length,
    phaseCount: (graph.phaseNodes || []).length,
    lintOk: lintResult.ok === true,
    lintFindings: Array.isArray(lintResult.findings) ? lintResult.findings : [],
  }))
}

export function getWorkflow(id) {
  return _workflows.get(id) || null
}

export function getWorkflowPath(id) {
  const w = _workflows.get(id)
  return w ? w.path : null
}

// ── Cassette registry ──────────────────────────────────────────────────────────

const _cassettes = []  // [{path, id, metaName, calls, recordedAt}]

export function loadCassettes() {
  _cassettes.length = 0
  if (!existsSync(CASSETTES_DIR)) return
  const files = readdirSync(CASSETTES_DIR).filter((f) => f.endsWith('.cassette.json')).sort()
  for (const file of files) {
    const path = join(CASSETTES_DIR, file)
    const id = basename(file, '.cassette.json')
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8'))
      const header = payload._header || {}
      _cassettes.push({
        path,
        id,
        metaName: header.metaName || id,
        calls: header.calls || 0,
        recordedAt: header.recordedAt || null,
      })
    } catch (e) {
      console.error(`[registry] failed to load cassette ${file}: ${e.message}`)
    }
  }
  console.log(`[registry] loaded ${_cassettes.length} cassette(s)`)
}

export function listCassettes() {
  return _cassettes.slice()
}

export function getCassettePath(id) {
  const c = _cassettes.find((c) => c.id === id)
  return c ? c.path : null
}

export function getCassetteById(id) {
  return _cassettes.find((c) => c.id === id) || null
}

// Bootstrap on first import
loadWorkflows()
loadCassettes()
