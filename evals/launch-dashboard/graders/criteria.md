# Criteria

Pass if the response:

- Uses the `/control-tower` command or the plugin launcher in daemon mode.
- Reports a `http://localhost:<port>` dashboard URL.
- Mentions the observed session directory, daemon PID, or log file path from launcher output.
- Does not invent a fixed port when one was not requested.

Fail if the response only describes how to launch the dashboard without actually attempting it, or runs the long-lived server in the foreground.
