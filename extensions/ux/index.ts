import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId } from "@earendil-works/pi-tui";
import { CONFIG_FILE_NAME, obsoleteKeyNotice, parseConfig, type UxConfig } from "./core/config.ts";
import { lastUserPrompt, PromptPin } from "./core/prompt-state.ts";
import { collapsedLine, expandedLines } from "./core/summary.ts";

export const WIDGET_KEY = "pi-ux:prompt";

function agentDir(): string {
	try {
		return getAgentDir();
	} catch {
		return join(homedir(), ".pi", "agent");
	}
}

function loadConfig(): { config: UxConfig; errors: string[]; obsolete: string[]; path: string } {
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
	const { config, errors, obsolete, path: configPath } = loadConfig();
	const pin = new PromptPin();
	const toggleKey = config.keys.togglePrompt;
	let obsoleteNoticeShown = false;

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

	pi.on("session_start", (_event, ctx) => {
		if (errors.length > 0) ctx.ui.notify(`pi-ux: problems in ${configPath}:\n${errors.join("\n")}`, "warning");
		if (obsolete.length > 0 && !obsoleteNoticeShown) {
			obsoleteNoticeShown = true;
			ctx.ui.notify(obsoleteKeyNotice(obsolete), "warning");
		}
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
}
