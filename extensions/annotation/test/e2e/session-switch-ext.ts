import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("new-later", {
		description: "test: start a new session after N seconds, e.g. while the annotation box is open",
		handler: async (args, ctx) => {
			const seconds = Number(args.trim()) || 3;
			setTimeout(() => void ctx.newSession(), seconds * 1000);
		},
	});
}
