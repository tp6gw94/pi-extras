import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readRoot = (name: string) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");

function headingLevels(text: string): number[] {
	const withoutFences = text.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
	return [...withoutFences.matchAll(/^(#{1,6}) /gm)].map((m) => m[1]!.length);
}

const readmes = [
	{ file: "README.md", other: "README.zh-TW.md" },
	{ file: "README.zh-TW.md", other: "README.md" },
] as const;

describe("annotation docs", () => {
	for (const { file, other } of readmes) {
		it(`${file} documents the web flow, the terminal view and SSH forwarding`, () => {
			const text = read(file);
			for (const needle of ["/annotate", "/annotate tui", "pi-annotation --list", "annotate: closed, port <port> released", "Server closed", "127.0.0.1", "4747", "4756", "PI_ANNOTATE_PORT", "#t=<token>", "/<session id>", "ssh -L 4747:127.0.0.1:4747 <host>", "SSH_CONNECTION", "xdg-open", "X-Annotate-Token", "Send to pi editor", "/new", "/tree", "[paste #1]", "Show source", "Quote whole diagram", "```mermaid", "/frame", "allow-scripts", "securityLevel: \"strict\"", "5.5 MB", "grok-mermaid"]) {
				assert.ok(text.includes(needle), `${file}: ${needle}`);
			}
			assert.ok(!/alt\+q|\/quote\b|pbpaste|xclip/.test(text));
			assert.ok(!text.includes("/annotation-end"));
			assert.ok(text.includes(`](${other})`));
		});

		it(`the root ${file} links here instead of repeating the docs`, () => {
			const text = readRoot(file);
			assert.ok(!text.includes("## Annotation"));
			assert.ok(!text.includes("X-Annotate-Token"));
		});
	}

	it("translations correspond section by section", () => {
		assert.deepEqual(headingLevels(read("README.md")), headingLevels(read("README.zh-TW.md")));
	});
});
