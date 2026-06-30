// editor.mjs — surgical-splice editor for Control Tower "Edit + Run".
//
// Two public functions:
//   extractEditableAgents(src) -> { agents: [...], modelOptions: MODEL_OPTIONS }
//   applyEdits(src, edits)     -> editedSrc (byte-identical when edits are empty / no-op)
//
// Design: parse the ORIGINAL source via parseSource (no strip, so offsets are in
// original-source coordinates) — NOT parseWorkflow (which strips "export ", shifting
// every node offset by −7 and silently corrupting splices).

import { parseSource } from '../../workflow-lens/src/index.mjs'

export const MODEL_OPTIONS = ['haiku', 'sonnet', 'opus', 'fable']

// ── tiny recursive walker (same shape as ast.mjs — no deps) ──────────────────
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue
    const v = node[k]
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit))
    else if (v && typeof v.type === 'string') walk(v, visit)
  }
}

// Read opts from an ObjectExpression node (the 2nd arg of agent()).
// Returns { label, phase, agentType, model, modelExplicit, modelEditable,
//           modelValueStart, modelValueEnd, hasOpts, optsInsertPos }
function readOptsNode(arg1) {
  const result = {
    label: null, phase: null, agentType: null,
    model: null, modelExplicit: false, modelEditable: true,
    modelValueStart: undefined, modelValueEnd: undefined,
    hasOpts: true,
    optsInsertPos: arg1.start + 1, // index just after the '{'
    argsInsertPos: undefined,
  }

  for (const p of arg1.properties) {
    if (p.type !== 'Property' || p.computed) continue
    const key = p.key.type === 'Identifier' ? p.key.name : (p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null)
    if (!key) continue

    const isStrLit = p.value.type === 'Literal' && typeof p.value.value === 'string'

    if (key === 'label' && isStrLit) result.label = p.value.value
    else if (key === 'phase' && isStrLit) result.phase = p.value.value
    else if (key === 'agentType' && isStrLit) result.agentType = p.value.value
    else if (key === 'model') {
      result.modelExplicit = true
      if (isStrLit) {
        result.model = p.value.value
        result.modelEditable = true
        result.modelValueStart = p.value.start
        result.modelValueEnd = p.value.end
      } else {
        result.model = null
        result.modelEditable = false
      }
    }
  }
  return result
}

/**
 * extractEditableAgents(src) -> { agents: [...], modelOptions: MODEL_OPTIONS }
 *
 * Walks the AST for every statically-declared agent() call and builds a rich
 * descriptor for each, including source offsets needed by applyEdits to splice.
 */
export function extractEditableAgents(src) {
  const ast = parseSource(src)
  const agents = []
  let index = 0

  walk(ast, (node) => {
    if (
      node.type !== 'CallExpression' ||
      !node.callee ||
      node.callee.type !== 'Identifier' ||
      node.callee.name !== 'agent'
    ) return

    const arg0 = node.arguments[0]
    const arg1 = node.arguments[1]

    // ── prompt ────────────────────────────────────────────────────────────────
    let prompt, promptEditable
    if (arg0 && arg0.type === 'Literal' && typeof arg0.value === 'string') {
      prompt = arg0.value
      promptEditable = true
    } else if (arg0 && arg0.type === 'TemplateLiteral' && arg0.expressions.length === 0) {
      prompt = arg0.quasis.map((q) => q.value.cooked).join('')
      promptEditable = true
    } else {
      prompt = '(dynamic — built at runtime; not editable here)'
      promptEditable = false
    }
    const promptStart = arg0 ? arg0.start : undefined
    const promptEnd   = arg0 ? arg0.end   : undefined

    // ── opts ──────────────────────────────────────────────────────────────────
    let label = null, phase = null, agentType = null
    let model, modelExplicit, modelEditable
    let modelValueStart, modelValueEnd
    let hasOpts, optsInsertPos, argsInsertPos

    if (arg1 && arg1.type === 'ObjectExpression') {
      const o = readOptsNode(arg1)
      label = o.label; phase = o.phase; agentType = o.agentType
      model = o.model; modelExplicit = o.modelExplicit; modelEditable = o.modelEditable
      modelValueStart = o.modelValueStart; modelValueEnd = o.modelValueEnd
      hasOpts = true
      optsInsertPos = o.optsInsertPos
    } else {
      // No opts object (arg1 absent or not an ObjectExpression)
      model = null; modelExplicit = false; modelEditable = true
      hasOpts = false
      argsInsertPos = arg0 ? arg0.end : undefined
    }

    agents.push({
      index,
      label,
      phase,
      agentType,
      prompt,
      promptEditable,
      promptStart,
      promptEnd,
      model: (model || 'sonnet'),
      modelExplicit,
      modelEditable,
      modelValueStart,
      modelValueEnd,
      hasOpts,
      optsInsertPos,
      argsInsertPos,
    })

    index++
  })

  return { agents, modelOptions: MODEL_OPTIONS }
}

/**
 * applyEdits(src, edits) -> editedSrc
 *
 * edits = [{ index, prompt?, model? }]
 *
 * Each edit targets the agent at agents[index]. Splices are applied
 * right-to-left (descending by start offset) so earlier offsets remain valid.
 * Returns src unchanged (byte-identical) when there are zero effective ops.
 * Throws an Error with .code === 'EDIT_INVALID' for invalid model or a result
 * that fails to re-parse.
 */
export function applyEdits(src, edits) {
  const { agents } = extractEditableAgents(src)

  // Collect all splice ops { start, end, text }
  const ops = []

  for (const edit of edits) {
    const agent = agents[edit.index]
    if (!agent) continue

    // Validate model
    if (edit.model !== undefined && !MODEL_OPTIONS.includes(edit.model)) {
      const e = new Error('invalid model: ' + edit.model)
      e.code = 'EDIT_INVALID'
      throw e
    }

    // Prompt op
    if (edit.prompt !== undefined && agent.promptEditable) {
      ops.push({ start: agent.promptStart, end: agent.promptEnd, text: JSON.stringify(edit.prompt) })
    }

    // Model op
    if (edit.model !== undefined && agent.modelEditable) {
      if (agent.modelExplicit && agent.modelValueStart != null) {
        // Replace the existing quoted value
        ops.push({ start: agent.modelValueStart, end: agent.modelValueEnd, text: JSON.stringify(edit.model) })
      } else if (agent.hasOpts) {
        // Insert at the opening brace
        ops.push({ start: agent.optsInsertPos, end: agent.optsInsertPos, text: 'model: ' + JSON.stringify(edit.model) + ', ' })
      } else {
        // No opts object at all — insert ", { model: "x" }" after arg0
        ops.push({ start: agent.argsInsertPos, end: agent.argsInsertPos, text: ', { model: ' + JSON.stringify(edit.model) + ' }' })
      }
    }
  }

  // Zero ops → byte-identical return
  if (ops.length === 0) return src

  // Apply right-to-left (descending start) so earlier offsets stay valid
  ops.sort((a, b) => b.start - a.start)

  let out = src
  for (const op of ops) {
    out = out.slice(0, op.start) + op.text + out.slice(op.end)
  }

  // Re-parse to guarantee result is valid JS
  try {
    parseSource(out)
  } catch (e) {
    const err = new Error('edited workflow no longer parses: ' + e.message)
    err.code = 'EDIT_INVALID'
    throw err
  }

  return out
}
