import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
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
import { runShell, type ExecFn } from "../core/run.ts";
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
		// still shell-quoted correctly when the name also needs quoting
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
			const r = await runShell(nodeExec, substituteFiles("ls {files}", ["--version"]), { cwd: dir, timeoutMs: 5000 });
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

	it("reports success and output", async () => {
		const r = await runShell(nodeExec, "echo out; echo err >&2", { cwd, timeoutMs: 5000 });
		assert.equal(r.ok, true);
		assert.equal(r.timedOut, false);
		assert.match(r.output, /out/);
		assert.match(r.output, /err/);
	});

	it("reports a non-zero exit", async () => {
		const r = await runShell(nodeExec, "echo bad; exit 3", { cwd, timeoutMs: 5000 });
		assert.equal(r.ok, false);
		assert.equal(r.code, 3);
		assert.equal(r.timedOut, false);
	});

	it("kills a hung command at timeoutMs", async () => {
		const t0 = Date.now();
		const r = await runShell(nodeExec, "sleep 30", { cwd, timeoutMs: 300 });
		assert.equal(r.timedOut, true);
		assert.equal(r.ok, false);
		assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
	});

	it("kills the whole process group of a compound command", async () => {
		const r = await runShell(nodeExec, "sh -c 'sleep 41; echo leaked' & sleep 42", { cwd, timeoutMs: 300 });
		assert.equal(r.timedOut, true);
		await new Promise((res) => setTimeout(res, 300));
		const left = execFileSync("ps", ["-eo", "args="], { encoding: "utf8" })
			.split("\n")
			.filter((l) => /^sleep 4[12]$/.test(l.trim()))
			.join("\n");
		assert.equal(left.trim(), "");
	});

	it("distinguishes a user abort from a timeout", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 100);
		const r = await runShell(nodeExec, "sleep 30", { cwd, timeoutMs: 10_000, signal: ac.signal });
		assert.equal(r.aborted, true);
		assert.equal(r.timedOut, false);
	});

	it("hard guard returns even if exec never settles", async () => {
		const never: ExecFn = () => new Promise(() => {});
		const t0 = Date.now();
		const r = await runShell(never, "whatever", { cwd, timeoutMs: 100, graceMs: 100 });
		assert.equal(r.timedOut, true);
		assert.ok(Date.now() - t0 < 1000);
	});

	it("a missing command is a failure, not a crash", async () => {
		const r = await runShell(nodeExec, "definitely-not-a-command-xyz", { cwd, timeoutMs: 5000 });
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
			writeFileSync(join(dir, "dirty.py"), "2\n"); // dirty before the turn
			const statusBefore = git(dir, "status", "--porcelain");

			const start = await snapshotGit(nodeExec, dir);
			assert.ok(start);
			assert.deepEqual(await changedSince(nodeExec, dir, start), []);

			execFileSync("sed", ["-i", "s/a/b/", join(dir, "a.ts")]);
			mkdirSync(join(dir, "src"));
			writeFileSync(join(dir, "src", "new.py"), "x\n");
			mkdirSync(join(dir, "dist"));
			writeFileSync(join(dir, "dist", "out.ts"), "x\n");
			unlinkSync(join(dir, "gone.ts"));

			const changed = await changedSince(nodeExec, dir, start);
			assert.deepEqual(changed?.sort(), ["a.ts", "src/new.py"]);
			// dirty.py was already dirty and untouched this turn → not reported
			assert.equal(git(dir, "diff", "--cached", "--name-only"), "");
			assert.notEqual(git(dir, "status", "--porcelain"), statusBefore); // working tree changed…
			assert.match(git(dir, "status", "--porcelain"), /\?\? src\//); // …but new file still untracked

			// relative to a sub-directory project root
			const sub = await changedSince(nodeExec, join(dir, "src"), start);
			assert.deepEqual(sub, ["new.py"]);
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
		assert.equal(rc.shouldWarnChange("h2"), true); // agent edited .pi/hooks.json
		assert.equal(rc.shouldWarnChange("h2"), false); // only once
		assert.equal(rc.shouldWarnChange(undefined), true); // deleted
		assert.equal(rc.config?.n, 1); // still the frozen one
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
