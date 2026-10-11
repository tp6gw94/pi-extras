# pi-hooks

[繁體中文](README.zh-TW.md)

pi-hooks is a [pi](https://github.com/earendil-works/pi) extension that formats each file after the agent writes it, lints the files changed in a turn before the turn ends, and sends lint errors back to the agent to fix in the same turn.

You configure it per project in `.pi/hooks.json`. Without that file, the extension does nothing.

pi-hooks is tested with `@earendil-works/pi-coding-agent` 1.0.4 on Node.js 22.19 or later. Hook commands run through `sh`, so pi-hooks targets Linux and macOS. Windows is untested.

## Install it as a pi package

To install pi-hooks for every project, run:

```sh
pi install git:github.com/tp6gw94/pi-hooks
```

To install it for the current project only, add `--local`. pi then writes the package to `.pi/settings.json`:

```sh
pi install --local git:github.com/tp6gw94/pi-hooks
```

To try it for one session without installing it, load the extension file from a clone:

```sh
pi --extension ./hooks-pi/index.ts
```

## Set up hooks in 5 minutes

In this quickstart, we add format and lint hooks to a project that mixes TypeScript and Python. TypeScript files go through prettier and eslint. Python files go through `ruff format` and `ruff check`. Markdown files get no hooks.

The commands and output below come from a real run with pi 1.0.4 and the `openai-codex` `gpt-5.5` model. The scripts in `test/e2e/` rebuild that project and repeat the run.

### Create the config

First, install the tools in the project. pi-hooks runs each command from the project root, so the paths below are relative to it:

```sh
npm install -D prettier eslint @eslint/js typescript-eslint typescript
python3 -m venv .venv && .venv/bin/pip install ruff
```

Now, create `.pi/hooks.json`:

<!-- example-config -->
```json
{
	"afterWrite": [
		{ "name": "prettier", "glob": "*.ts", "command": "node_modules/.bin/prettier --write {files}", "timeoutMs": 20000 },
		{ "name": "ruff format", "glob": "*.py", "command": ".venv/bin/ruff format {files}", "timeoutMs": 20000 }
	],
	"beforeSettle": [
		{ "name": "eslint", "glob": "*.ts", "command": "node_modules/.bin/eslint {files}", "timeoutMs": 60000 },
		{ "name": "ruff check", "glob": "*.py", "command": ".venv/bin/ruff check --no-cache {files}", "timeoutMs": 60000 }
	]
}
```

With this config, each file type gets these commands:

| File | After each `write` or `edit` | Before the turn ends |
| --- | --- | --- |
| `src/math.ts` | `prettier` | `eslint` |
| `app/util.py` | `ruff format` | `ruff check` |
| `docs/notes.md` | nothing | nothing |

### Approve the commands

Start pi in the project and give it a task that writes files. In the real run, the prompt asked the agent to write `src/math.ts`, `src/greet.ts`, `src/legacy.ts`, `app/util.py`, and `docs/notes.md` in one turn. Two of those files had lint errors on purpose: a `var` in `src/legacy.ts` and an unused `import os` in `app/util.py`.

Before pi-hooks runs any command from a project for the first time, it asks you. You should see this dialog, with your own path and hash:

```text
pi-hooks: run commands from this project?

/path/to/project/.pi/hooks.json (sha256 9783e0499a42) wants to run these shell commands:

after write  [*.ts]  node_modules/.bin/prettier --write {files}
after write  [*.py]  .venv/bin/ruff format {files}
before reply [*.ts]  node_modules/.bin/eslint {files}
before reply [*.py]  .venv/bin/ruff check --no-cache {files}

Allow? You will be asked again if the file changes.
```

Choose yes.

### Watch format and lint run

After each write, pi-hooks runs the matching formatter on that one file. If the formatter changes the file, pi-hooks adds a note to the tool result that the agent reads:

```text
[pi-hooks] src/legacy.ts was reformatted by `prettier` after this write. Its content on disk now differs from what you wrote; re-read it before the next edit (edit needs exact text).
```

When the agent tries to end the turn, pi-hooks runs `eslint` once on the three `.ts` files and `ruff check` once on `app/util.py`. Both fail, so you see this notification:

```text
pi-hooks: checks failed; asking the agent to fix (attempt 1/3).
```

The agent gets the errors in a `pi-hooks` message. This copy is shortened:

````text
[pi-hooks] Checks failed on files you changed (automatic fix attempt 1 of 3). Fix the code so these checks pass, then finish your reply.
Do not edit .pi/hooks.json or otherwise disable, skip or weaken the checks; config changes only apply from the next user prompt anyway. If an error cannot be fixed in code, say so in your reply.

### `eslint` (exit 1) on src/greet.ts, src/legacy.ts, src/math.ts
```
/path/to/project/src/legacy.ts
  1:1  error  Unexpected var, use let or const instead  no-var
```

### `ruff check` (exit 1) on app/util.py
```
F401 [*] `os` imported but unused
 --> app/util.py:1:8
```
````

The agent reads both files, fixes them, and pi-hooks runs both checks again. In the real run, this took 7 seconds. When both checks pass, you see this notification:

```text
pi-hooks: checks pass after 1 fix attempt(s).
```

The turn then ends. `docs/notes.md` matched no rule, so no command ran on it.

To see every command that pi-hooks runs, set `PI_HOOKS_LOG` to a file path before you start pi. pi-hooks appends one JSON line per command, with the phase, rule, files, exit code, timeout flag, and duration.

## Config reference

pi-hooks reads `.pi/hooks.json` from the directory that pi runs in. The file is a JSON object with these keys:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `afterWrite` | array of rules | `[]` | Rules that run after each successful `write` or `edit` tool call, including nested calls from codemode. Each matching rule runs on that one file. |
| `beforeSettle` | array of rules | `[]` | Rules that run when the agent is about to end its turn (`agent_before_settle`). Each matching rule runs once, on all files changed in the turn that match its `glob`. |
| `maxFixAttempts` | integer, 0 or more | `3` | How many times pi-hooks asks the agent to fix failed checks after one user prompt. |
| `maxOutputChars` | positive integer | `4000` | The limit on error output sent to the agent. Failed rules share the limit, but each failed rule keeps at least 500 characters, so the total can exceed `maxOutputChars` when more than `maxOutputChars` / 500 rules fail (more than 8 at the default). pi-hooks keeps the start and the end of long output. |

Each rule is an object with these keys:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `glob` | string or array of strings | required | The files that the rule applies to. |
| `command` | string | required | The shell command. pi-hooks runs it with `sh -c` from the project root. |
| `timeoutMs` | positive number | `30000` in `afterWrite`, `120000` in `beforeSettle` | The time limit for the command, in milliseconds. |
| `name` | string | the `command` text | The label in notifications and in messages to the agent. |

### `glob`

- A glob without `/` matches the file name at any depth. `*.ts` matches `a.ts` and `src/deep/a.ts`.
- A glob with `/` matches the path relative to the project root. `src/**/*.ts` matches `src/a.ts` and `src/x/y/a.ts`.
- pi-hooks supports `*`, `**`, `?`, `[...]`, `[!...]`, and `{a,b}`.
- In a list, a glob that starts with `!` excludes files that an earlier glob matched. `["*.ts", "!*.d.ts"]` matches `a.ts` but not `types.d.ts`.

### `{files}`

pi-hooks replaces every `{files}` in `command` with the matched files, separated by spaces. Each path is relative to the project root and quoted for `sh`. A path that starts with `-` gets a `./` prefix, so a file named `--fix.ts` reaches the tool as `./--fix.ts` and not as an option. A command without `{files}` runs as written.

### Changed files

At the start of each user prompt, pi-hooks writes the working tree to a git tree object. It uses a temporary copy of the index, so your index and staged changes stay the same. When the agent tries to end the turn, pi-hooks takes a second snapshot and compares the two. Added and modified files count. Deleted files do not. Files that the agent changed with `bash`, `sed`, or a code generator count too.

If the project is not a git repository, pi-hooks uses the paths from the turn's `write` and `edit` calls.

### Errors and timeouts

- If `.pi/hooks.json` has an error, pi-hooks shows a warning once, skips the bad rules, and loads the others.
- When a command runs longer than `timeoutMs`, pi-hooks stops its whole process group and tells you. If the process does not exit, pi-hooks stops waiting 7 seconds after the time limit.
- A lint timeout goes to you and not to the agent. A formatter failure or timeout also goes only to you.
- If the agent still fails a check after `maxFixAttempts` fixes, pi-hooks stops, shows you the remaining errors, and adds them to the conversation without asking the agent to continue. The count resets at the next user prompt.

## Security

`.pi/hooks.json` is part of the repository. When you clone a repository, its hooks can run any command on your machine. pi-hooks protects you in these ways:

- Before it runs any command from a config for the first time, pi-hooks lists the commands and asks you to approve them.
- pi-hooks stores the SHA-256 hash of each approved config in `~/.pi/agent/pi-hooks-trust.json`, keyed by the config's absolute path. If the file changes, pi-hooks asks again.
- If you decline, pi-hooks does not run that config and does not ask again in the same pi session.
- pi-hooks reads the config once at the start of each user prompt and uses that copy for the whole turn. If the agent edits `.pi/hooks.json` to make a check pass, the edit has no effect in that turn, and pi-hooks warns you. The new config applies from the next prompt, after you approve it. In one real run, `gpt-5.5` did edit the config to bypass a failing check, which is why this rule exists.
- Print mode (`-p`) and JSON mode cannot show a dialog. In those modes, pi-hooks does not run a config that you have not approved. To approve a config, run pi once in interactive or RPC mode.

## Limitations

- Format-on-write runs only after the `write` and `edit` tools. If the agent changes a file with `bash`, no formatter runs on it. The end-of-turn lint still checks it.
- The agent's first reply appears before the lint runs. If a check fails, the agent fixes the code and writes a second reply.
- After each fix, pi-hooks runs the checks again on every file changed since the prompt, not only on the fixed files. With the default limit of 3 fixes, a check runs up to 4 times per prompt.
- pi-hooks does not lint a turn that ends because you stopped it or because of an error.
- pi-hooks reads `.pi/hooks.json` from the directory that pi runs in, not from the git root.
- pi-hooks needs `setsid` to stop a command's child processes on timeout. Linux has it. Without `setsid`, as on stock macOS, pi-hooks stops only the main process, and child processes can keep running.

## Development

```sh
npm install
npm run typecheck
npm test
```

`npm test` runs the unit tests. To run the end-to-end scenarios with a real model, use `test/e2e/acceptance.sh`:

```sh
test/e2e/acceptance.sh /tmp/pi-hooks-e2e -- --provider openai-codex --model gpt-5.5
```
