# Criteria

Pass if the response:

- Uses the installed-plugin-safe workflow-lens CLI wrapper or an equivalent repo-local command.
- Runs `viz` against `packages/workflow-lens/examples/fanout.workflow.js`.
- Produces or names an HTML report path.
- States that the report is self-contained/offline or contains an inline SVG graph.

Fail if the response only explains the command without producing a report or uses an unrelated visualization tool.
