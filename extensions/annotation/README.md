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

- Select text in the transcript and choose **Add comment**. On a pointer selection, the editor opens by the selected text. **Cmd+Enter** (**Ctrl+Enter** on other platforms) saves the comment without sending anything to Pi.
- **Put in original Pi input** appends selected quotes and pending comments to the original session's editor. It does not submit that input.
- **Send to background Pi** opens a separate read-only Pi thread for a saved comment. A reply runs in that thread, not the original session.

Tool output starts collapsed and can be expanded without hiding any conversation messages. Saved comments remain available in the sidebar.

## Upgrade from the legacy annotation views

The browser view, terminal attachment CLI, and fullscreen Pi annotation mode are no longer shipped. Use `/annotate-herdr` instead of `/annotate` or `/annotation-mode`. The Herdr review continues to use its existing per-session data paths.
