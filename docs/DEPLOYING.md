# Deploying a Caliper release

The plugin ships from this repo's `main` branch: users install via the Claude Code plugin
marketplace and the in-app update pill compares the local version against GitHub, so
**merging to `main` with a version bump IS the deployment.**

Work through this checklist in order — every step, every release.

## 1. Check everything works — manually

- `npm test` in `packages/control-tower` AND `packages/workflow-lens` (keyless, no API calls).
  This includes `tour-sync.test.mjs` — if you changed the UI, the tour must still match it.
- Launch against **demo data** (never verify releases on your real transcripts):

  ```sh
  node scripts/demo-data.mjs
  WFLENS_PROJECTS_ROOT=/tmp/caliper-demo/projects PORT=48899 node packages/control-tower/server.mjs
  ```

- Walk the real paths in a browser (agent-browser or by hand): Home KPIs + daily chart
  hover, folder drill-in, a session with subagents (waterfall renders, per-run expanders
  reconstruct), `#/folders` filter + sorts, the ✦ Tour end-to-end (finish with Done),
  an ⧉ Optimize modal + copy, dark ⇄ light toggle, and the browser console for errors.
- For UI changes, run the ux-walker story catalog against the demo server and read the
  report before shipping (report-only; fix what it finds first).

## 2. Update the changelog

- Add a `## <version> — <date>` section to `CHANGELOG.md` describing user-visible changes.
  Plain and accurate; no marketing inflation.

## 3. Update the screenshots

- **Demo data only — always.** Real transcripts contain private prompts, paths, and spend.
- With the demo server from step 1 running, capture in **light theme** at ~1440×900,
  tour hint dismissed, and overwrite `docs/screenshots/{home,folder,session}.png`.
  Keep the set tight — three images, same filenames, so README links never break.

## 4. Update the README

- Re-read `README.md` against what actually shipped: feature bullets, install steps,
  repo layout, cost formula. Fix drift; keep it tight.

## 5. Version, commit, publish

- Bump `version` in `.claude-plugin/plugin.json` (semver: UI/feature releases bump minor).
- One release commit titled like the changelog entry, ending with the version:
  `New caliper.run design system UI (v0.27.0)`.
- PR to `main`, merge when green. Users get the update pill on their next dashboard load;
  `self-update` runs `git pull --ff-only` against `main`.
