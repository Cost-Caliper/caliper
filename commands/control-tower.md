---
name: control-tower
description: Launch the Control Tower dashboard to visualize Claude Code workflow runs (auto-pointed at the current session)
argument-hint: [--port <n>] [--session-dir <path>]
allowed-tools: Bash
---

Launch the **Control Tower** workflow-visualization dashboard for the user.

Run the bundled launcher **in the background** (it is a long-running server):

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/launch-control-tower.mjs" $ARGUMENTS
```

The launcher will:
1. Install npm deps for `packages/workflow-lens` and `packages/control-tower` on first run.
2. Resolve a Claude Code session dir — using `--session-dir` if given, else
   `$WFLENS_SESSION_DIR`, else auto-discovering the newest run-bearing session
   (preferring the project that matches the current working directory).
3. Start the server (default port **8787**) with `WFLENS_SESSION_DIR` set so the
   **Observe (native)** tab shows the real `Workflow` runs from that session.

After starting it, wait ~2 seconds, then confirm it is up with
`curl -fsS http://localhost:<port>/v1/health`. Report to the user:
- the dashboard URL (`http://localhost:<port>`),
- which session dir it is observing (from the launcher's `[launch]` log lines),
- a one-line note that the **Observe (native)** tab shows real runs, while
  **Control (shim)** runs/replays the bundled sample workflows.

If the launcher reports no session dir was found, tell the user the Observe tab will
be empty and that they can pass `--session-dir <path>` to point at a specific
`~/.claude/projects/<project>/<session>/` directory.
