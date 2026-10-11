# pi-extras

[繁體中文](README.zh-TW.md)

pi-extras is one [pi](https://github.com/earendil-works/pi) package with eight extensions. You install it once, and pi loads every extension in it. You can turn single extensions off in pi's settings.

pi-extras is tested with `@earendil-works/pi-coding-agent` 1.0.4 and 1.1.0 on Node.js 22.

## Extensions

| Extension | What it does | Docs |
| --- | --- | --- |
| `annotation` | Opens the conversation in your browser with `/annotate`, where you quote parts of it with notes, then inserts them into the editor. | [Annotation](#annotation) |
| `hooks` | Formats each file after the agent writes it and lints changed files before the turn ends, from `.pi/hooks.json`. | [README](extensions/hooks/README.md) |
| `inline-skills` | Lets you pick a skill with `/` in the middle of a prompt and sends its path along with the prompt. | [README](extensions/inline-skills/README.md) |
| `ralph` | Runs a bounded loop of fresh pi sessions on one task with `/ralph`, and stops with `/ralph-stop`. | |
| `resume-handoff` | Starts a new session from a checked handoff file with `/resume-handoff`. | |
| `rpc-subagents` | Runs subagent tasks and schedules as `pi --mode rpc` child processes, with `/rpc-subagents` to list them. Keeps its data and `config.json` in `~/.pi/agent/rpc-subagents/`. | [README](extensions/rpc-subagents/README.md) |
| `skill-name-normalizer` | Gives skills in `~/.pi/agent/skills` and `~/.agents/skills` a valid name when their own name is not one. | |
| `ux` | Pins your last prompt above the editor. | [README](extensions/ux/README.md) |

Each extension lives in `extensions/<name>/`, with its tests and any skills it ships.

## Annotation

`/annotate` opens the current conversation in your browser so you can quote parts of it with notes. It does not block pi; you can keep typing while the page is open.

1. Run `/annotate`. pi prints a URL like `http://127.0.0.1:41234/?token=…` and opens it with `open` on macOS or `xdg-open` on Linux. If the browser does not open, open the URL yourself.
2. The page shows your messages, the assistant's replies and tool outputs. Tool outputs are collapsed; click one to expand it.
3. Select text. A note box appears next to the selection. Type a note and press Enter to add the quote and note to the list on the right. Shift+Enter starts a new line, Esc discards.
4. Edit or delete items in the list.
5. Click **Send to pi editor**. pi inserts every item into the editor, in list order, as a `> quote` block, the note and a blank line. Nothing is sent to the model; you edit the text and send it yourself. The page then shows Done.

The page is a snapshot of the conversation when you ran `/annotate`. Running `/annotate` again while the page is open refreshes the snapshot and gives you the same URL. If you switch sessions (for example with `/new` or `/resume`) before you click Send, pi rejects the send and inserts nothing; run `/annotate` again in the new session.

The server listens on `127.0.0.1` only, on a random port, and stops after a successful send, when the session ends, or after 30 minutes without requests. The URL holds a one-time token. Treat it like a password: anyone who can reach the port with the token can put text into your editor (but cannot send it to the model).

### Over SSH

When pi runs over SSH (`SSH_CONNECTION` is set), it does not try to open a browser. It prints the URL and an `ssh -L` command. Forward the same port number from your own machine, then open the URL there:

```sh
ssh -L 41234:127.0.0.1:41234 <host>
```

The local port must be the same as the remote port, because the server only accepts requests whose `Host` is `127.0.0.1:<port>`. You can run the `ssh -L` command in a second terminal while pi keeps running in the first one.

## Install

To install pi-extras for every project, run:

```sh
pi install git:github.com/tp6gw94/pi-extras
```

To install it for the current project only, add `--local`. pi then writes the package to `.pi/settings.json`:

```sh
pi install --local git:github.com/tp6gw94/pi-extras
```

When pi starts, it lists the eight extensions under `[Extensions]`:

```text
[Extensions]
  tp6gw94/pi-extras:annotation, tp6gw94/pi-extras:hooks, tp6gw94/pi-extras:inline-skills, tp6gw94/pi-extras:ralph, tp6gw94/pi-extras:resume-handoff,
tp6gw94/pi-extras:rpc-subagents, tp6gw94/pi-extras:skill-name-normalizer, tp6gw94/pi-extras:ux
```

## Turn an extension off

pi can skip single extensions of an installed package. You can do this in the `pi config` screen or by editing the settings file. Either way, restart pi or run `/reload` to apply the change. A skill that an extension ships, such as `ralph-completion` from `ralph`, goes away with its extension.

### With pi config

1. Run `pi config`. It opens your personal settings. To change the current project instead, run `pi config --local`, or press Tab. In the project scope, Space cycles through inherit, `+` and `-`.
2. Under `git:github.com/tp6gw94/pi-extras`, move to the extension, for example `ralph/index.ts`, and press Space. The box changes from `[x]` to `[ ]`.
3. Press Esc to close. pi config saves each change as soon as you make it.

pi config writes an exact-path exclusion to the settings file:

```json
{
	"packages": [
		{
			"source": "git:github.com/tp6gw94/pi-extras",
			"extensions": ["-extensions/ralph/index.ts"]
		}
	]
}
```

### In settings.json

Personal settings live in `~/.pi/agent/settings.json`, and project settings in `.pi/settings.json`. Replace the package's source string with an object that has the same `source` and an `extensions` filter. Paths in the filter are relative to the package root:

<!-- example-filter -->
```json
{
	"packages": [
		{
			"source": "git:github.com/tp6gw94/pi-extras",
			"extensions": ["!extensions/ralph/index.ts", "!extensions/resume-handoff/index.ts"]
		}
	]
}
```

The filter accepts these entries:

| Entry | Effect |
| --- | --- |
| `!pattern` | Skips every extension that matches the glob, such as `!extensions/ralph/index.ts`. |
| `-path` | Skips the extension at this exact path. pi config writes this form. |
| `pattern` | Loads only the extensions that match. `["extensions/ux/index.ts", "extensions/hooks/index.ts"]` loads ux and hooks and nothing else. |
| `+path` | Loads the extension at this exact path even when a `!pattern` skips it. |

An empty list, `"extensions": []`, loads none of the extensions. Leave out `extensions` to load all of them. Keep `source` the same as the string that `pi install` wrote, including any `@ref`, so that pi treats it as the same package.

## Development

Development needs Node 22 or later (`.nvmrc` pins 22, so `nvm use` picks it).

```sh
npm install
npm test
npm run typecheck
```

- `npm test` runs the tests of every extension, both `.ts` and `.mjs`. The `rpc-subagents` tests that need an installed pi skip unless you set `RPC_SUBAGENTS_PI_PACKAGE` to a global pi install, for example `~/.local/pi-1.1.0/lib/node_modules/@earendil-works/pi-coding-agent`.
- `npm run typecheck` checks `ux` and `hooks` with `tsconfig.json`, and the other extensions with `tsconfig.extensions.json`.
- The `annotation` tests cover the quote format, the conversation snapshot, the page script (content is rendered as text, never as HTML) and the HTTP server's checks against a real local server. `extensions/annotation/test/e2e/tmux-annotate.sh` runs `/annotate` in a real pi under tmux with a fake model and checks the editor; set `PI_BIN` to the pi binary. `extensions/annotation/test/e2e/browser.mjs` drives the page in headless Chromium; it needs `playwright-core`, which is not a dependency of this package.
- `scripts/acceptance.sh` installs pi-extras from git into a throwaway home directory and checks what pi loads, with all extensions, with a settings filter, and after `pi config`.

pi supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox` to extensions, so `package.json` lists them as `"*"` peer dependencies. `croner` is the only runtime dependency.
