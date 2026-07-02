#!/usr/bin/env node
// Installed-plugin-safe wrapper for the workflow-lens CLI.
// Ensures package dependencies exist, then forwards all args to bin/workflow-lens.mjs.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(__dirname, '..')
const LENS_DIR = join(ROOT, 'packages', 'workflow-lens')
const BIN = join(LENS_DIR, 'bin', 'workflow-lens.mjs')

if (!existsSync(join(LENS_DIR, 'node_modules'))) {
  if (!existsSync(join(LENS_DIR, 'package-lock.json'))) {
    console.error('[workflow-lens] refusing to install deps: package-lock.json is missing')
    process.exit(1)
  }
  console.error('[workflow-lens] installing locked deps for workflow-lens ...')
  const install = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: LENS_DIR, stdio: 'inherit' })
  if (install.status !== 0) process.exit(install.status || 1)
}

const run = spawnSync(process.execPath, [BIN, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: process.env,
})

if (run.error) {
  console.error(`[workflow-lens] failed to launch: ${run.error.message}`)
  process.exit(1)
}
process.exit(run.status ?? 0)
