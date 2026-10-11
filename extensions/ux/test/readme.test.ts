import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE_NAME, DEFAULT_KEYS, KEY_ACTIONS, parseConfig, TOP_LEVEL_KEYS } from "../core/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmes = {
	en: { file: "README.md", other: "README.zh-TW.md" },
	"zh-TW": { file: "README.zh-TW.md", other: "README.md" },
} as const;

function read(file: string): string {
	return readFileSync(join(root, file), "utf8");
}

function exampleConfig(text: string): string {
	const m = /<!-- example-config -->\s*```json\n([\s\S]*?)\n```/.exec(text);
	assert.ok(m, "example-config block not found");
	return m[1]!;
}

function headingLevels(text: string): number[] {
	const withoutFences = text.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
	return [...withoutFences.matchAll(/^(#{1,6}) /gm)].map((m) => m[1]!.length);
}

for (const [lang, { file, other }] of Object.entries(readmes)) {
	describe(`${file} (${lang})`, () => {
		const text = read(file);

		it("example config parses with no errors in the real loader", () => {
			const { config, errors } = parseConfig(exampleConfig(text));
			assert.deepEqual(errors, []);
			assert.equal(config.keys.togglePrompt, "alt+o");
		});

		it("documents every config key the loader reads", () => {
			for (const key of [...TOP_LEVEL_KEYS, ...KEY_ACTIONS]) {
				assert.ok(text.includes(`| \`${key}\` |`) || text.includes(`### \`${key}\``), `${key} is not documented`);
			}
		});

		it("states the default keys and how to change them", () => {
			for (const action of KEY_ACTIONS) {
				const row = `| \`${action}\` | \`${DEFAULT_KEYS[action]}\` |`;
				assert.ok(text.includes(row), `default key row missing: ${row}`);
			}
			assert.ok(text.includes(`~/.pi/agent/${CONFIG_FILE_NAME}`));
			assert.ok(text.includes("PI_CODING_AGENT_DIR"));
			assert.ok(text.includes("`/reload`"));
			assert.ok(text.includes("`null`"), "disabling a shortcut is not documented");
		});

		it("says the default only collides in pi's Windows keybinding mode", () => {
			for (const needle of ["`shift+ctrl+p`", "`WSL_DISTRO_NAME`", "`WSL_INTEROP`"]) {
				assert.ok(text.includes(needle), `${needle} missing`);
			}
		});

		it("explains pi's own prompt jumping", () => {
			assert.ok(text.includes("`ctrl+shift+up`") && text.includes("OSC 133"));
		});

		it("no longer offers the clipboard quote and points to annotation", () => {
			for (const gone of ["`/quote`", "`alt+q`", "pbpaste", "xclip"]) assert.ok(!text.includes(gone), `${gone} still documented`);
			assert.ok(text.includes("`quoteClipboard`"), "the obsolete key is not mentioned");
			assert.ok(text.includes("annotation"));
		});

		it(`links to ${other}`, () => {
			assert.ok(text.includes(`](${other})`), `no link to ${other}`);
		});
	});
}

describe("README translations", () => {
	it("have the same example config", () => {
		assert.equal(exampleConfig(read("README.md")), exampleConfig(read("README.zh-TW.md")));
	});

	it("correspond section by section", () => {
		assert.deepEqual(headingLevels(read("README.md")), headingLevels(read("README.zh-TW.md")));
	});
});
