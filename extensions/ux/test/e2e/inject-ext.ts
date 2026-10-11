import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("inject", {
		description: "test: send a user message from an extension",
		handler: async () => {
			pi.sendUserMessage("[injected by test extension] Reply with exactly: injected-ok");
		},
	});
}
