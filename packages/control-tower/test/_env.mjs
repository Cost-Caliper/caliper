// test/_env.mjs — sandbox HOME for the whole test process.
//
// sessions.mjs persists session summaries to ~/.cache/workflow-lens/ (checkpoint
// every 200 summaries + at aggregate-scan completion). Without this, tests that
// drive summarizeSessionFile/aggregateMachine write their synthetic mkdtemp
// fixtures into the REAL user cache (observed: 27 dead /var/folders entries in
// session-summaries-v6.json) and read the user's warm cache, which can mask
// parse regressions behind cache hits.
//
// Import this FIRST — before any import of ../src/sessions.mjs — so CACHE_FILE
// (computed from os.homedir() at module load) lands in the sandbox. node --test
// runs each test file in its own process, so the override is per-file.
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.HOME = mkdtempSync(join(tmpdir(), 'ct-sandbox-home-'))
