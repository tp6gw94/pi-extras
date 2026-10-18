import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { registryDir, writeEntry } from "../registry.ts";

const BIN = fileURLToPath(new URL("../bin/pi-annotation.ts", import.meta.url));

function run(args: string[], live = false): { status: number | null; stdout: string; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-annotation-bin-"));
	try {
		if (live) writeEntry(registryDir(dir), { sessionId: "test-session", port: 1, token: "test", pid: process.pid, cwd: process.cwd(), startedAt: "2026-01-01T00:00:00Z" });
		const result = spawnSync(BIN, args, { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8" });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("pi-annotation bin", () => {
	it("reports no exact-cwd sessions before checking terminal input", () => {
		const result = run(["--interactive"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /no live annotate session in this directory; run \/annotate in pi first/);
	});

	it("requires terminal input and output even with one candidate", () => {
		const result = run(["--interactive"], true);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /requires a TTY on stdin and stdout/);
	});

	it("keeps help and list precedence", () => {
		assert.match(run(["--interactive", "--list", "--help"]).stdout, /Usage:/);
		assert.equal(run(["--interactive", "--list"]).status, 0);
	});

	for (const args of [["--interactive", "session"], ["session", "--interactive"], ["--interactive", "--unknown"]]) {
		it(`rejects mixed interactive arguments ${args.join(" ")}`, () => {
			const result = run(args);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /cannot be combined/);
		});
	}

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
