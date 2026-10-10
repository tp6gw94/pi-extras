import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId } from "@earendil-works/pi-tui";
import { clipboardFailureMessage, readClipboard, type ExecFn } from "../ux-core/clipboard.ts";
import { CONFIG_FILE_NAME, KEY_ACTIONS, parseConfig, type UxConfig } from "../ux-core/config.ts";
import { lastUserPrompt, PromptPin } from "../ux-core/prompt-state.ts";
import { formatQuote } from "../ux-core/quote.ts";
import { collapsedLine, expandedLines } from "../ux-core/summary.ts";

export const WIDGET_KEY = "pi-ux:prompt";

function agentDir(): string {
	try {
		return getAgentDir();
	} catch {
		return join(homedir(), ".pi", "agent");
	}
}

/** Read `<agent-dir>/pi-ux.json` once at load. Shortcuts are registered at load time, so changes need `/reload`. */
function loadConfig(): { config: UxConfig; errors: string[]; path: string } {
	const path = join(agentDir(), CONFIG_FILE_NAME);
	let text: string | undefined;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		text = undefined;
	}
	return { ...parseConfig(text), path };
}

export default function piUx(pi: ExtensionAPI): void {
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
	const { config, errors, path: configPath } = loadConfig();
	const pin = new PromptPin();
	const toggleKey = config.keys.togglePrompt;

	// Two actions on one key: keep the first, disable the second.
	const used = new Map<string, string>();
	for (const action of KEY_ACTIONS) {
		const key = config.keys[action];
		if (!key) continue;
		const other = used.get(key);
		if (other) {
			errors.push(`keys.${action}: "${key}" is already used by ${other}; ${action} has no shortcut`);
			config.keys[action] = undefined;
		} else used.set(key, action);
	}

	function render(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const text = pin.text;
		if (text === undefined) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const expanded = pin.expanded;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) =>
				({
					render(width: number): string[] {
						if (!expanded) return [theme.fg("muted", collapsedLine(text, width))];
						const hint = toggleKey ? ` (${toggleKey} to collapse)` : "";
						return [
							theme.fg("dim", collapsedLine(`Last prompt${hint}`, width, "▾ ")),
							...expandedLines(text, width).map((l) => theme.fg("muted", l)),
						];
					},
					invalidate(): void {},
				}) satisfies Component,
			{ placement: "aboveEditor" },
		);
	}

	async function quoteClipboard(ctx: ExtensionContext): Promise<void> {
		const result = await readClipboard(exec, { cwd: ctx.cwd });
		if (!result.ok) {
			ctx.ui.notify(clipboardFailureMessage(result), "warning");
			return;
		}
		const quoted = formatQuote(result.text, ctx.ui.getEditorText());
		if (quoted === undefined) {
			ctx.ui.notify(`pi-ux: the clipboard is empty (read with ${result.tool}). Nothing inserted.`, "warning");
			return;
		}
		// pasteToEditor inserts at the cursor and keeps typed text. setEditorText would replace it.
		ctx.ui.pasteToEditor(quoted);
		// The paste lands after an async clipboard read, outside pi's key handling, so nothing
		// redraws the editor. Re-setting the widget is the public way to request a frame.
		render(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		if (errors.length > 0) ctx.ui.notify(`pi-ux: problems in ${configPath}:\n${errors.join("\n")}`, "warning");
		pin.restore(lastUserPrompt(ctx.sessionManager.getBranch()));
		render(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (pin.fromInput(event.text, event.source)) render(ctx);
		return { action: "continue" };
	});

	if (toggleKey) {
		pi.registerShortcut(toggleKey as KeyId, {
			description: "pi-ux: expand or collapse the pinned last prompt",
			handler: (ctx) => {
				if (pin.toggle() === undefined) {
					ctx.ui.notify("pi-ux: no prompt to show yet.", "info");
					return;
				}
				render(ctx);
			},
		});
	}

	if (config.keys.quoteClipboard) {
		pi.registerShortcut(config.keys.quoteClipboard as KeyId, {
			description: "pi-ux: insert the clipboard as a > quote at the cursor",
			handler: quoteClipboard,
		});
	}

	pi.registerCommand("quote", {
		description: "Insert the clipboard as a > quote into the editor",
		handler: async (_args, ctx) => quoteClipboard(ctx),
	});
}
