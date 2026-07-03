// tour-sync.test.mjs — the guided tour must stay in sync with the UI surface.
// Ported from the design-phase checker (.context/check-tour-sync.mjs) per the
// tour-sync skill: every tour step must target an anchor that exists in app.js,
// and every data-tour anchor must be toured or consciously excluded here.
import test from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'), 'utf8')

// Anchors deliberately not part of the tour. Add here ONLY with a reason.
const EXCLUDED = {
  recents: 'covered implicitly by the folders step; sessions list is self-explanatory',
}

const stepSels = [...src.matchAll(/sel:\s*'([^']+)'/g)].map((m) => m[1])
const outsideTour = src.split('const TOUR_TEMPLATE').map((part, i) => (i === 0 ? part : part.slice(part.indexOf('];')))).join('')

test('tour has steps', () => {
  assert.ok(stepSels.length >= 8, `expected a real tour, found ${stepSels.length} steps`)
})

test('every tour step targets an element that exists in the UI code', () => {
  for (const sel of stepSels) {
    const attr = sel.match(/^\[([a-z-]+)(?:="([^"]+)")?\]$/)
    assert.ok(attr, `step selector "${sel}" is not a simple attribute selector`)
    const needle = attr[2] ? `${attr[1]}="${attr[2]}"` : attr[1]
    const indirect = attr[1] === 'data-tour' && attr[2] && outsideTour.includes(`tour: '${attr[2]}'`)
    assert.ok(outsideTour.includes(needle) || indirect, `tour step targets "${sel}" but no element carries ${needle}`)
  }
})

test('every data-tour anchor is toured or explicitly excluded', () => {
  const anchors = [...new Set([
    ...[...src.matchAll(/data-tour="([a-z-]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/tour: '([a-z-]+)'/g)].map((m) => m[1]),
  ])]
  for (const a of anchors) {
    const covered = stepSels.includes(`[data-tour="${a}"]`)
    assert.ok(covered || a in EXCLUDED,
      `UI anchor data-tour="${a}" has no tour step and no EXCLUDED entry — add a step or exclude it with a reason`)
  }
  for (const a of Object.keys(EXCLUDED)) {
    assert.ok(anchors.includes(a), `EXCLUDED entry "${a}" no longer exists in the UI — remove it`)
  }
})
