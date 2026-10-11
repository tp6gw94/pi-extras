import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSnapshot } from "../snapshot.ts";

const message = (id: string, msg: Record<string, unknown>) => ({ type: "message", id, message: msg });

describe("conversation snapshot", () => {
	it("converts user, assistant and tool messages in branch order", () => {
		const branch = [
			{ type: "model_change", id: "m0" },
			message("u1", { role: "user", content: "read the config" }),
			message("a1", {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "Reading it." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/config.ts" } },
				],
			}),
			message("t1", { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "line 1\nline 2" }], isError: false }),
			message("t2", { role: "toolResult", toolCallId: "missing", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true }),
			message("a2", { role: "assistant", content: [{ type: "text", text: "Done." }] }),
		];
		const snapshot = buildSnapshot(branch, new Date("2026-10-11T08:00:00Z"));
		assert.equal(snapshot.takenAt, "2026-10-11T08:00:00.000Z");
		assert.deepEqual(snapshot.items, [
			{ id: "u1", kind: "user", label: "You", text: "read the config" },
			{ id: "a1", kind: "assistant", label: "Assistant", text: "Reading it." },
			{ id: "t1", kind: "tool", label: "Tool read src/config.ts · 2 lines", text: "line 1\nline 2" },
			{ id: "t2", kind: "tool", label: "Tool bash (error) · 1 line", text: "boom" },
			{ id: "a2", kind: "assistant", label: "Assistant", text: "Done." },
		]);
	});

	it("skips thinking-only and tool-call-only assistant messages and other roles", () => {
		const branch = [
			message("a1", { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "c", name: "ls", arguments: {} }] }),
			message("b1", { role: "bashExecution", command: "ls", output: "x" }),
			message("c1", { role: "custom", content: "hidden" }),
			message("s1", { role: "compactionSummary", summary: "sum" }),
			message("u1", { role: "user", content: "   " }),
		];
		assert.deepEqual(buildSnapshot(branch).items, []);
	});

	it("marks images and strips terminal control sequences", () => {
		const branch = [
			message("u1", { role: "user", content: [{ type: "text", text: "look \x1b[31mhere\x1b[0m" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }),
			message("t1", { role: "toolResult", toolCallId: "c", toolName: "bash\x1b[2J", content: "out\x07put\r\n" }),
		];
		const items = buildSnapshot(branch).items;
		assert.equal(items[0]!.text, "look here\n[image]");
		assert.equal(items[1]!.text, "output");
		assert.equal(items[1]!.label, "Tool bash · 1 line");
	});

	it("keeps markup-looking text as plain data", () => {
		const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
		const items = buildSnapshot([message("u1", { role: "user", content: payload })]).items;
		assert.equal(items[0]!.text, payload);
	});
});
