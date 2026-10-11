# pi-ux

[繁體中文](README.zh-TW.md)

pi-ux is a [pi](https://github.com/earendil-works/pi) extension that pins your last prompt. It shows the last prompt you sent on one line above the editor, so it stays in view while a long reply scrolls past. A shortcut expands it to the full text and collapses it again.

pi-ux used to quote the clipboard into the editor. Quoting moved to the [annotation](../../README.md#annotation) extension: run `/annotate`, select text from the conversation in your browser, add notes, and send them into the editor as quotes.

pi-ux is tested with `@earendil-works/pi-coding-agent` 1.0.4 on Node.js 22 in both the fullscreen and the regular terminal mode. It needs no config file.

## Install it as a pi package

pi-ux is one of the extensions in [pi-extras](../../README.md). To install pi-extras for every project, run:

```sh
pi install git:github.com/tp6gw94/pi-extras
```

To install it for the current project only, add `--local`. pi then writes the package to `.pi/settings.json`:

```sh
pi install --local git:github.com/tp6gw94/pi-extras
```

pi-extras loads all of its extensions by default. To turn some of them off, see [Turn an extension off](../../README.md#turn-an-extension-off).

To try pi-ux for one session without installing it, load the extension file from a clone of pi-extras:

```sh
pi --extension ./extensions/ux/index.ts
```

## Try it in 2 minutes

The output below comes from a real run with pi 1.0.4 in a 110-column tmux pane. The script `extensions/ux/test/e2e/tmux-verify.sh` repeats the run.

### Send a prompt

Type a prompt and press Enter. After the reply, the prompt sits above the editor. A prompt wider than the terminal ends with `…`:

```text
 60 water

❯ Write the numbers 1 to 60, one per line, each followed by a short English word. This prompt is deliberately…
──────────────────────────────────────────────────────────────────────────────────────────────────────────────

──────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

The pin stays in place while the agent works and after it answers. A message that another extension sends with `pi.sendUserMessage` does not replace it.

### Expand the pinned prompt

Press `alt+p`. The pin shows the full prompt, one line per line you typed, wrapped at the terminal width:

```text
▾ Last prompt (alt+p to collapse)
│ Write the numbers 1 to 60, one per line, each followed by a short English word. This prompt is deliberately
│ long so that the pinned summary has to be truncated at the terminal width with an ellipsis.
│ 第二行：請用英文回答，不要加任何解釋。
│ Third line: no code blocks.
```

Press `alt+p` again to go back to one line.

## Change the shortcuts

The default shortcut is:

| Action | Default key | Config key |
| --- | --- | --- |
| Expand or collapse the pinned prompt | `alt+p` | `togglePrompt` |

pi's own `keybindings.json` only maps pi's built-in actions, so pi-ux reads its shortcut from `~/.pi/agent/pi-ux.json`. If you set `PI_CODING_AGENT_DIR`, pi-ux reads `pi-ux.json` from that directory instead.

To move the toggle to `alt+o`, write:

<!-- example-config -->
```json
{
	"keys": {
		"togglePrompt": "alt+o"
	}
}
```

Then run `/reload` in pi, or restart it. pi-ux reads the file once when it loads.

Keys use pi's key syntax: zero or more of `ctrl`, `shift`, `alt` and `super`, joined with `+`, then one key, for example `ctrl+alt+p` or `f6`. pi checks each shortcut against its own keys when it loads extensions:

- A key that one of pi's core actions uses, such as `ctrl+c` or `ctrl+p`, stays with pi. pi skips the pi-ux shortcut and shows a warning at startup.
- Any other key that pi uses goes to pi-ux, and pi shows a warning at startup.

pi makes this check against its active keys, including your own `keybindings.json`.

On macOS and Linux, pi's defaults leave `alt+p` free. pi cycles to the previous model with `shift+ctrl+p`. pi switches to a Windows keybinding mode on native Windows, and on Linux under WSL when `WSL_DISTRO_NAME` or `WSL_INTEROP` is set. In that mode, pi binds `alt+p` to the previous model. `alt+p` is a core pi key there, so pi skips the pi-ux toggle shortcut. In the Windows keybinding mode, set another key in `~/.pi/agent/pi-ux.json`.

The defaults are `alt` chords because terminal multiplexers such as tmux and herdr use a `ctrl+b` prefix, and because legacy terminals send `alt+letter` as Escape followed by the letter, which pi understands. Chords such as `ctrl+shift+p` only reach pi in terminals that support the kitty keyboard protocol or a similar extended key mode.

## Config reference

`pi-ux.json` holds one JSON object. Every key is optional.

| Key | Type | Description |
| --- | --- | --- |
| `keys` | object | Shortcuts by action. A missing action keeps its default key. |

### `keys`

| Key | Default | Description |
| --- | --- | --- |
| `togglePrompt` | `alt+p` | Expands or collapses the pinned prompt. |

Set an action to `null` or `""` to turn off its shortcut.

pi-ux reports problems in the file as a warning when the session starts and keeps working:

- An invalid key falls back to the default key.
- An unknown setting is ignored.
- `quoteClipboard`, the key of the removed quote shortcut, is ignored. pi-ux says once that it is obsolete, and the other keys in the file still apply.

## How the pinned prompt works

pi-ux pins every prompt you send to the agent from the editor. Commands that pi or an extension handles itself, such as `/reload`, leave the pin as it is. Skill and prompt template commands go to the agent, so pi-ux pins them as you typed them. Text sent by RPC clients or other extensions does not replace the pin.

When you resume or continue a session, pi-ux reads the last user message on the current branch and pins it. pi-ux stores nothing of its own, so the session file is the only source. A new session starts with no pin.

## Jump to earlier prompts with pi

pi-ux does not navigate the transcript, because pi already does. In the default fullscreen mode, `ctrl+shift+up` and `ctrl+shift+down` jump to the previous and next prompt. In the regular mode (`--tui-mode regular`), pi marks each message with OSC 133 escape codes, so a terminal that supports them can jump between prompts with its own keys.

## Limitations

- On macOS, `alt` shortcuts need the terminal to send Option as Meta. In Terminal.app, turn on "Use Option as Meta key". In iTerm2, set the Option key to "Esc+". Otherwise, Option types a special character, such as `π`.
- In pi's Windows keybinding mode, native Windows and WSL, the default key collides with pi. See [Change the shortcuts](#change-the-shortcuts) and set another key in `~/.pi/agent/pi-ux.json`.
- After a resume, pi-ux pins the last user message in the session. pi does not record where a message came from, so a user message sent by another extension can show up there.
- After a resume, a skill or prompt template shows its expanded text instead of the command you typed.

## Development

Run these from the pi-extras root:

```sh
npm install
npm test
npm run typecheck
```

`npm test` runs the tests of every pi-extras extension, including the pi-ux unit tests and README checks. `extensions/ux/test/e2e/tmux-verify.sh` drives a real pi session in tmux and needs a logged-in model and `tmux`. It saves the captured panes in `/tmp/pi-ux-ev`.
