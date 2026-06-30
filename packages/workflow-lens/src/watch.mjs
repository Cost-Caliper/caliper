// watch.mjs — A1 file-watcher: auto-applies inject.mjs to any *.workflow.js
// dropped into a watched directory.
//
// Usage:
//   node watch.mjs [watchDir] [outDir]
//   startWatcher(watchDir, outDir)  -> { close() }
//
// When a *.workflow.js file is added or changed in watchDir, the watcher:
//   1) reads the source,
//   2) calls inject.transform() on it (idempotent — already-instrumented files
//      are left as-is),
//   3) writes the result to outDir/<name>.instrumented.workflow.js,
//   4) logs a WATCH_EVENT line to stdout showing what happened.
//
// HONEST SCOPE
//   This watcher uses fs.watch() (Node built-in, no external deps).
//   fs.watch() emits 'rename' events on macOS when files are created/modified,
//   with platform-level debounce quirks. The watcher debounces within 50ms to
//   avoid duplicate processing on rapid saves.
//
//   The instrumented file is a valid resume-safe workflow (passes ast.lint) —
//   but under the REAL harness the injected __trace prelude can only emit call
//   STRUCTURE/ORDER/COUNTS via log(), NOT wall-clock timing (the ms clock is
//   banned under the real harness for resume-safety). Wall-clock timing requires
//   the EXTERNAL shim wrapper (ledger.mjs).
import { watch as fsWatch, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { transform } from './inject.mjs'
import { lint } from './ast.mjs'

const WORKFLOW_RE = /\.workflow\.js$/

// startWatcher(watchDir, outDir) -> { close() }
// Watches watchDir for *.workflow.js add/change events and writes instrumented
// versions to outDir. Returns a handle with a close() method.
export function startWatcher(watchDir, outDir, { log = console.log } = {}) {
  mkdirSync(outDir, { recursive: true })

  // debounce map: filename -> timeout handle
  const pending = new Map()

  function processFile(filename) {
    if (!WORKFLOW_RE.test(filename)) return
    const inPath = join(watchDir, filename)
    if (!existsSync(inPath)) return  // 'rename' fires on delete too — skip

    let src
    try {
      src = readFileSync(inPath, 'utf8')
    } catch (e) {
      log(`WATCH_EVENT ${JSON.stringify({ ev: 'read-error', file: filename, error: String(e.message) })}`)
      return
    }

    const { instrumentedSource, wrappedCallSites, alreadyInstrumented } = transform(src)

    const outName = filename.replace(/\.workflow\.js$/, '.instrumented.workflow.js')
    const outPath = join(outDir, outName)
    writeFileSync(outPath, instrumentedSource, 'utf8')

    const lintResult = lint(instrumentedSource)
    log(`WATCH_EVENT ${JSON.stringify({
      ev: alreadyInstrumented ? 'already-instrumented' : 'instrumented',
      file: filename,
      outFile: outName,
      wrappedCallSites: wrappedCallSites.length,
      lintOk: lintResult.ok,
      findings: lintResult.findings,
    })}`)
  }

  function debounceProcess(filename) {
    if (pending.has(filename)) clearTimeout(pending.get(filename))
    pending.set(filename, setTimeout(() => {
      pending.delete(filename)
      processFile(filename)
    }, 50))
  }

  // Re-process all existing workflow files on start
  let watcher
  try {
    watcher = fsWatch(watchDir, { persistent: true }, (eventType, filename) => {
      if (filename) debounceProcess(filename)
    })
    log(`WATCH_EVENT ${JSON.stringify({ ev: 'started', watchDir, outDir })}`)
  } catch (e) {
    log(`WATCH_EVENT ${JSON.stringify({ ev: 'watch-error', error: String(e.message) })}`)
    return { close: () => {} }
  }

  return {
    close() {
      watcher.close()
      for (const h of pending.values()) clearTimeout(h)
      pending.clear()
      log(`WATCH_EVENT ${JSON.stringify({ ev: 'closed', watchDir })}`)
    }
  }
}

// CLI entry point: node watch.mjs [watchDir] [outDir]
if (import.meta.url === `file://${process.argv[1]}`) {
  const watchDir = process.argv[2] || './watched'
  const outDir = process.argv[3] || './out/instrumented'
  mkdirSync(watchDir, { recursive: true })
  console.log(`Watching ${watchDir} -> ${outDir} (Ctrl-C to stop)`)
  const w = startWatcher(watchDir, outDir)
  process.on('SIGINT', () => { w.close(); process.exit(0) })
  process.on('SIGTERM', () => { w.close(); process.exit(0) })
}
