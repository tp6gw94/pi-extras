import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/pi-annotation.ts", import.meta.url));

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-annotation-bin-"));
	try {
		const result = spawnSync(BIN, args, { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8" });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("pi-annotation bin", () => {
	it("prints usage and exits 0 for --help", () => {
		const result = run(["--help"]);
		assert.equal(result.status, 0);
		assert.match(result.stdout, /Usage: pi-annotation \[session-id-part\]/);
		assert.equal(result.stderr, "");
	});

	it("prints nothing and exits 0 for --list with no live session", () => {
		const result = run(["--list"]);
		assert.equal(result.status, 0);
		assert.equal(result.stdout, "");
		assert.equal(result.stderr, "");
	});

	it("explains how to start a session and exits 1 when there is nothing to attach to", () => {
		const result = run([]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /run \/annotate in pi first/);
	});
});
