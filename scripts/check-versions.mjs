#!/usr/bin/env node
// Keep the plugin release version as the source of truth.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
}

function readSkillVersion() {
  const md = readFileSync(join(ROOT, 'skills', 'workflow-lens', 'SKILL.md'), 'utf8')
  const frontmatter = md.match(/^---\n([\s\S]*?)\n---/)
  const version = frontmatter?.[1]?.match(/^\s*version:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]
  return version || null
}

const source = readJson('.claude-plugin/plugin.json').version
const versions = [
  ['.claude-plugin/plugin.json', source],
  ['packages/workflow-lens/package.json', readJson('packages/workflow-lens/package.json').version],
  ['packages/control-tower/package.json', readJson('packages/control-tower/package.json').version],
  ['skills/workflow-lens/SKILL.md metadata.version', readSkillVersion()],
]

const mismatches = versions.filter(([, version]) => version !== source)

if (mismatches.length) {
  console.error(`[versions] mismatch; source of truth is .claude-plugin/plugin.json (${source})`)
  for (const [name, version] of versions) {
    console.error(`- ${name}: ${version || 'missing'}`)
  }
  process.exit(1)
}

console.log(`[versions] ok: ${source}`)
