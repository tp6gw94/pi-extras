import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const pkg = JSON.parse(read("package.json"));
const extensions = readdirSync(join(root, "extensions"), { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name)
	.sort();

function exampleFilter(text: string): string {
	const m = /<!-- example-filter -->\s*```json\n([\s\S]*?)\n```/.exec(text);
	assert.ok(m, "example-filter block not found");
	return m[1]!;
}

function headingLevels(text: string): number[] {
	const withoutFences = text.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
	return [...withoutFences.matchAll(/^(#{1,6}) /gm)].map((m) => m[1]!.length);
}

describe("package layout", () => {
	it("has the nine extensions, each with an index.ts", () => {
		assert.deepEqual(extensions, [
			"annotation",
			"hooks",
			"inline-skills",
			"quota-resume",
			"ralph",
			"resume-handoff",
			"rpc-subagents",
			"skill-name-normalizer",
			"ux",
		]);
		for (const name of extensions) assert.ok(existsSync(join(root, "extensions", name, "index.ts")), name);
	});

	it("does not ship herdr-agent-state or deepinfra-provider", () => {
		for (const name of ["herdr-agent-state", "deepinfra-provider"]) {
			assert.ok(!existsSync(join(root, "extensions", name)), name);
			for (const file of ["README.md", "README.zh-TW.md", "scripts/acceptance.sh", "package.json"]) assert.ok(!read(file).includes(name), `${name} in ${file}`);
		}
	});

	it("loads every extensions/<name>/index.ts through one manifest glob", () => {
		assert.deepEqual(pkg.pi, { extensions: ["./extensions/*/index.ts"] });
	});

	it("has one package.json: no per-extension manifests", () => {
		for (const name of extensions) {
			assert.ok(!existsSync(join(root, "extensions", name, "package.json")), `${name}/package.json`);
			assert.ok(!existsSync(join(root, "extensions", name, "package-lock.json")), `${name}/package-lock.json`);
		}
	});

	it("requires coding-agent >=1.3.0 with other host packages as * peers and bundles only grok-mermaid, croner and mermaid, at exact versions", () => {
		assert.deepEqual(pkg.dependencies, { croner: "9.1.0", "grok-mermaid": "0.2.3", mermaid: "12.1.0" });
		assert.deepEqual(pkg.peerDependencies, {
			"@earendil-works/pi-coding-agent": ">=1.3.0",
			"@earendil-works/pi-tui": "*",
			typebox: "*",
		});
		assert.equal(pkg.workspaces, undefined);
	});

	it("states the Node.js version in engines instead of installing a node binary package", () => {
		assert.deepEqual(pkg.engines, { node: ">=22" });
		assert.equal(pkg.devDependencies?.node, undefined);
		const lock = JSON.parse(read("package-lock.json"));
		assert.equal(lock.packages["node_modules/node"], undefined);
		assert.deepEqual(lock.packages[""].engines, { node: ">=22" });
	});

	it("keeps the skills that ralph and rpc-subagents find next to their index.ts", () => {
		assert.ok(existsSync(join(root, "extensions/ralph/skills/ralph-completion/SKILL.md")));
		assert.ok(existsSync(join(root, "extensions/rpc-subagents/skills/rpc-subagents/SKILL.md")));
	});
});

for (const [file, other] of [
	["README.md", "README.zh-TW.md"],
	["README.zh-TW.md", "README.md"],
] as const) {
	describe(file, () => {
		const text = read(file);

		it("lists every extension in the table", () => {
			for (const name of extensions) assert.ok(text.includes(`| \`${name}\` |`), `${name} missing`);
		});

		it("shows a filter whose paths exist and that pi config's form is documented", () => {
			const filter = JSON.parse(exampleFilter(text));
			const entry = filter.packages[0];
			assert.equal(entry.source, "git:github.com/tp6gw94/pi-extras");
			for (const pattern of entry.extensions as string[]) {
				assert.match(pattern, /^!/);
				assert.ok(existsSync(join(root, pattern.slice(1))), pattern);
			}
			assert.ok(text.includes('"-extensions/ralph/index.ts"'));
			assert.ok(text.includes("`pi config`") && text.includes("`pi config --local`"));
		});

		it("links each extension README, in the same language when one exists", () => {
			for (const name of extensions) {
				if (!existsSync(join(root, "extensions", name, "README.md"))) continue;
				const zh = `extensions/${name}/README.zh-TW.md`;
				const want = file === "README.zh-TW.md" && existsSync(join(root, zh)) ? zh : `extensions/${name}/README.md`;
				assert.ok(text.includes(`](${want})`), `${want} not linked from ${file}`);
			}
		});

		it(`links to ${other}`, () => {
			assert.ok(text.includes(`](${other})`));
		});
	});
}

describe("README translations", () => {
	it("have the same filter example", () => {
		assert.equal(exampleFilter(read("README.md")), exampleFilter(read("README.zh-TW.md")));
	});

	it("correspond section by section", () => {
		assert.deepEqual(headingLevels(read("README.md")), headingLevels(read("README.zh-TW.md")));
	});
});
