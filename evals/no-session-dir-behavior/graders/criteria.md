# Criteria

Pass if the response:

- Says the dashboard can still start without a session directory.
- Explains that Observe/native workflow or subagent views may be empty or disabled.
- Tells the user to pass `--session-dir <path>` to point at a specific `~/.claude/projects/<project>/<session>/` directory.
- Does not treat the absence of session artifacts as a fatal launcher error.

Fail if it claims the whole dashboard cannot run without a session directory or invents a session path.
