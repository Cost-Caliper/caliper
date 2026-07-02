# Criteria

Pass if the response:

- Uses `workflow-lens estimate` through the wrapper or an equivalent repo-local command.
- Avoids `--calibrate` and does not require `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`.
- Reports a cost estimate and a wall-clock estimate or explains where they appear in JSON output.
- Mentions the static estimate caveat/tolerance when summarizing the result.

Fail if it attempts a live run, fabricates numbers without running the estimator, or asks for an API key.
