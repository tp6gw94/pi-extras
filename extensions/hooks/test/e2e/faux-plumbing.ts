import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("write", { path: "src/a.ts", content: "export const a   =  {x:1}\n" }),
				fauxToolCall("write", { path: "src/b.ts", content: "export function b(){return 2}\n" }),
				fauxToolCall("write", { path: "src/c.ts", content: "var unused = 1\n" }),
				fauxToolCall("write", { path: "app/m.py", content: "def f( x ):\n  return x\n" }),
				fauxToolCall("write", { path: "notes.md", content: "#  notes\n" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Wrote five files."),
		fauxAssistantMessage([fauxToolCall("write", { path: "src/c.ts", content: "export const used = 1;\n" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Fixed the lint error in src/c.ts."),
		...Array.from({ length: 10 }, () => fauxAssistantMessage("ok")),
	]);
	pi.registerProvider(faux.provider as never);
}
