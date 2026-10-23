# pi-annotation

[繁體中文](README.zh-TW.md)

pi-annotation is a [pi](https://github.com/earendil-works/pi) extension for quoting parts of the current conversation with notes. Run `/annotate` to start a server for the session, or `/annotation-mode` to quote the transcript inside pi's fullscreen TUI without a server. `/annotate` prints one notice with the browser URL and the terminal attach command.

You can send saved annotations in two ways:

- The browser's **Send to pi editor** button and the terminal key `s` append them to the pi editor. You review the text and send it yourself.
- The terminal key `S` submits them to pi directly. Your editor draft stays as it is.

pi-annotation does not block pi. You can keep working while the page or the terminal view is open. Each new message appears there when pi finishes it.

## Install it as a pi package

pi-annotation is one of the extensions in [pi-extras](../../README.md). To install pi-extras for every project, run:

```sh
pi install git:github.com/tp6gw94/pi-extras
```

To install it for the current project only, add `--local`. pi then writes the package to `.pi/settings.json`:

```sh
pi install --local git:github.com/tp6gw94/pi-extras
```

pi-extras loads all of its extensions by default. To turn some of them off, see [Turn an extension off](../../README.md#turn-an-extension-off).

To try pi-annotation for one session without installing it, run `npm install` in a clone of pi-extras, then load the extension file from the clone:

```sh
pi --extension ./extensions/annotation/index.ts
```

## Quote the conversation in your browser

1. Run `/annotate`. pi starts a small server for this session and prints a notice with a URL like `http://127.0.0.1:4747/<session id>#t=<token>` and the command to attach the terminal view. pi does not open the browser. Open the printed URL yourself.
2. Read the conversation on the page. The page shows your messages, the assistant's replies, and tool outputs. Tool outputs are collapsed. Click one to expand it. pi adds each message to the page when the message is finished, so the page does not show a reply that is still streaming. If the conversation changes in another way, for example after `/tree` moves to another branch, the page reloads the whole conversation. Items already in your list keep the text you quoted.
3. Select text. A note box appears next to the selection, and the selection stays highlighted. Type a note and press Enter to add the quote and the note to the list on the right. Shift+Enter starts a new line. Esc discards the note.
4. Edit or delete items in the list.
5. Click **Send to pi editor**. pi appends every item to the end of the input box in list order. Each item is a `> quote` block, the note, and a blank line. If the text already in the input box does not end with a newline, pi adds one first. The full text stays visible and editable in the input box. pi does not collapse it into a `[paste #1]` marker.
6. Keep quoting. The page stays open with an empty list, so you can select and send again as often as you like.

### Stop the server with `/annotate`

`/annotate` is a toggle. If no server is running for this session, `/annotate` starts one and prints the notice. If a server is running, `/annotate` stops it. Pending requests end at once, pi releases the port, and pi shows `annotate: closed, port <port> released`. If you run `/annotate` while the server is still starting, the server also ends up stopped.

The server also stops when the session ends: `/new`, `/resume`, a fork, a reload, or quitting pi. The clients then say that the session switched. The server has no idle timeout.

`/resume-handoff` is the exception. The server stays on the same port, pi prints the new URL and the terminal command, and attached terminal views and open browser tabs follow the new session with their unsent notes.

### Get a new URL

If you lose the URL, run `/annotate` twice. The first run stops the server, and the second run starts a new server with a new URL and token. The new server rejects the old token.

An open tab works only until its server stops. After that, the tab shows **Server closed**, disables **Send to pi editor**, and keeps your unsent list. Copy the list, or open the new URL and add the items again.

## Quote the conversation from a terminal

The same `/annotate` server serves the terminal view. You can quote the conversation from another terminal or pane while you keep using pi. The notice prints the command to attach:

```text
annotate: live on 127.0.0.1:4747
Browser: http://127.0.0.1:4747/<session id>#t=<token>
Terminal: '/your/pi-extras/extensions/annotation/bin/pi-annotation.ts' 019ee068-1f2c-7a3b-9c4d-6e5f...
Run /annotate again to stop it.
```

Copy the full command after `Terminal:` into another terminal and run it. The bin is at `extensions/annotation/bin/pi-annotation.ts`. pi does not put the bin on your `PATH`, so always run it by the quoted absolute path from the notice. The bin runs TypeScript directly, so it needs Node 22.6 or later.

In this table, `pi-annotation` stands for the quoted absolute path from the notice:

| Command | Result |
| --- | --- |
| `pi-annotation` | Attaches to the only live session, or to the only live session whose working directory is the current directory. |
| `pi-annotation <session id part>` | Attaches to the session whose id contains that unique part. The notice prints this form with the whole id. |
| `pi-annotation --interactive` | Selects a live session in this exact working directory. |
| `pi-annotation --list` | Lists the live sessions. |
| `pi-annotation --help` | Shows the usage. |

To select a session in this directory, add `--interactive` to the path from the notice. Replace the example path below with that path:

```sh
'/your/pi-extras/extensions/annotation/bin/pi-annotation.ts' --interactive
```

Use the arrow keys to move, and press Enter to attach. To cancel without attaching, press Esc or Ctrl-C.

`--interactive` offers only live sessions whose working directory is exactly the current directory. If one session matches, the bin attaches to it without a menu. If no session matches, the bin tells you to run `/annotate` in pi first.

`--interactive` needs a TTY on both stdin and stdout.

`--help` takes precedence over `--list`, and `--list` takes precedence over `--interactive`. The bin rejects any other argument combined with `--interactive`, including a session id.

A browser page and a terminal view can use the same server at the same time.

### Move and quote with vim-like keys

The terminal view shows the same conversation as the browser page. Tool output is folded by default. These are the keys:

| Keys | Action |
| --- | --- |
| `h` `j` `k` `l`, arrow keys | Move. `j` and `k` move by screen row. |
| `w` `b` `e` | Move by word |
| `0` `^` `$`, Home, End | Line start, first non-blank, line end |
| `gg` `G` | Start and end of the conversation |
| `{` `}` | Previous and next message |
| Ctrl-d, Ctrl-u | Half page |
| Ctrl-f, Ctrl-b, PageUp, PageDown | Full page |
| `v`, `V` | Start a character or line selection. `o` swaps the ends. Esc leaves the selection. |
| `a` | Note on the selection, or on the line under the caret. On a message header, the note covers the whole message. On a diagram, it covers the whole fence. |
| `A` | Note on the whole message, folded tool output included |
| Enter, `za` | Fold or unfold the tool output under the caret, or switch a diagram to its source and back |
| `zR`, `zM` | Unfold or fold every tool output |
| `zz` | Center the caret |
| `/` | Search. `n` and `N` repeat forwards and backwards. |
| Tab | Open the notes list. In the list, `j` and `k` move, Enter jumps to the source, `e` edits, `d` deletes, and Tab, Esc, or `q` goes back. |
| Note box (after `a` or `A`) | Enter saves. Ctrl-J, or Shift+Enter where the terminal reports it, adds a line. Esc cancels. |
| `s` | Append every saved note to the pi editor |
| `S` | Submit every saved note to pi as a new user message |
| `?` | Show the keys |
| `q` | Quit. If you have unsent notes, press it twice. |

The keys take an optional count prefix, for example `3j` or `2}`.

New messages arrive while the view is open. Your notes, caret, and selection stay. If the conversation moves to another branch and the message under a selection changed, the view drops the selection and shows a short notice.

### Send notes with `s` or `S`

A note is a plain `> quote` block and the note text, the same as on the browser page. Both keys send every note saved when you press the key.

- To review the notes before pi sees them, press `s`. The view appends the notes to the pi editor and does not start a model turn.
- To submit the notes directly to pi, press `S`. pi receives only the annotation text as a new user message, and your editor draft stays as it is. If pi is busy, the message waits as a `followUp` and does not steer the current work.

While a send is in progress, the view ignores another `s` or `S`. If another client sends first, the view keeps your notes and asks you to press `s` or `S` again.

After `S`, the view clears the sent notes when the synchronous SDK call succeeds. That success does not confirm that pi later schedules or completes the turn.

A transport error or a synchronous submission failure keeps the notes. If the response is lost, the notes can stay in the view after pi received them. Check pi before you send them again.

### Read markdown with its syntax

The terminal view shows your messages and the assistant's replies as markdown source and colors it. Every `#`, `**`, backtick, `>`, `-`, and `|` stays on screen, so a selection quotes the exact source. The view dims the syntax characters and colors the text they mark:

| Markdown | Look |
| --- | --- |
| Headings | `#` dim. Level 1 is bold magenta, level 2 bold blue, and level 3 and deeper bold. |
| `**bold**`, `*italic*`, `~~strike~~` | Markers dim. Text bold, italic, or struck through. |
| `` `code` `` and code blocks | Backticks and fence lines dim. Code yellow, in one color for every language. |
| Links | Brackets and parentheses dim. Link text blue, URL dim. |
| Lists and blockquotes | `-`, `1.`, `[ ]`, and `>` cyan. Quote text dim italic. |
| Tables and rules | Pipes, delimiter rows, and `---` dim. |
| Escapes such as `\*` | Backslash dim. The escaped character keeps the color around it. |

The colors come from the terminal's 16-color palette, so they follow your terminal theme. Markdown never uses underline or a background color, because underline marks a note, a blue background marks the selection, and reverse video marks the caret. Tool output stays plain text. A code block that never closes gets no code color, and the view colors its lines as ordinary markdown. ` ```mermaid ` blocks become diagrams, as the next section describes.

### Read diagrams as text

The terminal view draws ` ```mermaid ` blocks in your messages and the assistant's replies as Unicode text diagrams with `grok-mermaid`. Flowcharts, state, class, ER, and sequence diagrams all render. Enter or `za` on a diagram switches it to its source and back. `a` on a diagram quotes the whole fence, so the note carries the ` ```mermaid ` source.

A diagram falls back to its source in three cases:

- `grok-mermaid` cannot draw it, because the diagram is unsupported or invalid.
- The diagram is wider than the pane.
- `grok-mermaid` reports warnings, which happens with flowcharts that it only partly supports. The view then adds one dim `Mermaid diagram not rendered: <first warning>` row below the source, with ` (+N more)` when there is more than one warning.

If you narrow the pane below the diagram width, the view shows the source. If you widen it again, the view draws the diagram again.

### Keep the session record private

pi writes one record for the server under the agent directory, at `<agent dir>/annotation/sessions/<pi pid>.json`. The record holds the port, the token, and the pi process id. The directory is owner-only (`0700`), and each file is `0600`. pi removes the record when the server stops and when pi exits. When the bin attaches or lists sessions, it deletes the records of pi processes that are no longer running. The token is the same secret that the browser URL carries, so treat it like a password.

## Markdown and diagrams in the browser

The page shows your messages and the assistant's replies as markdown: headings, paragraphs, bold, italic, strikethrough, inline code, lists (nested and numbered), blockquotes, tables, horizontal rules, links, and code blocks. Code blocks keep their indentation, use a monospace font, and show their language in the corner. Tool outputs stay collapsed plain text.

- Only `http`, `https`, and `mailto` links become links. They open in a new tab with `rel="noopener noreferrer"`. The page shows any other link as its markdown text.
- The page never loads images. It shows `image: <alt text>` instead, as a link when the image URL is a safe link.
- The page builds the markdown with DOM nodes and never parses message text as HTML, so HTML in a message shows as text.

The page draws ` ```mermaid ` code blocks as diagrams with [mermaid](https://mermaid.js.org/). It draws a diagram only when the diagram scrolls into view, and at most two at a time. Each diagram is drawn in its own sandboxed iframe (`sandbox="allow-scripts"`, without `allow-same-origin`), which loads from `/frame` on the same server. The page sends the iframe the diagram source, and the iframe answers only with its size.

The iframe cannot reach the page, the token, or the network. Its Content Security Policy allows scripts from the server only and blocks requests, images, and forms. mermaid runs with `securityLevel: "strict"`. If the iframe cannot draw a diagram within 10 seconds, the page shows the diagram source as a code block. `/frame` and `/frame/mermaid.js` need no token and contain no conversation text.

### Quote code and diagrams

- If a selection starts and ends inside the same code block, the quote is a fenced code block with the block's language, for example ` ```ts `. A selection anywhere else is quoted as the visible text, without markdown syntax.
- **Show source** under each diagram switches between the diagram and its source. A selection in the source is quoted in a ` ```mermaid ` fence.
- **Quote whole diagram** opens the note box with the full diagram source in a ` ```mermaid ` fence as one quote.

### Install size of mermaid

The `mermaid` dependency makes the install bigger. The page uses only the 5.5 MB browser bundle (`mermaid/dist/mermaid.min.js`), and only inside the diagram iframes. Installing the package still pulls about 117 packages, about 200 MB in `node_modules`.

## Port and URL

Each pi process runs its own server on `127.0.0.1` only. The server uses port 4747, or the port in `PI_ANNOTATE_PORT` if you set it. If that port is busy, the server tries the next nine ports (4748 to 4756 by default) and then a random free port. Several pi processes therefore get 4747, 4748, and so on.

The URL is `http://127.0.0.1:<port>/<session id>#t=<token>`. The token is in the fragment, after `#`, so the browser never sends it to the server in the URL. The page reads the token, removes it from the address bar, and sends it in an `X-Annotate-Token` header with every request.

The page also keeps the token in the tab's `sessionStorage`, keyed by session id, so a reload of the tab keeps working. The page never puts the token in `localStorage`, cookies, the URL, or the history, and the sandboxed diagram iframes cannot read it. A new tab opened without the `#t=` part says that it is not authorized.

The server stops accepting the token after `/annotate` stops and restarts it, or after pi restarts. When that happens, the page removes the token from `sessionStorage`, stops, and tells you to open the new URL that `/annotate` printed.

Treat the URL like a password. Anyone who can reach the port with the token can put text into your editor or submit arbitrary prompts to pi. These prompts start an agent turn that may run tools, including shell commands, without your confirmation.

## Use it over SSH

When pi runs over SSH (`SSH_CONNECTION` is set), the notice also prints an `ssh -L` command. Forward the same port number from your own machine, then open the URL there:

```sh
ssh -L 4747:127.0.0.1:4747 <host>
```

The local port must be the same as the remote port, because the server accepts only requests whose `Host` is `127.0.0.1:<port>`. If pi picked another port, for example 4748, forward that port instead. You can run the `ssh -L` command in a second terminal while pi keeps running in the first one.

## Quote the conversation in fullscreen mode

Run `/annotation-mode` to quote the transcript inside pi's fullscreen TUI, or press Ctrl-Shift-A. The mode needs no server, port, or browser, so it works without `/annotate`. When you leave the mode with `q`, `s`, or `S`, or when the mode refuses to open, a large paste in the draft comes back as its full text.

The shortcut needs a terminal that reports Ctrl-Shift-A separately from Ctrl-A, for example through the kitty keyboard protocol or xterm modifyOtherKeys. Inside tmux, tmux must forward extended keys. The [pi tmux guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tmux.md) covers the settings. If your terminal cannot report the key separately, use `/annotation-mode`.

The mode quotes the text pi draws on screen, not the message source. pi's Markdown renderer drops the bold markers, but other syntax can remain: code fences, heading prefixes, and list markers are quoted when pi shows them. A link is whatever text pi visibly renders; with OSC 8 support the URL can be hidden, but under tmux pi shows `the docs (https://example.com/cache)`.

The mode works in fullscreen mode only. In regular mode, `/annotation-mode` prints `annotation-mode: needs fullscreen mode` and does nothing.

The dock replaces the editor. Its status line shows the mode, an optional count, the caret row and terminal column (both start at 1), the note count, and `working` while pi runs a turn. Automatic following is paused and the jump-to-latest indicator is hidden during the mode so it cannot cover selectable text; both return to normal behavior when the mode closes.

### Move and select with vim-like keys

| Keys | Action |
| --- | --- |
| `h` `j` `k` `l`, arrow keys | Move by character or screen row |
| `w` `b` `e` | Move by word |
| `0` `^` `$`, Home, End | Row start, first non-blank, row end |
| `gg` `G` | Start and end of the transcript |
| `{` `}` | Previous and next message |
| Ctrl-d, Ctrl-u | Half page |
| Ctrl-f, Ctrl-b | Move the caret down or up a page |
| PageUp, PageDown | Scroll the viewport; the caret stays until the next motion reveals it |
| `v`, `V` | Start a character or line selection |
| `o` | Swap the selection ends |
| Esc, `q` | Leave the selection |
| `a` | Note on the selection, or on the row under the caret |
| `A` | Note on the whole message |
| Tab | Open the notes list. In the list, `j` and `k` move, `e` edits, `d` deletes, and Tab, Esc, or `q` goes back. |
| `?` | Show the keys. In help, `j` and `k` scroll, and Esc, `?`, or `q` closes it. |
| `s` | Append the notes to the editor and leave the mode |
| `S` | Submit the notes to pi and leave the mode |
| `q`, Esc, Ctrl-C | Leave the mode. With unsent notes, press again. |

Keys take a count prefix, for example `3j` or `2}`. The mode does not implement folds, search, or caret centering.

### What a quote contains

The quote contains the visible characters between the endpoints. The mode drops trailing spaces and blank rows at the edges. Rows selected from their first character lose their common leading whitespace. That removes indentation pi adds, and it can also remove indentation that the actual code shares. A selection that starts in the middle of a row keeps that row unchanged. Blockquote bars and list markers are visible characters, so the quote includes them.

Bold text is quoted as its text, without `**`. A link is quoted as pi draws it; under tmux that includes the URL in parentheses, and with OSC 8 support the URL can be hidden. If every selected row is inside one fenced code block, the quote is a fenced block with that block's language. The fence uses more backticks when the code contains a run of backticks. The code is the visible code with the common indentation removed.

The fence scan reads rendered rows. A fence that pi draws on the same row as a list marker is not detected, so a selection there is quoted as plain text. An unclosed fence runs to the end of the message.

Each grapheme, including a CJK character or an emoji, counts as one character. Movement uses the measured terminal cell width of each grapheme, so wide glyphs take two cells and other glyphs take their measured width. The status line reports the terminal column.

### Save, edit, and send notes

Press `a` or `A`, type the note, and press Enter. Ctrl-J adds a line. Esc or Ctrl-C cancels the note. A note with no text quotes the text and adds no note line.

Tab lists the notes. `e` opens the note with its saved text, `d` deletes it, and `j` or `k` selects another note. In the list, `s` and `S` send every note too.

`s` appends every saved note to the pi editor and leaves the mode. It does not start a model turn. The text goes after the current draft, in the `> quote` format that `/annotate` uses. `S` sends every saved note to pi as a new user message and leaves the mode. It uses `followUp`, so the notes wait when pi is busy, and your editor draft stays as it is. After `s`, a successful editor update removes the notes; a synchronous editor error keeps them and shows an error.

For `S`, `pi.sendUserMessage` returns `void`: only synchronous call acceptance is known. The mode clears the notes when that call returns without throwing, not when pi later schedules or delivers the message. A synchronous call failure keeps the notes and shows an error. Later asynchronous errors are reported by pi outside the caller, so the mode cannot restore the cleared notes. Use `s` to review and keep the text in the editor before submitting.

Unsent notes stay in memory for the pi session. `q` with unsent notes asks for a second press, and running `/annotation-mode` again shows the notes. They do not survive `/reload`, a new session, or a pi restart.

### Leave the mode

The quit keys depend on where the caret is.

- In the transcript, `q`, Esc, and Ctrl-C leave the mode. With unsent notes, each of them asks for a second press.
- In a selection, `q` and Esc return to the transcript. Ctrl-C leaves the mode, with the unsent note question.
- In the note editor, `q` types `q`. Esc and Ctrl-C cancel the note and keep the notes you saved.
- In the notes list, Tab, Esc, and `q` return to the transcript. Ctrl-C leaves the mode, with the unsent note question.
- In help, Esc, `q`, and `?` close help. Ctrl-C leaves the mode, with the unsent note question.

Leaving the mode restores the pi editor, its draft, and Ctrl-C.

### Conversation changes and terminal limits

A reply that streams while the mode is open does not move the caret or the viewport. Use `j`, `k`, or `G` to go to the new text.

`/tree`, compaction, and other rebuilds can change the rendered rows. If the message under a selection changes, the mode drops the selection and shows a notice. Notes stay. A note underline appears only while the quoted characters still match their place. After a reflow or rebuild changes them, the underline disappears and the note stays in the list.

The dock uses at most the bottom third of the terminal. Make the terminal taller to see more lines of a long note.

The mode paints only in fullscreen. Leaving fullscreen closes it, and the transcript pi prints on exit has no caret or selection. If another dialog takes the editor slot, the mode closes without a notice and the notes stay in memory.

On Windows and WSL, pi binds Ctrl-F to its fullscreen search and handles the key before the mode. Use PageDown and PageUp to scroll the viewport there. They can leave the caret where it was; the next motion reveals it.

## Development

Run these from the pi-extras root:

```sh
npm install
npm run typecheck
npm test
```

`npm test` runs the tests of every pi-extras extension. The pi-annotation tests cover these parts:

- The quote format, the conversation snapshot, and the page script. The page script tests check that content is rendered as text, never as HTML.
- The HTTP server against a real local server: token, Host, and session checks, send sequence numbers, long-poll live updates, and port fallback. The server tests also cover the `/frame` routes, their CSP, and path traversal.
- Markdown: each construct, inert XSS payloads, and code-block quoting.
- The terminal view: the document model and the reducer, the app shell against the real pi-tui library with a fake terminal, the session registry, and the `/annotate` command.

The end-to-end scripts run a real pi with a fake model. `PI_BIN` is the directory that contains the `pi` executable, not the executable itself. The shell scripts require `PI_BIN`. `direct-send.py` uses the directory of `pi` on your `PATH` when `PI_BIN` is not set.

- `PI_BIN="$(dirname "$(command -v pi)")" python3 extensions/annotation/test/e2e/direct-send.py --evidence /tmp` checks `s`, `S`, busy follow-up ordering, interactive selection, cancellation, and terminal restoration. It creates an isolated home, project, registry, local provider, and tmux socket. It keeps the evidence in a new directory under the `--evidence` directory, or under `EVIDENCE_DIR`.
- `extensions/annotation/test/e2e/tmux-annotation-mode.sh` runs `/annotation-mode` under tmux with a fake model. It checks entry, the Ctrl-Shift-A shortcut, keys, notes, `s` and `S`, code quoting, streaming, resize, another dialog taking the editor, a session rebuild, regular-mode refusal, and the exit transcript.
- `extensions/annotation/test/e2e/tmux-annotate.sh` runs `/annotate` under tmux. It checks the editor, live updates, `/tree`, stopping and restarting with `/annotate`, the page after the server closes, and session switches.
- `extensions/annotation/test/e2e/tmux-handoff.sh` runs pi with annotation and resume-handoff under tmux. It checks that terminal views and browser tabs follow a handoff, keep their notes, and send to the new session. Set `DRIVER=browser` with `PLAYWRIGHT_CORE` and `CHROME_BIN` to run the browser checks.
- `extensions/annotation/test/e2e/herdr-tui.sh` runs pi and the bin in two herdr panes. It checks the note flow, live replies, quitting, and stopping. It also needs `HERDR_ENV=1`, so run it from inside herdr.
- `extensions/annotation/test/e2e/tmux-markdown.sh` runs pi with a markdown reply and drives `extensions/annotation/test/e2e/markdown.mjs`. The script checks rendering, the diagram iframes, quoting, live updates, the timeout fallback, CSP violations, and network requests. It also needs `PLAYWRIGHT_CORE` and `CHROME_BIN`.

`extensions/annotation/test/e2e/browser.mjs` drives the page in headless Chromium. It needs `playwright-core`, which is not a dependency of pi-extras.
