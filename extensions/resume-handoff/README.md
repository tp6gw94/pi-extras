# pi-resume-handoff

[繁體中文](README.zh-TW.md)

pi-resume-handoff is a [pi](https://github.com/earendil-works/pi) extension that starts a new session from a handoff file. `/resume-handoff auto` asks the current agent to write the file, and `/resume-handoff <path>` uses an existing one. The extension can also hand off on its own when context usage reaches a threshold.

## Resume from a handoff

`/resume-handoff auto` asks the current agent to write a handoff in a private system temporary directory. After generation finishes successfully and the file passes validation, the command starts a new session without review or file selection. Failed or aborted generation does not switch sessions. New user input or session navigation cancels the automatic switch.

`/resume-handoff "./handoff reviewed.md"` uses an existing file. `/resume-handoff` searches the current conversation for an existing handoff and offers a choice when several files qualify. Use `"auto"` or `./auto` for a file literally named `auto`.

All modes send an English bootstrap that instructs the new agent to read the exact handoff path as its first action, then continue the work. Generated files remain in the temporary directory after success or failure. Remove them when no session needs them.

If an annotation server is running, a manual or automatic handoff keeps the server on the same port. Attached terminal views and open browser tabs follow the new session and keep their unsent notes. Every other session switch closes the server. See the [annotation README](../annotation/README.md).

## Automatic handoff by context usage

Automatic handoff is off by default. To enable it, create `<agentDir>/resume-handoff/config.json` with `{"enabled": true, "softThresholdPercent": 75, "hardThresholdPercent": 88}`. `agentDir` is pi's agent directory, `~/.pi/agent` unless `PI_CODING_AGENT_DIR` is set. The percentages default to 75 and 88 when omitted. An invalid config disables the feature and shows a warning at session start. The extension reads the config at session start, so changes apply to the next session or to `/reload`. Automatic handoff works in the TUI only.

When a turn completes, the extension reads context usage. At or above the hard threshold, it aborts the run once. Otherwise, at or above the soft threshold, it sends one steer message per run that asks the model to finish the current step and end its turn. When the run settles with usage still at or above the soft threshold, the extension runs `/resume-handoff auto`, which generates the handoff and starts the new session. A run you aborted with Escape never triggers a handoff. The handoff generation run itself is never interrupted.

The thresholds are a budget for the final turn plus handoff generation, not a guarantee. Lower them on small context windows. The extension does not change pi's own compaction. To hand off instead of compacting, set `compaction.enabled` to `false` in pi settings. An overflow then ends the run with an error. Aborting restores queued messages to the editor.

## Tests

`npm test` from the repository root runs the unit tests in `test/`. `test/e2e/acceptance.mjs` runs a real pi with a real provider under tmux. Run it with `node extensions/resume-handoff/test/e2e/acceptance.mjs --provider <provider> --model <model>`. `extensions/annotation/test/e2e/tmux-handoff.sh` checks that annotation clients follow a handoff.
