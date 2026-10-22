import { renameSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const file = process.env.ANNOTATE_EDITOR_PROBE;
	if (!file) return;
	let timer: NodeJS.Timeout | undefined;
	let seq = 0;
	pi.on("session_start", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			try {
				writeFileSync(`${file}.tmp`, JSON.stringify({ session: ctx.sessionManager.getSessionId(), seq: ++seq, editor: ctx.ui.getEditorText() }));
				renameSync(`${file}.tmp`, file);
			} catch {
				if (timer) clearInterval(timer);
			}
		}, 200);
		timer.unref();
	});
	pi.registerCommand("probe-set-editor", {
		description: "test: set the editor text to a JSON string argument",
		handler: async (args, ctx) => {
			const text = JSON.parse(args.trim());
			setTimeout(() => {
				try {
					ctx.ui.setEditorText(text);
				} catch {}
			}, 150);
		},
	});
	pi.registerCommand("probe-tree", {
		description: "test: move the session leaf to the last entry whose text contains the argument",
		handler: async (args, ctx) => {
			const needle = args.trim();
			const entry = ctx.sessionManager
				.getBranch()
				.filter((item) => item.type === "message" && JSON.stringify(item.message).includes(needle))
				.at(-1);
			if (!entry) {
				ctx.ui.notify(`probe-tree: no entry for ${needle}`, "error");
				return;
			}
			const result = await ctx.navigateTree(entry.id, { summarize: false });
			ctx.ui.notify(`probe-tree: ${result.cancelled ? "cancelled" : "moved"} to ${entry.id}`, "info");
		},
	});
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
	});
}
