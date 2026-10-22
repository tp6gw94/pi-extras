import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

interface Armed {
	readonly ctx: ExtensionCommandContext;
	readonly needle: string;
}

export default function (pi: ExtensionAPI) {
	let armed: Armed | undefined;
	let unlisten: (() => void) | undefined;

	const evict = (ctx: ExtensionContext): void => {
		void ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const tick = setInterval(() => tui.requestRender(), 60);
			const timeout = setTimeout(() => done(undefined), 1200);
			return {
				render: () => [theme.fg("accent", "PROBE DIALOG")],
				invalidate: () => {},
				handleInput: () => {},
				dispose: () => {
					clearInterval(tick);
					clearTimeout(timeout);
				},
			};
		}, { overlay: false });
	};

	const go = (ctx: ExtensionCommandContext, needle: string): void => {
		ctx.ui.setStatus("probe-tree", undefined);
		const entry = ctx.sessionManager
			.getBranch()
			.filter((item) => item.type === "message" && JSON.stringify(item.message).includes(needle))
			.at(-1);
		if (!entry) {
			ctx.ui.notify(`probe-tree: no entry for ${needle}`, "error");
			return;
		}
		void ctx
			.navigateTree(entry.id, { summarize: false })
			.then((result) => ctx.ui.notify(`probe-tree: ${result.cancelled ? "cancelled" : "moved"} to ${entry.id}`, "info"))
			.catch((error: unknown) => ctx.ui.notify(`probe-tree: ${error instanceof Error ? error.message : String(error)}`, "error"));
	};

	pi.on("session_start", (_event, ctx) => {
		unlisten?.();
		unlisten = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, "ctrl+e")) {
				evict(ctx);
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+t")) {
				const target = armed;
				if (!target) return undefined;
				armed = undefined;
				go(target.ctx, target.needle);
				return { consume: true };
			}
			return undefined;
		});
	});

	pi.registerCommand("probe-arm-tree", {
		description: "test: arm ctrl+t to move the session leaf to the last entry whose text contains the argument",
		handler: async (args, ctx) => {
			armed = { ctx, needle: args.trim() };
			ctx.ui.setStatus("probe-tree", "armed");
		},
	});

	pi.on("session_shutdown", () => {
		unlisten?.();
		unlisten = undefined;
	});
}
