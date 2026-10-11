import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { routeFiles } from "../core/command.ts";
import { parseConfig, RULE_KEYS, TOP_LEVEL_KEYS } from "../core/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmes = {
	en: { file: "README.md", other: "README.zh-TW.md" },
	"zh-TW": { file: "README.zh-TW.md", other: "README.md" },
} as const;

function read(file: string): string {
	return readFileSync(join(root, file), "utf8");
}

/** The ```json block right after the `<!-- example-config -->` marker. */
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
			assert.equal(config.afterWrite.length, 2);
			assert.equal(config.beforeSettle.length, 2);
		});

		it("example config routes files the way the README table says", () => {
			const { config } = parseConfig(exampleConfig(text));
			const route = (rules: typeof config.afterWrite, file: string) => routeFiles(rules, [file]).map((r) => r.rule.name);
			assert.deepEqual(route(config.afterWrite, "src/math.ts"), ["prettier"]);
			assert.deepEqual(route(config.beforeSettle, "src/math.ts"), ["eslint"]);
			assert.deepEqual(route(config.afterWrite, "app/util.py"), ["ruff format"]);
			assert.deepEqual(route(config.beforeSettle, "app/util.py"), ["ruff check"]);
			assert.deepEqual(route(config.afterWrite, "docs/notes.md"), []);
			assert.deepEqual(route(config.beforeSettle, "docs/notes.md"), []);
			// a turn touching both: each lint runs once with only its own files
			const mixed = routeFiles(config.beforeSettle, ["src/math.ts", "app/util.py", "src/greet.ts", "docs/notes.md"]);
			assert.deepEqual(
				mixed.map((r) => [r.rule.name, r.files]),
				[
					["eslint", ["src/math.ts", "src/greet.ts"]],
					["ruff check", ["app/util.py"]],
				],
			);
			// the table rows name the same commands
			for (const row of ["| `src/math.ts` | `prettier` | `eslint` |", "| `app/util.py` | `ruff format` | `ruff check` |"]) {
				assert.ok(text.includes(row), `table row missing: ${row}`);
			}
		});

		it("documents every config key the loader reads, and {files}", () => {
			for (const key of [...TOP_LEVEL_KEYS, ...RULE_KEYS, "{files}"]) {
				assert.ok(text.includes(`| \`${key}\` |`) || text.includes(`### \`${key}\``), `${key} is not documented`);
			}
			assert.ok(text.includes("./--fix.ts"), "the ./ prefix for leading - is not documented");
			assert.ok(text.includes("~/.pi/agent/pi-hooks-trust.json"));
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
