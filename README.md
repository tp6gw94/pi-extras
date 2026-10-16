# pi-extras

[繁體中文](README.zh-TW.md)

pi-extras is one [pi](https://github.com/earendil-works/pi) package with eight extensions. You install it once, and pi loads every extension in it. You can turn single extensions off in pi's settings.

pi-extras is tested with `@earendil-works/pi-coding-agent` 1.0.4 and 1.1.0 on Node.js 22.

## Extensions

| Extension | What it does | Docs |
| --- | --- | --- |
| `annotation` | Opens a live view of the conversation in your browser with `/annotate`, where you quote parts of it with notes and append them to the editor; run `/annotate` again to stop it. | [Annotation](#annotation) |
| `hooks` | Formats each file after the agent writes it and lints changed files before the turn ends, from `.pi/hooks.json`. | [README](extensions/hooks/README.md) |
| `inline-skills` | Lets you pick a skill with `/` in the middle of a prompt and sends its path along with the prompt. | [README](extensions/inline-skills/README.md) |
| `ralph` | Runs a bounded loop of fresh pi sessions on one task with `/ralph`, and stops with `/ralph-stop`. | |
| `resume-handoff` | Starts a new session from a checked handoff file with `/resume-handoff`. | |
| `rpc-subagents` | Runs subagent tasks and schedules as `pi --mode rpc` child processes, with `/rpc-subagents` to list them. Children load your own extensions from settings (minus `rpc-subagents`, `annotation`, `ux` and `hooks`), so your providers work there too. Keeps its data and `config.json` in `~/.pi/agent/rpc-subagents/`. | [README](extensions/rpc-subagents/README.md) |
| `skill-name-normalizer` | Gives skills in `~/.pi/agent/skills` and `~/.agents/skills` a valid name when their own name is not one. | |
| `ux` | Pins your last prompt above the editor. | [README](extensions/ux/README.md) |

Each extension lives in `extensions/<name>/`, with its tests and any skills it ships.

## Annotation

`/annotate` opens the current conversation in a live browser page so you can quote parts of it with notes. It does not block pi; you can keep working while the page is open, and new messages show up on the page as they arrive.

1. Run `/annotate`. pi starts a small server for this session and prints a URL like `http://127.0.0.1:4747/<session id>#t=<token>`, then opens it with `open` on macOS or `xdg-open` on Linux. If the browser does not open, open the URL yourself.
2. The page shows your messages, the assistant's replies and tool outputs. Tool outputs are collapsed; click one to expand it. When a message is finished in pi, it is added to the page. Partial (still streaming) replies are not shown. If the conversation changes in another way, for example after `/tree` moves to another branch, the page reloads the whole conversation; items already in your list keep the text you quoted.
3. Select text. A note box appears next to the selection, and the selection stays highlighted. Type a note and press Enter to add the quote and note to the list on the right. Shift+Enter starts a new line, Esc discards.
4. Edit or delete items in the list.
5. Click **Send to pi editor**. pi appends every item to the end of the input box, in list order, as a `> quote` block, the note and a blank line. If the input box already has text that does not end with a newline, pi adds one first. The full text stays visible and editable in the input box (it is not collapsed into a `[paste #1]` marker). Nothing is sent to the model; you edit the text and send it yourself.
6. The page stays open and the list is cleared, so you can keep selecting and send again as often as you like.

`/annotate` is a toggle. If no server is running for this session, it starts one and opens the URL. If one is running, it stops it: pending requests end at once, the port is released and pi shows `annotate: closed, port <port> released`. Running `/annotate` again while the server is still starting also leaves it stopped. The server also stops when the session ends: `/new`, `/resume`, a fork, a reload, or quitting pi. There is no idle timeout. After a session switch, `/annotate` starts a new server for the new session, and the old tab says the session switched.

If you lose the URL, run `/annotate` twice: the first run stops the server and the second starts a new one with a new URL and token. Open tabs keep working only until the server stops; then they show **Server closed**, disable **Send to pi editor** and keep your unsent list, so you can copy it or switch to the new URL and add it again. The old token is rejected by the new server.

### Terminal view

`/annotate tui` starts the same server without opening a browser, so you can quote the conversation from another terminal or pane while you keep using pi. It prints where to attach:

```text
annotate: TUI session live on 127.0.0.1:4747
Attach from another terminal: '/your/pi-extras/extensions/annotation/bin/pi-annotation.ts' 019ee068-1f2c-7a3b-9c4d-6e5f...
Run /annotate again to stop it.
```

Copy the quoted command into the other terminal. The package ships the bin at `extensions/annotation/bin/pi-annotation.ts`, and pi does not put it on your `PATH`, so use the absolute path from the notice. The bin runs TypeScript directly, so it needs Node 22.6 or later. Give it the whole session id or a unique part of it; with no argument it attaches to the only live session, or to the only one whose working directory is the current one; `pi-annotation --list` lists the live sessions, and `pi-annotation --help` shows the usage.

The terminal view shows the same conversation as the browser page, with tool output folded by default and vim-like keys:

| Keys | Action |
| --- | --- |
| `h` `j` `k` `l`, arrow keys | Move; `j` and `k` move by screen row |
| `w` `b` `e` | Move by word |
| `0` `^` `$`, Home, End | Line start, first non-blank, line end |
| `gg` `G` | Start and end of the conversation |
| `{` `}` | Previous and next message |
| Ctrl-d, Ctrl-u | Half page |
| Ctrl-f, Ctrl-b, PageUp, PageDown | Full page |
| `v`, `V` | Start character or line selection; `o` swaps the ends; Esc leaves selection |
| `a` | Note on the selection, or on the line under the caret; on a message header, the whole message; on a diagram, the whole fence |
| `A` | Note on the whole message, folded tool output included |
| Enter, `za` | Fold or unfold the tool output under the caret, or switch a diagram to its source and back |
| `zR`, `zM` | Unfold or fold every tool output |
| `zz` | Center the caret |
| `/` | Search; `n` and `N` repeat forwards and backwards |
| Tab | Notes list: `j` and `k` move, Enter jumps to the source, `e` edits, `d` deletes, Tab/Esc/`q` goes back |
| Note box (after `a` or `A`) | Enter saves; Ctrl-J, or Shift+Enter where the terminal reports it, adds a line; Esc cancels |
| `s` | Send every note to the pi editor |
| `?` | Show the keys |
| `q` | Quit; press it twice to quit with unsent notes |

The keys take an optional count prefix, for example `3j` or `2}`. A note is a plain `> quote` block and the note text, exactly like the browser page, and **Send** appends every note to the pi editor without submitting it to the model. New messages arrive while the view is open and keep your notes, caret and selection. If the conversation moves to another branch, a selection whose message changed is dropped with a short notice. Running `/annotate tui` again prints the attach command without restarting the server; plain `/annotate` still opens the browser and stops the server, and a browser page and a terminal view can use the same server at the same time.

` ```mermaid ` blocks in your messages and the assistant's replies are drawn as Unicode text diagrams with `grok-mermaid`; flowcharts, state, class, ER and sequence diagrams all render. Enter or `za` on a diagram switches it to its source and back, and `a` quotes the whole fence, so the note carries the ` ```mermaid ` source. A diagram falls back to its source when `grok-mermaid` cannot draw it (an unsupported or invalid diagram), when it is wider than the pane, and when it reports warnings (flowcharts it only partly supports); the warning case keeps the source and adds one dim `Mermaid diagram not rendered: <first warning>` row, with ` (+N more)` when there is more than one warning. Narrowing the pane below the diagram width falls back to the source, and widening it draws the diagram again.

pi writes one record for the server under the agent directory, at `<agent dir>/annotation/sessions/<pi pid>.json`, with the port, the token and the pi process id. The directory is owner-only (`0700`) and each file is `0600`. The record is removed when the server stops and when pi exits, and records of pi processes that are no longer running are deleted on the next attach. The token is the same secret the browser URL carries, so treat it like a password.

### Markdown and diagrams

Your messages and the assistant's replies are shown as markdown: headings, paragraphs, bold, italic, strikethrough, inline code, lists (nested and numbered), blockquotes, tables, horizontal rules, links and code blocks. Code blocks keep their indentation, use a monospace font and show their language in the corner. Tool outputs stay collapsed plain text.

- Only `http`, `https` and `mailto` links become links; they open in a new tab with `rel="noopener noreferrer"`. Any other link is shown as its markdown text. Images are never loaded; the page shows `image: <alt text>` instead, as a link when the image URL is a safe link.
- The page builds the markdown with DOM nodes and never parses message text as HTML, so HTML in a message is shown as text.

` ```mermaid ` code blocks are drawn as diagrams with [mermaid](https://mermaid.js.org/). A diagram is drawn only when it scrolls into view, at most two at a time. Each one is drawn in its own sandboxed iframe (`sandbox="allow-scripts"`, without `allow-same-origin`) loaded from `/frame` on the same server; the page sends it the diagram source and the iframe answers only with its size. The iframe cannot reach the page, the token or the network: its Content Security Policy only allows scripts from the server and blocks requests, images and forms, and mermaid runs with `securityLevel: "strict"`. If a diagram cannot be drawn within 10 seconds, the page shows its source as a code block. `/frame` and `/frame/mermaid.js` need no token and contain no conversation text.

Quoting code and diagrams:

- A selection that starts and ends inside the same code block is quoted as a fenced code block with the block's language, for example ` ```ts `. A selection anywhere else is quoted as the visible text, without markdown syntax.
- Under each diagram, **Show source** switches between the diagram and its source. A selection in the source is quoted in a ` ```mermaid ` fence.
- **Quote whole diagram** opens the note box with the full diagram source in a ` ```mermaid ` fence as one quote.

The `mermaid` dependency makes the install bigger. The page only uses its 5.5 MB browser bundle (`mermaid/dist/mermaid.min.js`), and only inside the diagram iframes, but installing the package pulls about 117 packages, about 200 MB in `node_modules`.

### Port and URL

Each pi process runs its own server on `127.0.0.1` only. It uses port 4747, or the port in `PI_ANNOTATE_PORT` if you set it. If that port is busy, it tries the next nine ports (4748 to 4756 by default) and then a random free port. Several pi processes therefore get 4747, 4748 and so on.

The URL is `http://127.0.0.1:<port>/<session id>#t=<token>`. The token is in the fragment (after `#`), so the browser never sends it to the server in the URL; the page reads it, removes it from the address bar, and sends it in an `X-Annotate-Token` header with every request. The page also keeps the token in the tab's `sessionStorage`, keyed by session id, so reloading the tab keeps working; it is never put in `localStorage`, cookies, the URL or the history, and the sandboxed diagram iframes cannot read it. A new tab opened without the `#t=` part says it is not authorized. When the server no longer accepts the token (after `/annotate` stopped and restarted it, or pi restarted), the page removes it from `sessionStorage`, stops and says to open the new URL printed by `/annotate`. Treat the URL like a password: anyone who can reach the port with the token can put text into your editor (but cannot send it to the model).

### Over SSH

When pi runs over SSH (`SSH_CONNECTION` is set), it does not try to open a browser. It prints the URL and an `ssh -L` command. Forward the same port number from your own machine, then open the URL there:

```sh
ssh -L 4747:127.0.0.1:4747 <host>
```

The local port must be the same as the remote port, because the server only accepts requests whose `Host` is `127.0.0.1:<port>`. If pi picked another port (for example 4748), forward that one instead. You can run the `ssh -L` command in a second terminal while pi keeps running in the first one.

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
- The `annotation` tests cover the quote format, the conversation snapshot, the page script (content is rendered as text, never as HTML) and the HTTP server against a real local server (token, Host and session checks, send sequence numbers, long-poll live updates, port fallback). `extensions/annotation/test/e2e/tmux-annotate.sh` runs `/annotate` in a real pi under tmux with a fake model and checks the editor, live updates, `/tree`, stopping and restarting with `/annotate`, the page after the server closes, and session switches; set `PI_BIN` to the pi binary. The markdown tests cover each construct, inert XSS payloads and code-block quoting, and the server tests cover the `/frame` routes, their CSP and path traversal. The terminal view has tests for the document model and the reducer, the app shell against the real pi-tui library with a fake terminal, the session registry and `/annotate tui`; `extensions/annotation/test/e2e/herdr-tui.sh` runs pi and the bin in two herdr panes with the fake model and checks the note flow, live replies, quitting and stopping, and it needs `HERDR_ENV=1` (run it from inside herdr) and `PI_BIN`. `extensions/annotation/test/e2e/browser.mjs` drives the page in headless Chromium; it needs `playwright-core`, which is not a dependency of this package. `extensions/annotation/test/e2e/tmux-markdown.sh` runs pi with a markdown reply and drives `extensions/annotation/test/e2e/markdown.mjs`, which checks rendering, the diagram iframes, quoting, live updates, the timeout fallback, CSP violations and network requests; it needs `PI_BIN`, `PLAYWRIGHT_CORE` and `CHROME_BIN`.
- `scripts/acceptance.sh` installs pi-extras from git into a throwaway home directory and checks what pi loads, with all extensions, with a settings filter, and after `pi config`.

pi supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox` to extensions, so `package.json` lists them as `"*"` peer dependencies. The runtime dependencies are `croner` (for cron in `rpc-subagents`), `mermaid` (for the browser page's diagrams in `annotation`) and `grok-mermaid` (for the terminal view's text diagrams in `annotation`), all pinned to exact versions.
