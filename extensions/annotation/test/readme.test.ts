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
			for (const needle of ["/annotate", "127.0.0.1", "ssh -L 41234:127.0.0.1:41234 <host>", "SSH_CONNECTION", "xdg-open", "30", "Send to pi editor", "/new", "[paste #1]"]) {
				assert.ok(section.includes(needle), `${name}: ${needle}`);
			}
			assert.ok(text.includes("[Annotation](#annotation)"));
			assert.ok(!/alt\+q|\/quote\b|pbpaste|xclip/.test(text));
		});
	}
});
