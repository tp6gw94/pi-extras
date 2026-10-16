import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { agentDirFromEnv, listEntries, pickEntry, registryDir, removeEntry, type SessionEntry, writeEntry } from "../registry.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "annotate-registry-test-"));
	dirs.push(dir);
	return dir;
}

const base: SessionEntry = {
	sessionId: "019ee068-aaaa-7000-8000-000000000000",
	port: 4747,
	token: "token-a",
	pid: 4242,
	cwd: "/work/a",
	startedAt: "2026-10-15T10:00:00.000Z",
	tuiModule: "/opt/pi/node_modules/@earendil-works/pi-tui/dist/index.js",
};

const entry = (extra: Partial<SessionEntry> = {}): SessionEntry => ({ ...base, ...extra });

describe("session registry", () => {
	it("writes one owner-only file named after the pi process", () => {
		const dir = join(tempDir(), "sessions");
		writeEntry(dir, entry());
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		assert.deepEqual(readdirSync(dir), ["4242.json"]);
		assert.equal(statSync(join(dir, "4242.json")).mode & 0o777, 0o600);
	});

	it("round-trips the whole record and leaves no temporary file", () => {
		const dir = tempDir();
		writeEntry(dir, entry());
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "4242.json"), "utf8")), {
			sessionId: "019ee068-aaaa-7000-8000-000000000000",
			port: 4747,
			token: "token-a",
			pid: 4242,
			cwd: "/work/a",
			startedAt: "2026-10-15T10:00:00.000Z",
			tuiModule: "/opt/pi/node_modules/@earendil-works/pi-tui/dist/index.js",
		});
		assert.deepEqual(readdirSync(dir), ["4242.json"]);
	});

	it("removes a record only with its own token", () => {
		const dir = tempDir();
		writeEntry(dir, entry());
		removeEntry(dir, 4242, "other");
		assert.deepEqual(listEntries(dir, () => true).map((e) => e.pid), [4242]);
		removeEntry(dir, 4242, "token-a");
		assert.deepEqual(readdirSync(dir), []);
	});

	it("keeps live processes, deletes dead ones and lists newest first", () => {
		const dir = tempDir();
		writeEntry(dir, entry({ pid: 1, startedAt: "2026-10-15T10:00:00.000Z" }));
		writeEntry(dir, entry({ pid: 2, startedAt: "2026-10-15T11:00:00.000Z" }));
		assert.deepEqual(listEntries(dir, (pid) => pid !== 1).map((e) => e.pid), [2]);
		assert.deepEqual(readdirSync(dir), ["2.json"]);
	});

	it("drops unreadable records", () => {
		const dir = tempDir();
		writeEntry(dir, entry());
		writeFileSync(join(dir, "7.json"), "not json");
		assert.deepEqual(listEntries(dir, () => true).map((e) => e.pid), [4242]);
		assert.deepEqual(readdirSync(dir), ["4242.json"]);
	});

	it("returns nothing for a missing directory", () => {
		assert.deepEqual(listEntries(join(tempDir(), "missing")), []);
	});

	it("picks by any unique part of the id, the only session, or the only one in cwd", () => {
		const a = entry({ sessionId: "019ee068-aaaa", cwd: "/work/a" });
		const b = entry({ sessionId: "019ee068-bbbb", cwd: "/work/b" });
		assert.equal(pickEntry([a, b], "bbbb", "/x"), b);
		assert.match(pickEntry([a, b], "019ee068", "/x") as string, /matches 2 sessions/);
		assert.match(pickEntry([a, b], "zzz", "/x") as string, /no live annotate session matches/);
		assert.equal(pickEntry([a], undefined, "/x"), a);
		assert.equal(pickEntry([a, b], undefined, "/work/b"), b);
		assert.match(pickEntry([a, b], undefined, "/x") as string, /several annotate sessions/);
		assert.match(pickEntry([], undefined, "/x") as string, /run \/annotate tui/);
	});

	it("follows PI_CODING_AGENT_DIR like pi", () => {
		assert.equal(agentDirFromEnv({}, "/home/u"), "/home/u/.pi/agent");
		assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "~/agent" }, "/home/u"), "/home/u/agent");
		assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "~" }, "/home/u"), "/home/u");
		assert.equal(agentDirFromEnv({ PI_CODING_AGENT_DIR: "/srv/agent" }, "/home/u"), "/srv/agent");
		assert.equal(registryDir("/srv/agent"), "/srv/agent/annotation/sessions");
	});
});
