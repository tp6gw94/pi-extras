import { renameSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const file = process.env.ANNOTATE_EDITOR_PROBE;
	if (!file) return;
	let timer: NodeJS.Timeout | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			try {
				writeFileSync(`${file}.tmp`, JSON.stringify({ session: ctx.sessionManager.getSessionId(), editor: ctx.ui.getEditorText() }));
				renameSync(`${file}.tmp`, file);
			} catch {
				if (timer) clearInterval(timer);
			}
		}, 200);
		timer.unref();
	});
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
	});
}
