// src/subagents.mjs — the "Subagents" view: DIRECT subagents (spawned by the `Agent`
// tool, NOT inside a Workflow), assembled into a parent→child tree.
//
// On disk, per session dir:
//   <sessDir>/subagents/agent-<id>.jsonl       — a subagent transcript
//   <sessDir>/subagents/agent-<id>.meta.json   — {agentType, description, toolUseId}
//   <sessDir>.jsonl  (SIBLING file)            — the MAIN session transcript
//
// Parent linkage: a subagent's meta.toolUseId is the id of the `Agent` tool_use found
// in its PARENT's transcript — either the MAIN session (→ a root subagent) or another
// subagent (→ a nested sub-subagent). Depth is COMPUTED from this resolved chain, never
// read from any per-agent field. The forest is rooted at a synthetic MAIN_SESSION node.
//
// Reuses parseAgentTranscript (light for the list, full for one-agent detail),
// tierFromModel, and costOfUsage — no new parsing/timeline/cost logic.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseAgentTranscript } from './observer.mjs'
import { costOfUsage, tierFromModel } from './observe-cost.mjs'

export const MAIN_SESSION = '__MAIN_SESSION__'

const MAX_DEPTH_GUARD = 200 // defends the parent-chain walk against malformed/cyclic metas

const msBetween = (firstIso, lastIso) => {
  const a = firstIso ? Date.parse(firstIso) : NaN
  const b = lastIso ? Date.parse(lastIso) : NaN
  if (isNaN(a) || isNaN(b)) return 0
  return Math.max(0, b - a)
}

// ── Pure forest assembly ────────────────────────────────────────────────────────
// subNodes: light node objects (see scanSubagentTree). ownerOfToolUse: Map or object
// mapping a tool_use id → owner agentId (or MAIN_SESSION). Returns {root, index, rollup}.
// Pure (no IO) so the tree/depth/orphan/cycle/rollup logic is unit-testable in isolation.
export function buildForest(subNodes, ownerOfToolUse, mainStats = {}) {
  const get = (id) => (ownerOfToolUse instanceof Map ? ownerOfToolUse.get(id) : (ownerOfToolUse || {})[id])

  const root = {
    agentId: MAIN_SESSION,
    isMain: true,
    agentType: 'session',
    description: 'main session',
    depth: 0,
    children: [],
    childCount: 0,
    orphan: false,
    ...mainStats,
  }

  const index = new Map()
  index.set(MAIN_SESSION, root)
  for (const n of subNodes) {
    index.set(n.agentId, { ...n, children: [], childCount: 0, depth: null, orphan: false })
  }

  // Resolve each subagent's parent id (MAIN_SESSION, a known agentId, or MAIN if orphan).
  for (const n of subNodes) {
    const node = index.get(n.agentId)
    const owner = node.parentToolUseId != null ? get(node.parentToolUseId) : undefined
    if (owner === MAIN_SESSION) {
      node.parentAgentId = MAIN_SESSION
    } else if (owner != null && index.has(owner) && owner !== node.agentId) {
      node.parentAgentId = owner
    } else {
      node.parentAgentId = MAIN_SESSION
      node.orphan = true // parent transcript not found, or self-reference
    }
  }

  // Break any parent cycles (impossible by construction, but guard malformed data):
  // walk each node's parent chain; if it revisits a node, re-home it under MAIN.
  for (const n of subNodes) {
    const node = index.get(n.agentId)
    const seen = new Set([node.agentId])
    let cur = node.parentAgentId
    let hops = 0
    while (cur && cur !== MAIN_SESSION && hops++ < MAX_DEPTH_GUARD) {
      if (seen.has(cur)) { node.parentAgentId = MAIN_SESSION; node.orphan = true; break }
      seen.add(cur)
      cur = index.get(cur)?.parentAgentId
    }
    if (hops >= MAX_DEPTH_GUARD) { node.parentAgentId = MAIN_SESSION; node.orphan = true }
  }

  // Attach to parents.
  for (const n of subNodes) {
    const node = index.get(n.agentId)
    const parent = index.get(node.parentAgentId) || root
    parent.children.push(node)
  }

  // Sort siblings deterministically (by start time, then agentId) and set depth + childCount.
  const seenDfs = new Set()
  const sortKids = (node, depth) => {
    if (seenDfs.has(node.agentId)) return
    seenDfs.add(node.agentId)
    node.depth = depth
    node.children.sort((a, b) => (a.startedAtMs || 0) - (b.startedAtMs || 0) || String(a.agentId).localeCompare(String(b.agentId)))
    node.childCount = node.children.length
    for (const k of node.children) sortKids(k, depth + 1)
  }
  sortKids(root, 0)

  // Rollup over real subagents (exclude the synthetic MAIN node).
  let maxDepth = 0, orphanCount = 0, totalCostUsd = 0
  const totalTokens = { in: 0, out: 0, cacheWr: 0, cacheRd: 0 }
  const agentTypeCounts = {}
  let minStart = Infinity, maxEnd = -Infinity
  for (const n of subNodes) {
    const node = index.get(n.agentId)
    maxDepth = Math.max(maxDepth, node.depth || 0)
    if (node.orphan) orphanCount++
    totalCostUsd += node.costUsd || 0
    totalTokens.in += node.tokens?.in || 0
    totalTokens.out += node.tokens?.out || 0
    totalTokens.cacheWr += node.tokens?.cacheWr || 0
    totalTokens.cacheRd += node.tokens?.cacheRd || 0
    agentTypeCounts[node.agentType] = (agentTypeCounts[node.agentType] || 0) + 1
    if (node.startedAtMs) { minStart = Math.min(minStart, node.startedAtMs); maxEnd = Math.max(maxEnd, node.startedAtMs + (node.ms || 0)) }
  }
  const rollup = {
    totalSubagents: subNodes.length,
    rootCount: root.children.length,
    maxDepth,
    orphanCount,
    totalCostUsd: +totalCostUsd.toFixed(6),
    totalTokens,
    wallSpanMs: maxEnd > minStart ? maxEnd - minStart : 0,
    agentTypeCounts,
  }

  return { root, index, rollup }
}

// ── Build one LIGHT node from a meta + a light transcript parse ──────────────────
function lightNode(agentId, meta, parsed, ownerEntry, transcriptMissing = false) {
  const model = parsed.model || ownerEntry?.model || null
  const usage = parsed.totalUsage || {}
  return {
    agentId,
    agentType: meta.agentType || 'subagent',
    description: meta.description || ownerEntry?.description || null,
    parentToolUseId: meta.toolUseId || null,
    model,
    tier: tierFromModel(model),
    tokens: {
      in: usage.input_tokens || 0,
      out: usage.output_tokens || 0,
      cacheWr: usage.cache_creation_input_tokens || 0,
      cacheRd: usage.cache_read_input_tokens || 0,
    },
    costUsd: +costOfUsage(usage, model).toFixed(6),
    ms: msBetween(parsed.firstTimestamp, parsed.lastTimestamp),
    startedAt: parsed.firstTimestamp || null,
    startedAtMs: parsed.firstTimestamp ? (Date.parse(parsed.firstTimestamp) || 0) : 0,
    endedAt: parsed.lastTimestamp || null,
    toolCalls: parsed.toolCalls || 0,
    tools: parsed.tools || [],
    turns: parsed.assistantTurns || 0,
    // status is DERIVED (heuristic), not an authoritative harness signal:
    // 'missing' = meta sidecar present but no transcript file (aborted/never-wrote);
    // 'running' = transcript present but no terminal assistant turn; else 'done'.
    status: transcriptMissing ? 'missing' : (parsed.lastTimestamp ? 'done' : 'running'),
  }
}

const META_RE = /^agent-([0-9a-f]+)\.meta\.json$/

// ── Scan a session dir → subagent forest (light) ────────────────────────────────
export function scanSubagentTree(sessDir) {
  // The MAIN transcript is a SIBLING file (<sessDir>.jsonl), built by concatenation — so a
  // trailing slash on WFLENS_SESSION_DIR would yield "<sessDir>/.jsonl". Normalize it away.
  const base = String(sessDir || '').replace(/[/\\]+$/, '')
  const empty = { sessionId: base ? basename(base) : null, root: null, rollup: null, cwd: null, gitBranch: null }
  if (!base || !existsSync(base)) return empty
  const subDir = join(base, 'subagents')
  if (!existsSync(subDir)) return empty

  let metaFiles
  try { metaFiles = readdirSync(subDir).filter((f) => META_RE.test(f)) } catch { return empty }

  // Owner map: a tool_use id → owner agentId (MAIN_SESSION or a subagent id), with the
  // spawning Agent call's description/model for label fallback.
  const ownerOfToolUse = new Map()
  const addAgentCalls = (ownerId, parsed) => {
    for (const a of parsed?.agentCalls || []) {
      if (a.id && !ownerOfToolUse.has(a.id)) ownerOfToolUse.set(a.id, ownerId === MAIN_SESSION ? MAIN_SESSION : ownerId)
    }
  }
  // ownerEntry map keeps the spawn metadata (description/model) keyed by tool_use id.
  const spawnMeta = new Map()
  const collectSpawnMeta = (parsed) => {
    for (const a of parsed?.agentCalls || []) if (a.id && !spawnMeta.has(a.id)) spawnMeta.set(a.id, { description: a.description, model: a.model })
  }

  // MAIN session transcript = sibling <sessDir>.jsonl
  const mainPath = base + '.jsonl'
  const mainParse = parseAgentTranscript(mainPath, { light: true })
  if (mainParse) { addAgentCalls(MAIN_SESSION, mainParse); collectSpawnMeta(mainParse) }

  // Parse each subagent transcript ONCE (light), build nodes + owner map.
  const parsedById = new Map()
  const metas = new Map()
  for (const f of metaFiles) {
    const agentId = f.match(META_RE)[1]
    let meta = {}
    try { meta = JSON.parse(readFileSync(join(subDir, f), 'utf8')) } catch { meta = {} }
    const parsed = parseAgentTranscript(join(subDir, `agent-${agentId}.jsonl`), { light: true })
    parsedById.set(agentId, parsed) // null if the transcript file is absent
    metas.set(agentId, meta)
    if (parsed) { addAgentCalls(agentId, parsed); collectSpawnMeta(parsed) }
  }

  const subNodes = []
  let cwd = mainParse?.cwd || null
  let gitBranch = mainParse?.gitBranch || null
  for (const [agentId, meta] of metas) {
    const parsed = parsedById.get(agentId)
    if (parsed) {
      if (!cwd && parsed.cwd) cwd = parsed.cwd
      if (!gitBranch && parsed.gitBranch) gitBranch = parsed.gitBranch
    }
    subNodes.push(lightNode(agentId, meta, parsed || {}, spawnMeta.get(meta.toolUseId), !parsed))
  }

  // MAIN's own measured stats (clearly "self", not a subtree roll-up).
  const mainStats = mainParse ? {
    model: mainParse.model || null,
    tier: tierFromModel(mainParse.model),
    tokens: {
      in: mainParse.totalUsage.input_tokens, out: mainParse.totalUsage.output_tokens,
      cacheWr: mainParse.totalUsage.cache_creation_input_tokens, cacheRd: mainParse.totalUsage.cache_read_input_tokens,
    },
    costUsd: +costOfUsage(mainParse.totalUsage, mainParse.model).toFixed(6),
    ms: msBetween(mainParse.firstTimestamp, mainParse.lastTimestamp),
    startedAt: mainParse.firstTimestamp || null,
    startedAtMs: mainParse.firstTimestamp ? (Date.parse(mainParse.firstTimestamp) || 0) : 0,
    toolCalls: mainParse.toolCalls || 0,
    turns: mainParse.assistantTurns || 0,
    status: 'session',
  } : {}

  const { root, rollup } = buildForest(subNodes, ownerOfToolUse, mainStats)
  return { sessionId: basename(base), root, rollup, cwd, gitBranch }
}

// ── Full detail for ONE subagent (lazy) → call-shape the frontend timeline expects ──
export function reconstructSubagent(sessDir, agentId) {
  if (!sessDir) return null
  const base = String(sessDir).replace(/[/\\]+$/, '') // tolerate a trailing slash (sibling-file path)
  let transcriptPath
  if (agentId === MAIN_SESSION) {
    transcriptPath = base + '.jsonl'
  } else if (/^[0-9a-f]+$/.test(String(agentId))) { // hex guard — block path traversal
    transcriptPath = join(base, 'subagents', `agent-${agentId}.jsonl`)
  } else {
    return null
  }
  const p = parseAgentTranscript(transcriptPath) // full parse (segments + detail)
  if (!p) return null
  const usage = p.totalUsage || {}
  const ms = msBetween(p.firstTimestamp, p.lastTimestamp)
  return {
    agentId,
    isMain: agentId === MAIN_SESSION,
    label: (agentId === MAIN_SESSION ? 'main session' : null) || p.task?.slice(0, 60) || agentId,
    model: p.model,
    tier: tierFromModel(p.model),
    phase: null,
    startMs: 0,
    endMs: ms,
    ms,
    inTok: usage.input_tokens || 0,
    outTok: usage.output_tokens || 0,
    cacheCreationTok: usage.cache_creation_input_tokens || 0,
    cacheReadTok: usage.cache_read_input_tokens || 0,
    costUsd: +costOfUsage(usage, p.model).toFixed(6),
    segments: p.segments || [],
    inferenceMs: p.inferenceMs || 0,
    toolMs: p.toolMs || 0,
    task: p.task || null,
    output: p.output || null,
    tools: p.tools || [],
    toolCalls: p.toolCalls || 0,
    turns: p.assistantTurns || 0,
  }
}
