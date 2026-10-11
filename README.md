# pi-extras

[繁體中文](README.zh-TW.md)

pi-extras is one [pi](https://github.com/earendil-works/pi) package with seven extensions. You install it once, and pi loads every extension in it. You can turn single extensions off in pi's settings.

pi-extras is tested with `@earendil-works/pi-coding-agent` 1.0.4 and 1.1.0 on Node.js 22.

## Extensions

| Extension | What it does | Docs |
| --- | --- | --- |
| `hooks` | Formats each file after the agent writes it and lints changed files before the turn ends, from `.pi/hooks.json`. | [README](extensions/hooks/README.md) |
| `inline-skills` | Lets you pick a skill with `/` in the middle of a prompt and sends its path along with the prompt. | [README](extensions/inline-skills/README.md) |
| `ralph` | Runs a bounded loop of fresh pi sessions on one task with `/ralph`, and stops with `/ralph-stop`. | |
| `resume-handoff` | Starts a new session from a checked handoff file with `/resume-handoff`. | |
| `rpc-subagents` | Runs subagent tasks and schedules as `pi --mode rpc` child processes, with `/rpc-subagents` to list them. Keeps its data and `config.json` in `~/.pi/agent/rpc-subagents/`. | [README](extensions/rpc-subagents/README.md) |
| `skill-name-normalizer` | Gives skills in `~/.pi/agent/skills` and `~/.agents/skills` a valid name when their own name is not one. | |
| `ux` | Pins your last prompt above the editor and quotes the clipboard into the prompt with `alt+q` or `/quote`. | [README](extensions/ux/README.md) |

Each extension lives in `extensions/<name>/`, with its tests and any skills it ships.

## Install

To install pi-extras for every project, run:

```sh
pi install git:github.com/tp6gw94/pi-extras
```

To install it for the current project only, add `--local`. pi then writes the package to `.pi/settings.json`:

```sh
pi install --local git:github.com/tp6gw94/pi-extras
```

When pi starts, it lists the seven extensions under `[Extensions]`:

```text
[Extensions]
  tp6gw94/pi-extras:hooks, tp6gw94/pi-extras:inline-skills, tp6gw94/pi-extras:ralph, tp6gw94/pi-extras:resume-handoff,
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

```sh
npm install
npm test
npm run typecheck
```

- `npm test` runs the tests of every extension, both `.ts` and `.mjs`. The `rpc-subagents` tests that need an installed pi skip unless you set `RPC_SUBAGENTS_PI_PACKAGE` to a global pi install, for example `~/.local/pi-1.1.0/lib/node_modules/@earendil-works/pi-coding-agent`.
- `npm run typecheck` checks `ux` and `hooks` with `tsconfig.json`, and the other extensions with `tsconfig.extensions.json`. `ralph` and the `skill-name-normalizer` tests are not type-checked yet.
- `scripts/acceptance.sh` installs pi-extras from git into a throwaway home directory and checks what pi loads, with all extensions, with a settings filter, and after `pi config`.

pi supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox` to extensions, so `package.json` lists them as `"*"` peer dependencies. `croner` is the only runtime dependency.
