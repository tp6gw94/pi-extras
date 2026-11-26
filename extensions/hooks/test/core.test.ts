import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { changedSince, snapshotGit, ToolChangeRecorder } from "../core/changes.ts";
import { filesForRule, routeFiles, safeFileArg, shellQuote, substituteFiles, truncateOutput } from "../core/command.ts";
import {
	DEFAULT_AFTER_WRITE_TIMEOUT_MS,
	DEFAULT_BEFORE_SETTLE_TIMEOUT_MS,
	DEFAULT_MAX_FIX_ATTEMPTS,
	parseConfig,
	type HookRule,
} from "../core/config.ts";
import { FixCounter } from "../core/fix-counter.ts";
import { fixRequestMessage, giveUpMessage } from "../core/messages.ts";
import { RunConfig } from "../core/run-config.ts";
import { matchAny, matchGlob } from "../core/glob.ts";
import { runShell } from "../core/run.ts";
import { hashConfig, TrustStore } from "../core/trust.ts";
import { nodeExec } from "./exec.ts";

const rule = (glob: string | string[], command = "x {files}"): HookRule => ({
	globs: Array.isArray(glob) ? glob : [glob],
	command,
	timeoutMs: 1000,
	name: command,
});

describe("config parsing", () => {
	it("parses both sections with defaults", () => {
		const { config, errors } = parseConfig(
			JSON.stringify({
				afterWrite: [{ glob: "*.ts", command: "prettier --write {files}" }],
				beforeSettle: [{ glob: ["*.ts", "*.tsx"], command: "eslint {files}", timeoutMs: 5000, name: "eslint" }],
			}),
		);
		assert.deepEqual(errors, []);
		assert.equal(config.afterWrite.length, 1);
		assert.equal(config.afterWrite[0]!.timeoutMs, DEFAULT_AFTER_WRITE_TIMEOUT_MS);
		assert.equal(config.afterWrite[0]!.name, "prettier --write {files}");
		assert.deepEqual(config.beforeSettle[0]!.globs, ["*.ts", "*.tsx"]);
		assert.equal(config.beforeSettle[0]!.timeoutMs, 5000);
		assert.equal(config.beforeSettle[0]!.name, "eslint");
		assert.equal(config.maxFixAttempts, DEFAULT_MAX_FIX_ATTEMPTS);
	});

	it("missing sections are empty", () => {
		const { config, errors } = parseConfig("{}");
		assert.deepEqual(errors, []);
		assert.deepEqual(config.afterWrite, []);
		assert.deepEqual(config.beforeSettle, []);
	});

	it("reports invalid JSON and returns an empty config", () => {
		const { config, errors } = parseConfig("{ nope");
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /invalid JSON/);
		assert.deepEqual(config.beforeSettle, []);
	});

	it("skips invalid rules but keeps valid ones", () => {
		const { config, errors } = parseConfig(
			JSON.stringify({
				afterWrite: [{ command: "x" }, { glob: "*.py", command: "" }, { glob: "*.py", command: "ruff format {files}" }],
				beforeSettle: "eslint",
			}),
		);
		assert.equal(config.afterWrite.length, 1);
		assert.equal(config.afterWrite[0]!.command, "ruff format {files}");
		assert.deepEqual(config.beforeSettle, []);
		assert.equal(errors.length, 3);
	});

	it("falls back to the default timeout on a bad timeoutMs", () => {
		const { config, errors } = parseConfig(
			JSON.stringify({ beforeSettle: [{ glob: "*", command: "x", timeoutMs: -1 }] }),
		);
		assert.equal(config.beforeSettle[0]!.timeoutMs, DEFAULT_BEFORE_SETTLE_TIMEOUT_MS);
		assert.equal(errors.length, 1);
	});

	it("reads maxFixAttempts (0 allowed) and rejects bad values", () => {
		assert.equal(parseConfig('{"maxFixAttempts":5}').config.maxFixAttempts, 5);
		assert.equal(parseConfig('{"maxFixAttempts":0}').config.maxFixAttempts, 0);
		const bad = parseConfig('{"maxFixAttempts":"3"}');
		assert.equal(bad.config.maxFixAttempts, DEFAULT_MAX_FIX_ATTEMPTS);
		assert.equal(bad.errors.length, 1);
	});

	it("warns on unknown keys", () => {
		assert.match(parseConfig('{"afterwrite":[]}').errors[0]!, /unknown key "afterwrite"/);
		const r = parseConfig('{"beforeSettle":[{"glob":"*.ts","command":"x","timeout":5}]}');
		assert.match(r.errors[0]!, /beforeSettle\[0\]: unknown key "timeout"/);
		assert.equal(r.config.beforeSettle.length, 1);
	});
});

describe("glob routing", () => {
	it("slash-less globs match the basename at any depth", () => {
		assert.ok(matchGlob("*.ts", "a.ts"));
		assert.ok(matchGlob("*.ts", "src/deep/a.ts"));
		assert.ok(!matchGlob("*.ts", "a.tsx"));
		assert.ok(!matchGlob("*.ts", "notes.md"));
	});

	it("globs with a slash match the relative path", () => {
		assert.ok(matchGlob("src/**/*.ts", "src/a.ts"));
		assert.ok(matchGlob("src/**/*.ts", "src/x/y/a.ts"));
		assert.ok(!matchGlob("src/**/*.ts", "lib/a.ts"));
		assert.ok(matchGlob("**/*.py", "pkg/mod.py"));
		assert.ok(matchGlob("**/*.py", "mod.py"));
		assert.ok(matchGlob("./src/*.ts", "src/a.ts"));
		assert.ok(!matchGlob("src/*.ts", "src/x/a.ts"));
	});

	it("supports braces, ?, and classes", () => {
		assert.ok(matchGlob("*.{ts,tsx}", "a.tsx"));
		assert.ok(matchGlob("*.{ts,tsx}", "a.ts"));
		assert.ok(!matchGlob("*.{ts,tsx}", "a.js"));
		assert.ok(matchGlob("file?.py", "file1.py"));
		assert.ok(matchGlob("file[0-9].py", "file7.py"));
		assert.ok(!matchGlob("file[!0-9].py", "file7.py"));
		assert.ok(matchGlob("a.b", "a.b"));
		assert.ok(!matchGlob("a.b", "axb"));
	});

	it("! globs exclude", () => {
		assert.ok(matchAny(["*.ts", "!*.d.ts"], "a.ts"));
		assert.ok(!matchAny(["*.ts", "!*.d.ts"], "types.d.ts"));
	});

	it("routes a mixed change set to each rule with only its own files", () => {
		const changed = ["src/a.ts", "app/b.py", "README.md", "src/c.ts", "app/d.py", "src/a.ts"];
		const ts = rule("*.ts", "eslint {files}");
		const py = rule("*.py", "ruff check {files}");
		const routes = routeFiles([ts, py], changed);
		assert.deepEqual(
			routes.map((r) => [r.rule.command, r.files]),
			[
				["eslint {files}", ["src/a.ts", "src/c.ts"]],
				["ruff check {files}", ["app/b.py", "app/d.py"]],
			],
		);
		assert.deepEqual(routeFiles([ts, py], ["README.md"]), []);
		assert.deepEqual(filesForRule(py, ["x.ts"]), []);
	});
});

describe("{files} substitution", () => {
	it("replaces every occurrence with the quoted list", () => {
		assert.equal(substituteFiles("eslint {files}", ["a.ts", "src/b.ts"]), "eslint a.ts src/b.ts");
		assert.equal(substituteFiles("a {files} && b {files}", ["x.py"]), "a x.py && b x.py");
	});

	it("quotes paths with spaces, quotes and shell metacharacters", () => {
		assert.equal(shellQuote("my file.ts"), "'my file.ts'");
		assert.equal(shellQuote("it's.ts"), `'it'\\''s.ts'`);
		assert.equal(shellQuote("$(rm -rf).ts"), "'$(rm -rf).ts'");
		const out = execFileSync("sh", ["-c", substituteFiles("printf '%s\\n' {files}", ["a b.ts", "it's.py", "$(x).md"])], {
			encoding: "utf8",
		});
		assert.equal(out, "a b.ts\nit's.py\n$(x).md\n");
	});

	it("prefixes paths starting with - so tools cannot parse them as options", () => {
		assert.equal(substituteFiles("eslint {files}", ["--fix.ts"]), "eslint ./--fix.ts");
		assert.equal(substituteFiles("ruff check {files}", ["-rf.py", "src/ok.py"]), "ruff check ./-rf.py src/ok.py");
		assert.equal(safeFileArg("src/-x.ts"), "src/-x.ts");
		assert.equal(substituteFiles("eslint {files}", ["--fix me's.ts"]), `eslint './--fix me'\\''s.ts'`);
		const out = execFileSync("sh", ["-c", substituteFiles("printf '%s\\n' {files}", ["--fix.ts", "-rf.py", "--a b.ts"])], {
			encoding: "utf8",
		});
		assert.equal(out, "./--fix.ts\n./-rf.py\n./--a b.ts\n");
	});

	it("a real tool sees a dash-prefixed file as a file, not an option", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hooks-dash-"));
		try {
			writeFileSync(join(dir, "--version"), "x");
			const r = await runShell(substituteFiles("ls {files}", ["--version"]), { cwd: dir, timeoutMs: 5000 });
			assert.equal(r.ok, true);
			assert.equal(r.output.trim(), "./--version");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves commands without {files} unchanged", () => {
		assert.equal(substituteFiles("tsc --noEmit", ["a.ts"]), "tsc --noEmit");
	});

	it("truncates long output keeping head and tail", () => {
		const long = `${"a".repeat(1000)}${"z".repeat(1000)}`;
		const t = truncateOutput(long, 200);
		assert.ok(t.startsWith("aaa"));
		assert.ok(t.endsWith("zzz"));
		assert.match(t, /chars truncated/);
		assert.equal(truncateOutput("short\n", 200), "short");
		assert.equal(truncateOutput("\u001b[1;32mAll checks passed!\u001b[0m\n", 200), "All checks passed!");
	});
});

describe("fix counter / cap", () => {
	it("allows exactly max attempts, then stops", () => {
		const c = new FixCounter(3);
		assert.equal(c.tryConsume(), 1);
		assert.equal(c.tryConsume(), 2);
		assert.equal(c.tryConsume(), 3);
		assert.equal(c.exhausted, true);
		assert.equal(c.tryConsume(), undefined);
		assert.equal(c.attempts, 3);
	});

	it("reset starts over (new user prompt) and can change the cap", () => {
		const c = new FixCounter(1);
		c.tryConsume();
		assert.equal(c.tryConsume(), undefined);
		c.reset(2);
		assert.equal(c.attempts, 0);
		assert.equal(c.tryConsume(), 1);
		assert.equal(c.tryConsume(), 2);
		assert.equal(c.tryConsume(), undefined);
	});

	it("cap 0 never continues", () => {
		assert.equal(new FixCounter(0).tryConsume(), undefined);
	});
});

describe("command runner / timeout", () => {
	const cwd = tmpdir();

	function killFixture(file: string) {
		if (!existsSync(file)) return;
		const pid = Number(readFileSync(file, "utf8"));
		if (!Number.isSafeInteger(pid) || pid < 2) return;
		try {
			process.kill(pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}

	it("reports success and output", async () => {
		const r = await runShell("echo out; echo err >&2", { cwd, timeoutMs: 5000 });
		assert.equal(r.ok, true);
		assert.equal(r.timedOut, false);
		assert.match(r.output, /out/);
		assert.match(r.output, /err/);
	});

	it("preserves UTF-8 characters split across writes", async () => {
		const r = await runShell("printf '\\342'; sleep 0.1; printf '\\202\\254'", { cwd, timeoutMs: 5000 });
		assert.equal(r.output, "€");
	});

	it("preserves an exited shell's status when a background job inherits its pipes", async () => {
		const dir = mkdtempSync(join(cwd, "pi-hooks-drain-"));
		try {
			const r = await runShell("sleep 10 & echo $! > pid; exit 3", { cwd: dir, timeoutMs: 500 });
			assert.equal(r.code, 3);
			assert.equal(r.timedOut, false);
		} finally {
			killFixture(join(dir, "pid"));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("retains diagnostics written shortly after the shell exits", async () => {
		const r = await runShell("(sleep 0.2; echo diagnostic >&2) & exit 3", { cwd, timeoutMs: 5000 });
		assert.equal(r.code, 3);
		assert.equal(r.timedOut, false);
		assert.equal(r.output, "diagnostic\n");
	});

	it("bounds retained output without changing the command's exit status", async () => {
		const command = `${shellQuote(process.execPath)} -e 'process.stdout.write("a".repeat(100000)); process.exitCode = 3'`;
		const r = await runShell(command, { cwd, timeoutMs: 5000 });
		assert.equal(r.code, 3);
		assert.equal(r.timedOut, false);
		assert.equal(r.output, "[Hook output truncated after 64 KiB]\n" + "a".repeat(65536));
	});

	it("reports a non-zero exit", async () => {
		const r = await runShell("echo bad; exit 3", { cwd, timeoutMs: 5000 });
		assert.equal(r.ok, false);
		assert.equal(r.code, 3);
		assert.equal(r.timedOut, false);
	});

	it("reports a signal exit as shell status", async () => {
		const r = await runShell("kill -TERM $$", { cwd, timeoutMs: 5000 });
		assert.equal(r.code, 143);
		assert.equal(r.timedOut, false);
	});

	it("kills a hung command at timeoutMs", async () => {
		const t0 = Date.now();
		const r = await runShell("sleep 30", { cwd, timeoutMs: 300 });
		assert.equal(r.timedOut, true);
		assert.equal(r.ok, false);
		assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
	});

	it("kills the whole process group of a compound command", async () => {
		const dir = mkdtempSync(join(cwd, "pi-hooks-group-"));
		const pidFile = join(dir, "pid");
		try {
			writeFileSync(join(dir, "worker.cjs"), `const fs = require('node:fs'); process.on('SIGTERM', () => fs.writeFileSync('term', 'yes')); fs.writeFileSync('pid', String(process.pid)); setInterval(() => {}, 1000);`);
			const r = await runShell(`sh -c ${shellQuote(`${shellQuote(process.execPath)} worker.cjs; :`)} & wait`, { cwd: dir, timeoutMs: 2000 });
			assert.equal(r.timedOut, true);
			assert.equal(readFileSync(join(dir, "term"), "utf8"), "yes");
			const pid = Number(readFileSync(pidFile, "utf8"));
			const state = () => {
				const ps = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
				if (ps.error) throw ps.error;
				return ps.stdout.trim();
			};
			let status = state();
			for (let attempt = 0; status && !status.startsWith("Z") && attempt < 20; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 25));
				status = state();
			}
			assert.match(status, /^(?:$|Z)/);
		} finally {
			killFixture(pidFile);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("distinguishes a user abort from a timeout", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const r = await runShell("sleep 30", { cwd, timeoutMs: 10_000, signal: ac.signal });
		assert.equal(r.aborted, true);
		assert.equal(r.timedOut, false);
	});

	it("returns within the hard deadline when an escaped descendant holds the pipes", async () => {
		const dir = mkdtempSync(join(cwd, "pi-hooks-pipes-"));
		try {
			writeFileSync(join(dir, "launch.cjs"), `const child = require('node:child_process').spawn('sleep', ['12'], { detached: true, stdio: 'inherit' }); require('node:fs').writeFileSync('pid', String(child.pid)); child.unref(); setInterval(() => {}, 1000);`);
			const t0 = Date.now();
			const r = await runShell(`${shellQuote(process.execPath)} launch.cjs`, { cwd: dir, timeoutMs: 600 });
			assert.ok(existsSync(join(dir, "pid")));
			assert.equal(r.timedOut, true);
			assert.ok(Date.now() - t0 < 7600);
		} finally {
			killFixture(join(dir, "pid"));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a missing command is a failure, not a crash", async () => {
		const r = await runShell("definitely-not-a-command-xyz", { cwd, timeoutMs: 5000 });
		assert.equal(r.ok, false);
		assert.equal(r.code, 127);
	});
});

describe("changed files (git)", () => {
	const git = (dir: string, ...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });

	it("sees tool, shell and untracked edits; ignores ignored and deleted files; leaves the index alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hooks-git-"));
		try {
			git(dir, "init", "-q");
			git(dir, "config", "user.email", "t@t");
			git(dir, "config", "user.name", "t");
			writeFileSync(join(dir, ".gitignore"), "dist/\n");
			writeFileSync(join(dir, "a.ts"), "a\n");
			writeFileSync(join(dir, "gone.ts"), "g\n");
			writeFileSync(join(dir, "dirty.py"), "1\n");
			git(dir, "add", "-A");
			git(dir, "commit", "-qm", "init");
			writeFileSync(join(dir, "dirty.py"), "2\n");
			const statusBefore = git(dir, "status", "--porcelain");

			const start = await snapshotGit(nodeExec, dir);
			assert.ok(start);
			assert.deepEqual(await changedSince(nodeExec, dir, start), []);

			writeFileSync(join(dir, "a.ts"), "b\n");
			mkdirSync(join(dir, "src"));
			writeFileSync(join(dir, "src", "new.py"), "x\n");
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "dist", "out.ts"), "x\n");
			unlinkSync(join(dir, "gone.ts"));

			const changed = await changedSince(nodeExec, dir, start);
			assert.deepEqual(changed?.sort(), ["a.ts", "src/new.py"]);
			assert.equal(git(dir, "diff", "--cached", "--name-only"), "");
			assert.notEqual(git(dir, "status", "--porcelain"), statusBefore);
			assert.match(git(dir, "status", "--porcelain"), /\?\? src\//);

			const sub = await changedSince(nodeExec, join(dir, "src"), start);
			assert.deepEqual(sub, ["new.py"]);
			symlinkSync("src", join(dir, "alias"), "dir");
			assert.deepEqual(await changedSince(nodeExec, join(dir, "alias"), start), ["new.py"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined outside a git repo (caller falls back to tool records)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hooks-nogit-"));
		try {
			assert.equal(await snapshotGit(nodeExec, dir), undefined);
			const rec = new ToolChangeRecorder();
			writeFileSync(join(dir, "a.ts"), "x");
			rec.record("a.ts");
			rec.record("a.ts");
			rec.record("deleted.ts");
			assert.deepEqual(rec.list(dir), ["a.ts"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("trust store", () => {
	it("remembers approval by config hash and re-asks when it changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hooks-trust-"));
		try {
			const store = new TrustStore(join(dir, "sub", "trust.json"));
			const h1 = hashConfig('{"a":1}');
			const h2 = hashConfig('{"a":2}');
			assert.notEqual(h1, h2);
			assert.equal(await store.isTrusted("/p/.pi/hooks.json", h1), false);
			await store.trust("/p/.pi/hooks.json", h1);
			assert.equal(await store.isTrusted("/p/.pi/hooks.json", h1), true);
			assert.equal(await store.isTrusted("/p/.pi/hooks.json", h2), false);
			assert.equal(await store.isTrusted("/other/.pi/hooks.json", h1), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("config frozen per prompt", () => {
	it("keeps the start-of-turn config and warns once per new on-disk version", () => {
		const rc = new RunConfig<{ hash: string; n: number }>();
		assert.equal(rc.isActive, false);
		assert.equal(rc.shouldWarnChange("x"), false);
		rc.start({ hash: "h1", n: 1 });
		assert.equal(rc.config?.n, 1);
		assert.equal(rc.shouldWarnChange("h1"), false);
		assert.equal(rc.shouldWarnChange("h2"), true);
		assert.equal(rc.shouldWarnChange("h2"), false);
		assert.equal(rc.shouldWarnChange(undefined), true);
		assert.equal(rc.config?.n, 1);
		rc.end();
		assert.equal(rc.isActive, false);
		assert.equal(rc.config, undefined);
		rc.start({ hash: "h2", n: 2 });
		assert.equal(rc.shouldWarnChange("h2"), false);
	});

	it("a config created mid-turn does not activate hooks for that turn", () => {
		const rc = new RunConfig<{ hash: string }>();
		rc.start(undefined);
		assert.equal(rc.config, undefined);
		assert.equal(rc.shouldWarnChange("new"), false);
	});
});

describe("messages to the agent", () => {
	const failures = [
		{ name: "eslint", files: ["src/a.ts"], code: 1, output: "\u001b[31msrc/a.ts 1:1 error no-var\u001b[0m" },
		{ name: "ruff check", files: ["app/b.py"], code: 1, output: "x".repeat(10_000) },
	];

	it("fix request names the attempt, each check with its files, and forbids editing the config", () => {
		const m = fixRequestMessage(failures, 2, 3, 4000);
		assert.match(m, /attempt 2 of 3/);
		assert.match(m, /`eslint` \(exit 1\) on src\/a\.ts/);
		assert.match(m, /`ruff check` \(exit 1\) on app\/b\.py/);
		assert.match(m, /Do not edit \.pi\/hooks\.json/);
		assert.ok(!m.includes("\u001b"));
		assert.ok(m.length < 5000, `length ${m.length}`);
	});

	it("give-up message lists the remaining errors", () => {
		const m = giveUpMessage(failures.slice(0, 1), 3, 4000);
		assert.match(m, /after 3 automatic fix attempt/);
		assert.match(m, /no-var/);
	});
});
