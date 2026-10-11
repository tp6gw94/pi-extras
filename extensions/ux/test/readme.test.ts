import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CLIPBOARD_TOOLS } from "../core/clipboard.ts";
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
			assert.equal(config.keys.quoteClipboard, undefined);
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

		it("says the defaults only collide in pi's Windows keybinding mode", () => {
			for (const needle of ["`shift+ctrl+p`", "`alt+up`", "`WSL_DISTRO_NAME`", "`WSL_INTEROP`"]) {
				assert.ok(text.includes(needle), `${needle} missing`);
			}
		});

		it("says /quote replaces typed text and the shortcut keeps it", () => {
			assert.ok(text.includes("`/quote` replaces what you typed") || text.includes("`/quote` 會取代你打好的字"));
		});

		it("lists the clipboard tools in the order pi-ux tries them", () => {
			let from = 0;
			for (const tool of CLIPBOARD_TOOLS) {
				const cmd = `\`${[tool.command, ...tool.args].join(" ")}\``;
				const at = text.indexOf(cmd, from);
				assert.ok(at >= 0, `${cmd} missing or out of order`);
				from = at;
			}
		});

		it("explains the paste marker and pi's own prompt jumping", () => {
			assert.ok(text.includes("[paste #1 +"), "paste marker not shown");
			assert.ok(text.includes("`ctrl+shift+up`") && text.includes("OSC 133"));
			assert.ok(text.includes("`/quote`"));
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
