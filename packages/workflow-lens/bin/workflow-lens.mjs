#!/usr/bin/env node
// bin/workflow-lens.mjs — CLI dispatcher for the workflow-lens toolkit.
//
// Commands (keyless unless noted):
//   graph      <workflow.js> [--json]           Static AST graph
//   lint       <workflow.js>                     Resume-safety lint
//   instrument <workflow.js> [--out <file>] [--check]  Splice __trace prelude
//   viz        <workflow.js> [--run <run.json>] [--out <run.html>]  Render HTML
//   run        <workflow.js> [--provider anthropic|openrouter] [--budget <usd>]
//              [--record <file>] [--replay <file>] [--out <dir>] [--max-tokens <n>]
//              Execute workflow (NEEDS KEY unless --replay; FAILS CLOSED without one)
//   estimate   <workflow.js> [--calibrate] [--json]  Pre-flight cost estimate
//   learn      <workflow.js> [--out <dir>] [--max-tokens <n>]
//              Instrument -> run -> distill (NEEDS KEY; FAILS CLOSED)
//   watch      [<watchDir>] [<outDir>]            Long-running fs.watch

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '..', 'src')

// ── arg parsing helpers ───────────────────────────────────────────────────────
const args = process.argv.slice(2)
const cmd = args[0]

function flag(name) {
  const i = args.indexOf(name)
  if (i < 0) return null
  return args[i + 1] || true
}
function hasFlag(name) { return args.includes(name) }

function usage(msg) {
  console.error(msg || 'usage: workflow-lens <command> [args]')
  process.exit(1)
}

// ── command dispatch ──────────────────────────────────────────────────────────

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`workflow-lens — Claude Code workflow toolkit

Commands:
  graph      <workflow.js> [--json]          Static AST graph (keyless)
  lint       <workflow.js>                    Resume-safety lint (keyless)
  instrument <workflow.js> [--out <file>]    Splice __trace prelude (keyless)
             [--check]                        --check: print call sites without writing
  configure  <workflow.js>                    Configurable rewriter (keyless)
             --mode rewrite|sibling           write mode (default: sibling)
             --beacon                         enable beacon channel
             --bridge-url <url>               beacon bridge URL (default: http://localhost:8787)
             --cache                          enable in-run cache dedupe
             --cap <n>                        callCap: throw past N agent calls
             --on-cap skip|throw              cap behavior (default: throw)
             --reroute <from=to>              reroute model tier (e.g. sonnet=haiku)
             --shunt-endpoint <url>           enable conditionalShunt + curl endpoint
             --shunt-targets <a,b,c>          comma-separated agent labels for shunt
             --escape-labels <a,b,c>          comma-separated labels for escapeHatch
             --escape-model <model>           non-Anthropic model for escapeHatch
             --out <file>                     output file path (overrides mode derivation)
             --check                          print manifest without writing
  viz        <workflow.js> [--run <run.json>] Render self-contained HTML (keyless)
             [--out <run.html>]
  run        <workflow.js> [opts]            Execute workflow (NEEDS KEY or --replay)
             --provider anthropic|openrouter
             --budget <usd>
             --record <file>  (save cassette)
             --replay <file>  (replay cassette; keyless)
             --out <dir>      (write graph.json/telemetry.json/run.html)
             --max-tokens <n>
  estimate   <workflow.js> [--calibrate] [--json]  Pre-flight estimate (keyless)
  learn      <workflow.js> [--out <dir>] [--max-tokens <n>]  Run+distill (NEEDS KEY)
  watch      [<watchDir>] [<outDir>]         Auto-instrument on file change (keyless)

Live commands FAIL CLOSED with MISSING_CREDENTIAL when no key is present.
run --replay <cassette> is the only keyless run mode.`)
  process.exit(0)
}

// ── graph ─────────────────────────────────────────────────────────────────────
if (cmd === 'graph') {
  const file = args[1]
  if (!file) usage('usage: workflow-lens graph <workflow.js> [--json]')
  const { buildGraph } = await import(join(srcDir, 'ast.mjs'))
  const src = readFileSync(resolve(file), 'utf8')
  const graph = buildGraph(src)
  if (hasFlag('--json')) {
    console.log(JSON.stringify(graph, null, 2))
  } else {
    console.log(`workflow: ${graph.metaName || '(unnamed)'}`)
    console.log(`phases: ${graph.phaseNodes.length} — ${graph.phaseNodes.map(p => p.title).join(', ') || '(none)'}`)
    console.log(`agents: ${graph.agentNodes.length}`)
    for (const a of graph.agentNodes) {
      const e = graph.edges.find(e => e.to === a.id)
      const container = e && e.from !== 'root' ? ` [${e.from} · ${e.kind}]` : ''
      console.log(`  ${a.id}: ${a.label || '(unlabeled)'} · ${a.model || 'sonnet'}${a.hasSchema ? ' · schema' : ''}${container}`)
    }
    console.log(`edges: ${graph.edges.length}`)
  }
  process.exit(0)
}

// ── lint ──────────────────────────────────────────────────────────────────────
if (cmd === 'lint') {
  const file = args[1]
  if (!file) usage('usage: workflow-lens lint <workflow.js>')
  const { lint } = await import(join(srcDir, 'ast.mjs'))
  const src = readFileSync(resolve(file), 'utf8')
  const result = lint(src)
  if (result.ok) {
    console.log('lint OK — no findings')
    process.exit(0)
  } else {
    for (const f of result.findings) {
      const loc = f.line ? `:${f.line}` : ''
      console.error(`  [${f.severity}] ${f.rule}${loc}: ${f.message}`)
    }
    process.exit(1)
  }
}

// ── instrument ────────────────────────────────────────────────────────────────
if (cmd === 'instrument') {
  const file = args[1]
  if (!file) usage('usage: workflow-lens instrument <workflow.js> [--out <file>] [--check]')
  const { transform } = await import(join(srcDir, 'inject.mjs'))
  const { lint } = await import(join(srcDir, 'ast.mjs'))
  const src = readFileSync(resolve(file), 'utf8')
  const { instrumentedSource, wrappedCallSites, alreadyInstrumented } = transform(src)

  if (hasFlag('--check')) {
    if (alreadyInstrumented) {
      console.log('already instrumented (idempotent — no changes)')
    } else {
      console.log(`wrapped call sites (${wrappedCallSites.length}):`)
      for (const s of wrappedCallSites) {
        console.log(`  line ${s.line}: ${s.kind}${s.label ? ` label="${s.label}"` : ''}${s.model ? ` model="${s.model}"` : ''}`)
      }
    }
    process.exit(0)
  }

  const outFlag = flag('--out')
  let outPath
  if (outFlag && typeof outFlag === 'string') {
    outPath = resolve(outFlag)
  } else {
    const base = basename(file).replace(/\.workflow\.js$/, '')
    outPath = resolve(dirname(resolve(file)), base + '.instrumented.workflow.js')
  }

  writeFileSync(outPath, instrumentedSource, 'utf8')
  const lintResult = lint(instrumentedSource)
  if (!lintResult.ok) {
    console.error('WARNING: instrumented output has lint findings:')
    for (const f of lintResult.findings) console.error(`  [${f.severity}] ${f.rule}: ${f.message}`)
  }
  if (alreadyInstrumented) {
    console.log(`already instrumented (idempotent) — wrote ${outPath}`)
  } else {
    console.log(`instrumented ${wrappedCallSites.length} call site(s) — wrote ${outPath}`)
  }
  process.exit(0)
}

// ── configure (configurable rewriter) ────────────────────────────────────────
if (cmd === 'configure') {
  const file = args[1]
  if (!file) usage('usage: workflow-lens configure <workflow.js> [--mode rewrite|sibling] [--beacon] [--cache] [--cap N] [--reroute from=to] [--shunt-endpoint URL] [--escape-labels a,b] [--out <file>] [--check]')

  const { instrument, apply: applyInstrument } = await import(join(srcDir, 'instrument.mjs'))
  const src = readFileSync(resolve(file), 'utf8')

  // Build config from flags
  const mode = flag('--mode') || 'sibling'
  const beaconEnabled = hasFlag('--beacon')
  const bridgeUrl = (flag('--bridge-url') && typeof flag('--bridge-url') === 'string') ? flag('--bridge-url') : 'http://localhost:8787'
  const cacheEnabled = hasFlag('--cache')
  const capN = flag('--cap') ? parseInt(flag('--cap'), 10) : null
  const onCap = flag('--on-cap') || 'throw'
  const rerouteRaw = flag('--reroute')
  let rerouteModel = null
  if (rerouteRaw && typeof rerouteRaw === 'string') {
    const [from, to] = rerouteRaw.split('=')
    if (from && to) rerouteModel = { [from]: to }
  }
  const shuntEndpoint = flag('--shunt-endpoint')
  const shuntTargetsRaw = flag('--shunt-targets')
  const shuntTargets = (shuntTargetsRaw && typeof shuntTargetsRaw === 'string') ? shuntTargetsRaw.split(',').filter(Boolean) : []
  const escapeLabelsRaw = flag('--escape-labels')
  const escapeLabels = (escapeLabelsRaw && typeof escapeLabelsRaw === 'string') ? escapeLabelsRaw.split(',').filter(Boolean) : []
  const escapeModel = flag('--escape-model') || 'openai/gpt-4o-mini'

  const config = {
    mode,
    channels: {
      logTrace: true,
      beacon: beaconEnabled
        ? { enabled: true, bridgeUrl, events: ['run-start', 'phase', 'run-end'], model: 'haiku' }
        : undefined,
    },
    policy: {
      cache: cacheEnabled,
      callCap: capN,
      onCap,
      rerouteModel,
    },
    hooks: {
      conditionalShunt: shuntEndpoint
        ? { endpoint: shuntEndpoint, decideModel: 'haiku', map: {}, targets: shuntTargets }
        : null,
      escapeHatch: escapeLabels.length > 0
        ? { flagLabels: escapeLabels, provider: 'openrouter', model: escapeModel, keyEnv: 'OPENROUTER_API_KEY' }
        : null,
    },
  }

  if (hasFlag('--check')) {
    const result = instrument(src, config)
    console.log('manifest:', JSON.stringify(result.manifest, null, 2))
    console.log(`wrappedCallSites: ${result.wrappedCallSites.length}`)
    console.log(`injectedSteps: ${result.injectedSteps.length}`)
    for (const s of result.injectedSteps) {
      console.log(`  ${s.kind} @ ${s.where} (model: ${s.model})`)
    }
    if (result.alreadyInstrumented) {
      console.log('(already instrumented — idempotent)')
    }
    process.exit(0)
  }

  const outFlag = flag('--out')
  let outPath
  if (outFlag && typeof outFlag === 'string') {
    outPath = resolve(outFlag)
  }

  let result
  try {
    if (outPath) {
      // write to explicit path (ignore mode derivation)
      const { instrument: instr } = await import(join(srcDir, 'instrument.mjs'))
      const { writeFileSync } = await import('node:fs')
      result = instr(src, config)
      writeFileSync(outPath, result.instrumentedSource, 'utf8')
      console.log(`wrote ${outPath} (${result.injectedSteps.length} injected steps, ${result.wrappedCallSites.length} wrapped call sites)`)
    } else {
      result = applyInstrument(src, config, { filePath: resolve(file) })
      for (const w of result.written) {
        console.log(`wrote ${w.path} [${w.role}]`)
      }
      console.log(`injected steps: ${result.injectedSteps.length}, wrapped call sites: ${result.wrappedCallSites.length}`)
    }
  } catch (e) {
    console.error(`configure failed: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}

// ── viz ───────────────────────────────────────────────────────────────────────
if (cmd === 'viz') {
  const file = args[1]
  if (!file) usage('usage: workflow-lens viz <workflow.js> [--run <run.json>] [--out <run.html>]')
  const { buildGraph } = await import(join(srcDir, 'ast.mjs'))
  const { renderRun } = await import(join(srcDir, 'render.mjs'))
  const { readMetaName } = await import(join(srcDir, 'shim.mjs'))

  const src = readFileSync(resolve(file), 'utf8')
  const graph = buildGraph(src)
  const meta = { name: readMetaName(src) || graph.metaName || 'workflow' }

  let telemetry = {}
  const runFlag = flag('--run')
  if (runFlag && typeof runFlag === 'string') {
    try {
      telemetry = JSON.parse(readFileSync(resolve(runFlag), 'utf8'))
    } catch (e) {
      console.error(`--run: could not parse ${runFlag}: ${e.message}`)
      process.exit(1)
    }
  }

  const html = renderRun({ meta, graph, telemetry })
  const outFlag = flag('--out')
  const outPath = outFlag && typeof outFlag === 'string' ? resolve(outFlag) : resolve('run.html')
  writeFileSync(outPath, html, 'utf8')
  console.log(`wrote ${outPath}`)
  process.exit(0)
}

// ── estimate ──────────────────────────────────────────────────────────────────
if (cmd === 'estimate') {
  const file = args[1]
  if (!file) usage('usage: workflow-lens estimate <workflow.js> [--calibrate] [--json]')
  const { estimate, buildCalibratedTable, runLive } = await import(join(srcDir, 'estimate.mjs'))

  const src = readFileSync(resolve(file), 'utf8')
  let table = null

  if (hasFlag('--calibrate')) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      console.error('MISSING_CREDENTIAL: ANTHROPIC_API_KEY is required for --calibrate')
      process.exit(1)
    }
    console.error('calibrating (live haiku call)…')
    try {
      const snap = await runLive(resolve(file), apiKey)
      table = buildCalibratedTable(snap)
      console.error(`calibration done (${snap.calls.length} call(s))`)
    } catch (e) {
      console.error(`calibration failed: ${e.message}`)
      process.exit(1)
    }
  }

  const est = estimate(src, table)

  if (hasFlag('--json')) {
    console.log(JSON.stringify(est, null, 2))
  } else {
    console.log(`workflow: ${est.workflowName || '(unnamed)'}`)
    console.log(`agents: ${est.agentCount} | models: ${JSON.stringify(est.byModel)}`)
    console.log(`cost estimate: $${est.costUsd.toFixed(8)} [$${est.costLow.toFixed(8)} – $${est.costHigh.toFixed(8)}] (±${est.tolerancePct}%)`)
    console.log(`wall-clock estimate: ${est.wallMs.toFixed(0)}ms [${est.wallMsLow.toFixed(0)}ms – ${est.wallMsHigh.toFixed(0)}ms]`)
    console.log(`note: ${est.method}; ${est.structureNotes[0]}`)
    if (est.breakdown.notes.length) {
      for (const n of est.breakdown.notes) console.log(`  ⚠ ${n}`)
    }
  }
  process.exit(0)
}

// ── run ───────────────────────────────────────────────────────────────────────
if (cmd === 'run') {
  const file = args[1]
  if (!file) usage('usage: workflow-lens run <workflow.js> [opts]')

  const { buildGraph } = await import(join(srcDir, 'ast.mjs'))
  const { runWorkflow, anthropicBackend } = await import(join(srcDir, 'shim.mjs'))
  const { createLedger } = await import(join(srcDir, 'ledger.mjs'))
  const { createGate, openrouterBackend } = await import(join(srcDir, 'gate.mjs'))
  const { renderRun } = await import(join(srcDir, 'render.mjs'))
  const { readMetaName } = await import(join(srcDir, 'shim.mjs'))
  const { createGovernor, BudgetExceededError } = await import(join(srcDir, 'governor.mjs'))
  const { createRecorder, loadCassette } = await import(join(srcDir, 'cassette.mjs'))

  const provider = flag('--provider') || 'anthropic'
  const budgetFlag = flag('--budget')
  const capUsd = budgetFlag ? parseFloat(budgetFlag) : null
  const recordFlag = flag('--record')
  const replayFlag = flag('--replay')
  const outDir = flag('--out')
  const maxTokens = parseInt(flag('--max-tokens') || '64', 10)
  const filePath = resolve(file)

  const src = readFileSync(filePath, 'utf8')
  const graph = buildGraph(src)
  const meta = { name: readMetaName(src) || graph.metaName || 'workflow' }

  // If --replay, build a cassette backend (keyless)
  let rawBackend
  if (replayFlag && typeof replayFlag === 'string') {
    console.error(`replaying from ${replayFlag} (0 real calls)`)
    rawBackend = loadCassette(resolve(replayFlag))
  } else {
    // Live provider — FAIL CLOSED if key absent
    if (provider === 'openrouter') {
      const key = process.env.OPENROUTER_API_KEY
      if (!key) {
        console.error('MISSING_CREDENTIAL: OPENROUTER_API_KEY is required for --provider openrouter')
        process.exit(1)
      }
      rawBackend = openrouterBackend(key, { maxTokens })
    } else {
      // default: anthropic
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) {
        console.error('MISSING_CREDENTIAL: ANTHROPIC_API_KEY is required (set it or use --replay <cassette>)')
        process.exit(1)
      }
      rawBackend = anthropicBackend(key, { maxTokens })
    }
  }

  // Optionally record
  if (recordFlag && typeof recordFlag === 'string') {
    rawBackend = createRecorder(rawBackend, { metaName: meta.name })
  }

  const ledger = createLedger()
  const instrumentedBackend = ledger.instrument(rawBackend)
  const gate = createGate(instrumentedBackend)

  let agentFn = gate
  let parallelFn, pipelineFn
  if (capUsd != null) {
    const gov = createGovernor(gate, ledger, { capUsd })
    agentFn = gov.agent
    parallelFn = gov.parallel
    pipelineFn = gov.pipeline
  }

  let ret
  try {
    const result = await runWorkflow(filePath, {
      agent: agentFn,
      parallel: parallelFn,
      pipeline: pipelineFn,
    })
    ret = result.ret
  } catch (e) {
    if (e instanceof BudgetExceededError || (e && e.code === 'BUDGET_EXCEEDED')) {
      console.error(`BUDGET_EXCEEDED: ${e.message}`)
    } else {
      console.error(`run failed: ${e.message}`)
    }
    process.exit(1)
  }

  // Save cassette if recording
  if (recordFlag && typeof recordFlag === 'string') {
    rawBackend.save(resolve(recordFlag))
    console.error(`cassette saved to ${recordFlag}`)
  }

  const snap = ledger.snapshot()
  const run = snap.run

  console.log(`calls: ${run.calls} | cost: $${run.costUsd} | wall: ${run.wallMs}ms | sum: ${run.sumMs}ms | speedup: ${run.speedup}x`)

  if (outDir) {
    mkdirSync(resolve(outDir), { recursive: true })
    writeFileSync(join(resolve(outDir), 'graph.json'), JSON.stringify(graph, null, 2))
    writeFileSync(join(resolve(outDir), 'telemetry.json'), JSON.stringify(snap, null, 2))
    const html = renderRun({ meta, graph, telemetry: snap })
    writeFileSync(join(resolve(outDir), 'run.html'), html)
    console.log(`artifacts written to ${resolve(outDir)}/`)
  }

  process.exit(0)
}

// ── learn ─────────────────────────────────────────────────────────────────────
if (cmd === 'learn') {
  const file = args[1]
  if (!file) usage('usage: workflow-lens learn <workflow.js> [--out <dir>] [--max-tokens <n>]')

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('MISSING_CREDENTIAL: ANTHROPIC_API_KEY is required for `learn` (run + distiller both need it)')
    process.exit(1)
  }

  const { runAndDistill } = await import(join(srcDir, 'learnings.mjs'))
  const maxTokens = parseInt(flag('--max-tokens') || '24', 10)
  const outDir = (flag('--out') && typeof flag('--out') === 'string') ? resolve(flag('--out')) : resolve('out/learnings')

  mkdirSync(outDir, { recursive: true })

  let result
  try {
    result = await runAndDistill({
      workflowPath: resolve(file),
      outDir,
      maxTokens,
      apiKey,
    })
  } catch (e) {
    console.error(`learn failed: ${e.message}`)
    process.exit(1)
  }

  const { learnings } = result
  console.log(`workflow: ${learnings.workflow}`)
  console.log(`trace records: ${learnings.generatedFrom.traceRecords} | ledger calls: ${learnings.generatedFrom.ledgerCalls}`)
  if (learnings.costHotspots.length) console.log(`top hotspot: ${learnings.costHotspots[0].label} — $${learnings.costHotspots[0].costUsd}`)
  if (learnings.patterns.length) console.log(`patterns: ${learnings.patterns.length}`)
  console.log(`artifacts written to ${outDir}/`)
  process.exit(0)
}

// ── watch ─────────────────────────────────────────────────────────────────────
if (cmd === 'watch') {
  const watchDir = args[1] || './watched'
  const outDir = args[2] || './out/instrumented'
  const { startWatcher } = await import(join(srcDir, 'watch.mjs'))
  const { mkdirSync } = await import('node:fs')
  mkdirSync(watchDir, { recursive: true })
  console.log(`Watching ${watchDir} -> ${outDir} (Ctrl-C to stop)`)
  const w = startWatcher(watchDir, outDir)
  process.on('SIGINT', () => { w.close(); process.exit(0) })
  process.on('SIGTERM', () => { w.close(); process.exit(0) })
  // keep alive
  process.stdin.resume()
}

if (!['graph', 'lint', 'instrument', 'configure', 'viz', 'run', 'estimate', 'learn', 'watch'].includes(cmd)) {
  console.error(`unknown command: ${cmd}`)
  console.error('run workflow-lens --help for usage')
  process.exit(1)
}
