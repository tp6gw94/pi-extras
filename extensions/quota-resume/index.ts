import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QuotaCapture } from "./capture.ts";
import { RecoveryActor } from "./recovery.ts";

const supportedProviderIds = new Set(["anthropic", "openai-codex", "opencode-go"]);

export default function quotaResume(pi: ExtensionAPI): void {
	const capture = new QuotaCapture();
	const recovery = new RecoveryActor(pi, capture);
	for (const provider of builtinProviders()) {
		if (!supportedProviderIds.has(provider.id)) continue;
		pi.registerProvider(capture.decorate(provider));
	}
	pi.on("session_start", (event, ctx) => recovery.open(ctx, event.reason === "fork"));
	pi.on("turn_end", event => recovery.turn(event));
	pi.on("agent_settled", (event, ctx) => recovery.settled(event.aborted, ctx));
	pi.on("session_compact", event => {
		if (event.reason === "manual") recovery.compacted();
	});
	pi.on("session_compact_failed", event => {
		if (event.reason === "manual") recovery.compacted();
	});
	pi.on("input", () => recovery.cancel());
	pi.on("before_agent_start", () => recovery.cancel());
	pi.on("user_bash", () => recovery.cancel());
	pi.on("session_before_switch", () => recovery.cancel());
	pi.on("session_before_fork", () => recovery.cancel());
	pi.on("session_before_tree", () => recovery.cancel());
	pi.on("session_tree", (_event, ctx) => recovery.open(ctx, true));
	pi.on("model_select", event => {
		if (event.source === "restore") return;
		const changedId = event.model.id !== event.previousModel?.id;
		const changedProvider = !changedId && event.model.provider !== event.previousModel?.provider;
		if (changedId || changedProvider) recovery.cancel();
	});
	pi.on("session_shutdown", event => {
		if (event.reason !== "quit" && event.reason !== "reload") recovery.cancel();
		recovery.release();
	});
	pi.registerCommand("quota-resume", {
		description: "Cancel automatic resume after a quota reset",
		handler: async (args, ctx) => {
			if (args.trim() !== "cancel") return ctx.ui.notify("Use /quota-resume cancel to cancel automatic resume.", "info");
			recovery.cancel();
			ctx.ui.notify("Automatic resume cancelled.", "info");
		},
	});
}
