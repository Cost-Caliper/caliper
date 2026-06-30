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
3. Bind to a **random free high port** (so it never collides with the dev servers the
   user is building) and start the server with `WFLENS_SESSION_DIR` set so the
   **Observe (native)** tab shows the real `Workflow` runs from that session.

**Do NOT assume the port** — it is randomized each launch. Read the actual URL from the
launcher's log line:

```
[launch] starting Control Tower on http://localhost:<port>
```

Wait ~2 seconds after launching, then confirm it is up with
`curl -fsS http://localhost:<port>/v1/health` using that exact port. Then **report to the
user the dashboard URL** (`http://localhost:<port>`) so they can open it, plus:
- which session dir it is observing (from the launcher's `[launch]` log lines),
- a one-line note that the **Observe (native)** tab shows that session's real `Workflow`
  runs as a per-subagent inference-vs-tool timeline.

(If the user wants a fixed port, they can pass `--port <n>`.)

If the launcher reports no session dir was found, tell the user the Observe tab will
be empty and that they can pass `--session-dir <path>` to point at a specific
`~/.claude/projects/<project>/<session>/` directory.
