// src/fable-evidence.mjs — evidence gatherer behind the `distill-fable` skill
// (skills/distill-fable/SKILL.md). Fable is being removed from Claude Code; this finds
// every place it genuinely authored an assistant turn — main sessions OR subagents,
// anywhere on the machine (~/.claude/projects) — so a live Workflow run can have Fable
// introspect on its own real past work before it's gone.
//
// Two-phase, matching this codebase's existing performance philosophy (see
// aggregateMachine in sessions.mjs): a CHEAP shortlist pass reuses the disk-cached
// per-session summaries (summarizeSessionFile) and the subagent tree scan
// (scanSubagentTree) to find which sessions/subagents are even worth looking at, then
// an EXPENSIVE extraction pass only reads the raw transcript for that shortlisted
// subset.
//
// The extraction pass is a small, independent, purpose-built reader — NOT
// observer.mjs's parseAgentTranscript. That parser's `segments` MERGE consecutive
// same-kind turns (concatenating text, keeping the LATEST model) whenever two
// assistant turns run back-to-back with no tool call between them. That's exactly the
// boundary this needs to get right: a genuine Fable turn immediately followed by a
// post-refusal-fallback Opus turn must never be blended into one blob attributed to
// either model. Reading the raw JSONL directly means every turn's OWN `model` field
// decides its own fate, independent of its neighbors.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { listProjects, scanProjectSessions } from './sessions.mjs'
import { scanSubagentTree } from './subagents.mjs'
import { tierFromModel } from './observe-cost.mjs'

const FABLE_MODEL = 'claude-fable-5'

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n')
  return ''
}

// Every genuinely Fable-authored assistant turn in one transcript file, with its own
// text + the tool names it requested. Non-fable turns (including any post-fallback
// turns later in the SAME file) are excluded by construction — filtered per row, not
// per file.
function extractFableTurns(transcriptPath) {
  let raw
  try { raw = readFileSync(transcriptPath, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || entry.type !== 'assistant') continue
    const msg = entry.message || {}
    if (tierFromModel(msg.model) !== 'fable') continue
    const text = textOf(msg.content).trim()
    if (!text) continue
    const tools = Array.isArray(msg.content)
      ? msg.content.filter((b) => b && b.type === 'tool_use').map((b) => b.name).filter(Boolean)
      : []
    out.push({ ts: entry.timestamp || null, text: text.slice(0, 4000), tools })
  }
  return out
}

function pushExcerpts(turns, ctx, sink) {
  for (const t of turns) sink.push({ projectSlug: ctx.projectSlug, sessionId: ctx.sessionId, ts: t.ts, tools: t.tools, text: t.text })
}

// scanSubagentTree's public return exposes {root, rollup, ...} — the flat `index` Map
// used internally by buildForest is NOT part of its return value, so every subagent
// node is reached by walking root.children recursively (MAIN itself is the root, never
// a subagent, so it's naturally excluded).
function collectSubagentNodes(root) {
  const out = []
  const walk = (node) => { for (const child of node.children || []) { out.push(child); walk(child) } }
  if (root) walk(root)
  return out
}

// gatherFableEvidence(projectsRoot, opts) -> { excerpts, manifest }
//   opts.maxExcerpts    (default 200)    total excerpts kept, machine-wide
//   opts.maxTotalChars  (default 150000) total excerpt text budget
//   opts.sessionLimit   (default 2000)   sessions scanned per project (scanProjectSessions cap)
//
// Never throws on a missing/empty projects root — returns an empty, honestly-reported
// result instead.
export function gatherFableEvidence(projectsRoot, opts = {}) {
  const maxExcerpts = opts.maxExcerpts ?? 200
  const maxTotalChars = opts.maxTotalChars ?? 150000
  const sessionLimit = opts.sessionLimit ?? 2000

  const rawExcerpts = []
  let projectsScanned = 0
  let sessionsScanned = 0
  let minTs = null
  let maxTsSeen = null

  if (existsSync(projectsRoot)) {
    for (const proj of listProjects(projectsRoot)) {
      projectsScanned++
      const { sessions } = scanProjectSessions(proj.dir, { limit: sessionLimit })
      for (const summary of sessions) {
        sessionsScanned++
        if (summary.startedAt) {
          if (!minTs || summary.startedAt < minTs) minTs = summary.startedAt
          if (!maxTsSeen || summary.startedAt > maxTsSeen) maxTsSeen = summary.startedAt
        }

        const mainQualifies = summary.tier === 'fable' || summary.fallbacks?.from === FABLE_MODEL
        if (mainQualifies) {
          const mainPath = join(proj.dir, `${summary.id}.jsonl`)
          pushExcerpts(extractFableTurns(mainPath), { projectSlug: proj.slug, sessionId: summary.id }, rawExcerpts)
        }

        if (summary.hasDir) {
          const sessDir = join(proj.dir, summary.id)
          const { root } = scanSubagentTree(sessDir)
          for (const node of collectSubagentNodes(root)) {
            const subQualifies = node.tier === 'fable' || node.fallbacks?.from === FABLE_MODEL
            if (!subQualifies) continue
            const subPath = join(sessDir, 'subagents', `agent-${node.agentId}.jsonl`)
            pushExcerpts(extractFableTurns(subPath), { projectSlug: proj.slug, sessionId: summary.id }, rawExcerpts)
          }
        }
      }
    }
  }

  const excerptsFound = rawExcerpts.length
  let kept = rawExcerpts
  const totalChars = rawExcerpts.reduce((n, e) => n + e.text.length, 0)
  if (rawExcerpts.length > maxExcerpts || totalChars > maxTotalChars) {
    // Prefer the most substantive turns (longest text) over first-encountered — a
    // one-line acknowledgement teaches Opus nothing; log what got dropped so the
    // manifest never silently implies more evidence than was actually kept.
    const bySize = [...rawExcerpts].sort((a, b) => b.text.length - a.text.length)
    const selected = []
    let chars = 0
    for (const e of bySize) {
      if (selected.length >= maxExcerpts) break
      if (chars + e.text.length > maxTotalChars) continue
      selected.push(e)
      chars += e.text.length
    }
    kept = selected
  }

  return {
    excerpts: kept,
    manifest: {
      projectsScanned,
      sessionsScanned,
      excerptsFound,
      excerptsKept: kept.length,
      droppedForCap: excerptsFound - kept.length,
      dateRange: minTs && maxTsSeen ? { from: minTs, to: maxTsSeen } : null,
    },
  }
}
