import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function observe(pi: ExtensionAPI): void {
	const path = process.env.HANDOFF_E2E_EVENTS!;
	pi.on("session_start", (_event, ctx) => {
		appendFileSync(path, `${JSON.stringify({ type: "start", session: ctx.sessionManager.getSessionFile() })}\n`);
	});
	pi.on("agent_settled", (event, ctx) => {
		appendFileSync(path, `${JSON.stringify({ type: "settled", session: ctx.sessionManager.getSessionFile(), aborted: event.aborted })}\n`);
	});
	pi.on("ui_prompt_start", (event) => {
		appendFileSync(path, `${JSON.stringify({ type: "dialog", kind: event.kind })}\n`);
	});
}
