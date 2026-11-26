# Herdr annotation

Read and annotate the current Pi conversation in a native Herdr Desktop tab. The Herdr mod ships with `pi-extras`; installing the Pi extension alone does not install the mod or change your Herdr configuration.

## Install

You need Herdr Desktop with `herdr-app` on your `PATH` and a Node.js runtime with `node:sqlite` (Node 22.13 or newer).

Install `pi-extras` in Pi with `pi install git:github.com/tp6gw94/pi-extras` if it is not already installed. From the `pi-extras` checkout, install the bundled mod:

```sh
node extensions/annotation/bin/install-herdr-annotation.mjs
```

When installed as an npm package, the same installer is exposed as `pi-extras-install-herdr-annotation`.

The installer copies the mod to `$HERDR_APP_HOME/mods/pi-annotate/`, or to `~/.config/herdr-app/mods/pi-annotate/` if `HERDR_APP_HOME` is unset. It refuses to overwrite an existing file or directory. To replace a manually installed copy, back it up outside Herdr's `mods/` directory and run the installer again. The installer does not edit your layout or delete drafts or comments.

## Use

In a local Pi session in Herdr Desktop, run `/annotate-herdr`. Run the command again to return to the existing annotation tab. The tab follows the source session, not whichever Pi session happens to have focus. If it stays disconnected after restarting Pi, run `/annotate-herdr` in the source session and choose **Reconnect** in Herdr.

Click or focus the transcript and use `hjkl` to move, `Ctrl+D` and `Ctrl+U` to move half a page, and `gg` or `G` to jump to the start or end. Press `v` to select within a message, `c` to open a comment, and `Esc` to clear the selection. You can also drag to select rendered text and choose **Add comment**.

Use the right sidebar to choose where the message goes:

- **Main Pi** sends the free-text draft and this branch's pending comments as one message to the original session. It leaves the Pi editor untouched. If Pi is busy or the send cannot be confirmed, the drafts stay available.
- **Background threads** are separate, read-only Pi conversations. Start a thread from a comment or from free text. A reply continues that thread's own session. **Add to main Pi drafts** copies the original note and completed exchanges to a new pending draft, without changing the thread.

`Enter` saves without sending and `Shift+Enter` inserts a newline. On macOS, `Cmd+Enter` sends to main Pi and `Cmd+Shift+Enter` starts or replies to a background thread. Use `Ctrl` instead of `Cmd` on other platforms.

If a send is unconfirmed, use **Check previous send**. While the source can still deliver it, you can confirm it was sent if you see it, but you cannot mark it as not sent. **Check pending start** retries the original background start without replacing your newer draft.

Tool output starts collapsed and can be expanded without hiding any conversation messages.

## Upgrade from the legacy annotation views

The browser view, terminal attachment CLI, and fullscreen Pi annotation mode are no longer shipped. Use `/annotate-herdr` instead of `/annotate` or `/annotation-mode`. The Herdr review continues to use its existing per-session data paths.
