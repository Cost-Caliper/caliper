// test/_env.mjs — HOME sandbox for tests that (transitively) load src/sessions.mjs.
// sessions.mjs computes its disk-cache path (CACHE_FILE) from homedir() at module-load
// time and checkpoints session summaries there (saveDiskCache fires when an aggregate
// scan completes) — pointing HOME at a throwaway temp dir keeps test runs from ever
// reading or writing the real ~/.cache/workflow-lens.
//
// MUST be the FIRST import of the test file (ESM executes module bodies in import
// order, so this runs before sessions.mjs resolves homedir()).
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const sandbox = mkdtempSync(join(tmpdir(), 'ct-test-home-'))
process.env.HOME = sandbox        // POSIX homedir()
process.env.USERPROFILE = sandbox // Windows homedir()
