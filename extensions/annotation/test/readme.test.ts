import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (name: string) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");

describe("annotation docs", () => {
	for (const name of ["README.md", "README.zh-TW.md"]) {
		it(`${name} documents the web flow and SSH forwarding`, () => {
			const text = read(name);
			const section = text.slice(text.indexOf("## Annotation"), text.indexOf("\n## ", text.indexOf("## Annotation") + 1));
			assert.ok(section.length > 500);
			for (const needle of ["/annotate", "/annotation-end", "127.0.0.1", "4747", "4756", "PI_ANNOTATE_PORT", "#t=<token>", "/<session id>", "ssh -L 4747:127.0.0.1:4747 <host>", "SSH_CONNECTION", "xdg-open", "X-Annotate-Token", "Send to pi editor", "/new", "/tree", "[paste #1]"]) {
				assert.ok(section.includes(needle), `${name}: ${needle}`);
			}
			assert.ok(text.includes("[Annotation](#annotation)"));
			assert.ok(!/alt\+q|\/quote\b|pbpaste|xclip/.test(text));
		});
	}
});
