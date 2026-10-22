import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyOf, namedKeys } from "../mode/keys.ts";
import { bindings } from "../mode/state.ts";

describe("keyOf", () => {
	it("decodes the named keys from legacy and kitty sequences", () => {
		assert.equal(keyOf("\x04"), "ctrl+d");
		assert.equal(keyOf("\x1b[100;5u"), "ctrl+d");
		assert.equal(keyOf("\x15"), "ctrl+u");
		assert.equal(keyOf("\x06"), "ctrl+f");
		assert.equal(keyOf("\x02"), "ctrl+b");
		assert.equal(keyOf("\x1b"), "escape");
		assert.equal(keyOf("\x1b[27u"), "escape");
		assert.equal(keyOf("\t"), "tab");
		assert.equal(keyOf("\r"), "enter");
		assert.equal(keyOf("\x1b[5~"), "pageUp");
		assert.equal(keyOf("\x1b[6~"), "pageDown");
		assert.equal(keyOf("\x1b[A"), "up");
		assert.equal(keyOf("\x1b[B"), "down");
		assert.equal(keyOf("\x1b[D"), "left");
		assert.equal(keyOf("\x1b[C"), "right");
		assert.equal(keyOf("\x1b[H"), "home");
		assert.equal(keyOf("\x1b[F"), "end");
	});

	it("keeps printable keys case sensitive, including kitty printables", () => {
		assert.equal(keyOf("S"), "S");
		assert.equal(keyOf("s"), "s");
		assert.equal(keyOf("\x1b[115:83;2u"), "S");
		assert.equal(keyOf("\x1b[115u"), "s");
		assert.equal(keyOf("g"), "g");
		assert.equal(keyOf("?"), "?");
		assert.equal(keyOf("{"), "{");
		assert.equal(keyOf("中"), "中");
	});

	it("rejects paste chunks, mouse reports and other unknown sequences", () => {
		assert.equal(keyOf("\x1b[200~hello\x1b[201~"), undefined);
		assert.equal(keyOf("\x1b[<35;10;5M"), undefined);
		assert.equal(keyOf("ab"), undefined);
		assert.equal(keyOf("\x01"), undefined);
		assert.equal(keyOf(""), undefined);
	});

	it("derives its named keys from the bindings table", () => {
		const bound = new Set(bindings.flatMap((binding) => binding.keys).filter((key) => key.length > 1));
		assert.deepEqual(new Set(namedKeys), bound);
		for (const name of ["escape", "enter", "tab", "up", "down", "left", "right", "pageUp", "pageDown", "home", "end", "ctrl+d", "ctrl+u", "ctrl+f", "ctrl+b"]) {
			assert.ok(namedKeys.includes(name as (typeof namedKeys)[number]), name);
		}
	});
});
