import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { changedSince, snapshotGit, toProjectRelative, ToolChangeRecorder, type GitSnapshot } from "./core/changes.ts";
import { routeFiles, substituteFiles, truncateOutput } from "./core/command.ts";
import { fixRequestMessage, giveUpMessage, type CheckFailure } from "./core/messages.ts";
import { CONFIG_RELATIVE_PATH, DEFAULT_MAX_FIX_ATTEMPTS, parseConfig, type HooksConfig, type HookRule } from "./core/config.ts";
import { FixCounter } from "./core/fix-counter.ts";
import { RunConfig } from "./core/run-config.ts";
import { runShell, type ExecFn, type RunOutcome } from "./core/run.ts";
import { hashConfig, TrustStore } from "./core/trust.ts";

const STATUS_KEY = "pi-hooks";
const MESSAGE_TYPE = "pi-hooks";

interface LoadedConfig {
	path: string;
	hash: string;
	config: HooksConfig;
}

/** Optional JSONL trace of every hook command (set PI_HOOKS_LOG=/path/to/file). */
function trace(record: Record<string, unknown>): void {
	const file = process.env.PI_HOOKS_LOG;
	if (!file) return;
	try {
		appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
	} catch {
		// tracing must never break the agent
	}
}

function toolPath(input: Record<string, unknown>, cwd: string): string | undefined {
	const raw = input.path ?? input.file_path;
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	let p = raw.trim();
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	return resolve(cwd, p);
}

async function fileHash(path: string): Promise<string | undefined> {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch {
		return undefined;
	}
}

function agentDir(): string {
	try {
		return getAgentDir();
	} catch {
		return join(homedir(), ".pi", "agent");
	}
}

function describeRules(config: HooksConfig): string {
	const lines: string[] = [];
	for (const r of config.afterWrite) lines.push(`after write  [${r.globs.join(", ")}]  ${r.command}`);
	for (const r of config.beforeSettle) lines.push(`before reply [${r.globs.join(", ")}]  ${r.command}`);
	return lines.join("\n");
}

export default function piHooks(pi: ExtensionAPI): void {
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
	const trust = new TrustStore(join(agentDir(), "pi-hooks-trust.json"));
	/** Decisions made this session, keyed by "<path>\0<hash>". */
	const decisions = new Map<string, Promise<boolean>>();
	const reportedConfigErrors = new Set<string>();
	const counter = new FixCounter(DEFAULT_MAX_FIX_ATTEMPTS);
	const recorder = new ToolChangeRecorder();
	let runSnapshot: GitSnapshot | undefined;
	/**
	 * Config frozen at the start of each user prompt. The agent can edit .pi/hooks.json
	 * mid-turn (a real gpt-5.5 run did, to make a failing check pass); such edits only
	 * take effect, after re-confirmation, from the next prompt.
	 */
	const runConfig = new RunConfig<LoadedConfig>();

	async function configForRun(ctx: ExtensionContext): Promise<LoadedConfig | undefined> {
		if (!runConfig.isActive) return loadConfig(ctx);
		const frozen = runConfig.config;
		if (frozen) {
			const current = await readFile(frozen.path, "utf8").then(hashConfig, () => undefined);
			if (runConfig.shouldWarnChange(current)) {
				trace({ event: "config-changed-mid-turn", from: frozen.hash, to: current ?? null });
				ctx.ui.notify(
					`pi-hooks: ${CONFIG_RELATIVE_PATH} changed during this turn; keeping the version from the start of the turn. The change applies from the next prompt (after confirmation).`,
					"warning",
				);
			}
		}
		return frozen;
	}
	let snapshotPromise: Promise<GitSnapshot | undefined> | undefined;

	async function loadConfig(ctx: ExtensionContext): Promise<LoadedConfig | undefined> {
		const path = join(ctx.cwd, CONFIG_RELATIVE_PATH);
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			return undefined;
		}
		const hash = hashConfig(text);
		const { config, errors } = parseConfig(text);
		if (errors.length > 0 && !reportedConfigErrors.has(hash)) {
			reportedConfigErrors.add(hash);
			ctx.ui.notify(`pi-hooks: problems in ${CONFIG_RELATIVE_PATH}:\n${errors.join("\n")}`, "warning");
		}
		return { path, hash, config };
	}

	/** Ask once per config content; remember approvals across sessions by hash. */
	function ensureTrusted(ctx: ExtensionContext, loaded: LoadedConfig): Promise<boolean> {
		const key = `${loaded.path}\0${loaded.hash}`;
		let decision = decisions.get(key);
		if (!decision) {
			decision = (async () => {
				if (await trust.isTrusted(loaded.path, loaded.hash)) return true;
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`pi-hooks: ${loaded.path} is not approved yet and there is no UI to ask; hooks are disabled. Run pi interactively once to approve.`,
						"warning",
					);
					trace({ event: "trust", path: loaded.path, hash: loaded.hash, result: "no-ui" });
					return false;
				}
				const ok = await ctx.ui.confirm(
					"pi-hooks: run commands from this project?",
					`${loaded.path} (sha256 ${loaded.hash.slice(0, 12)}) wants to run these shell commands:\n\n${describeRules(loaded.config)}\n\nAllow? You will be asked again if the file changes.`,
				);
				trace({ event: "trust", path: loaded.path, hash: loaded.hash, result: ok ? "approved" : "declined" });
				if (ok) await trust.trust(loaded.path, loaded.hash);
				else ctx.ui.notify("pi-hooks: hooks disabled for this config until it changes or pi restarts.", "info");
				return ok;
			})();
			decisions.set(key, decision);
		}
		return decision;
	}

	async function run(
		ctx: ExtensionContext,
		phase: "afterWrite" | "beforeSettle",
		rule: HookRule,
		files: string[],
	): Promise<RunOutcome> {
		const command = substituteFiles(rule.command, files);
		ctx.ui.setStatus(STATUS_KEY, `${phase === "afterWrite" ? "format" : "lint"}: ${rule.name}`);
		const outcome = await runShell(exec, command, { cwd: ctx.cwd, timeoutMs: rule.timeoutMs, signal: ctx.signal });
		ctx.ui.setStatus(STATUS_KEY, undefined);
		trace({
			event: "run",
			phase,
			rule: rule.name,
			files,
			command,
			ok: outcome.ok,
			code: outcome.code,
			timedOut: outcome.timedOut,
			aborted: outcome.aborted,
			durationMs: outcome.durationMs,
		});
		if (outcome.timedOut) {
			ctx.ui.notify(
				`pi-hooks: \`${rule.name}\` timed out after ${rule.timeoutMs} ms and was killed (${phase}, ${files.join(", ")}).`,
				"warning",
			);
		}
		return outcome;
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		recorder.reset();
		runSnapshot = undefined;
		snapshotPromise = undefined;
		const loaded = await loadConfig(ctx);
		runConfig.start(loaded);
		counter.reset(loaded?.config.maxFixAttempts ?? DEFAULT_MAX_FIX_ATTEMPTS);
		if (!loaded || loaded.config.beforeSettle.length === 0) return;
		snapshotPromise = snapshotGit(exec, ctx.cwd);
		runSnapshot = await snapshotPromise;
		trace({ event: "turn_start", git: runSnapshot ? runSnapshot.tree : null });
	});

	pi.on("agent_settled", () => {
		runConfig.end();
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || (event.toolName !== "write" && event.toolName !== "edit")) return;
		const abs = toolPath(event.input, ctx.cwd);
		if (!abs) return;
		const rel = toProjectRelative(abs, ctx.cwd);
		if (!rel) return;
		recorder.record(rel);

		const loaded = await configForRun(ctx);
		if (!loaded) return;
		const routes = routeFiles(loaded.config.afterWrite, [rel]);
		if (routes.length === 0) {
			trace({ event: "afterWrite-skip", file: rel, tool: event.toolName, nested: Boolean(event.parentToolCallId) });
			return;
		}
		if (!(await ensureTrusted(ctx, loaded))) return;

		const before = await fileHash(abs);
		const ran: string[] = [];
		for (const { rule, files } of routes) {
			const outcome = await run(ctx, "afterWrite", rule, files);
			if (outcome.aborted) return;
			ran.push(rule.name);
			if (!outcome.ok && !outcome.timedOut) {
				ctx.ui.notify(
					`pi-hooks: formatter \`${rule.name}\` failed on ${rel} (exit ${outcome.code}):\n${truncateOutput(outcome.output, 800)}`,
					"warning",
				);
			}
		}
		const after = await fileHash(abs);
		if (before === after) return;
		trace({ event: "reformatted", file: rel, by: ran });
		const note = `[pi-hooks] ${rel} was reformatted by ${ran.map((n) => `\`${n}\``).join(", ")} after this ${event.toolName}. Its content on disk now differs from what you wrote; re-read it before the next edit (edit needs exact text).`;
		return {
			content: [...event.content, { type: "text", text: note }],
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const loaded = await configForRun(ctx);
		if (!loaded || loaded.config.beforeSettle.length === 0) return;
		counter.setMax(loaded.config.maxFixAttempts);

		if (snapshotPromise) await snapshotPromise;
		let changed: string[] | undefined;
		let source = "tools";
		if (runSnapshot) {
			changed = await changedSince(exec, ctx.cwd, runSnapshot);
			if (changed) source = "git";
		}
		changed ??= recorder.list(ctx.cwd);
		const routes = routeFiles(loaded.config.beforeSettle, changed);
		trace({ event: "settle", source, changed, routes: routes.map((r) => ({ rule: r.rule.name, files: r.files })) });
		if (routes.length === 0) return;
		if (!(await ensureTrusted(ctx, loaded))) return;

		const failures: { rule: HookRule; files: string[]; outcome: RunOutcome }[] = [];
		for (const { rule, files } of routes) {
			const outcome = await run(ctx, "beforeSettle", rule, files);
			if (outcome.aborted) return;
			// A timeout is reported to the user; it is not something the agent can fix.
			if (!outcome.ok && !outcome.timedOut) failures.push({ rule, files, outcome });
		}

		if (failures.length === 0) {
			if (counter.attempts > 0) ctx.ui.notify(`pi-hooks: checks pass after ${counter.attempts} fix attempt(s).`, "info");
			trace({ event: "settle-ok", attempts: counter.attempts });
			return;
		}

		const checkFailures: CheckFailure[] = failures.map(({ rule, files, outcome }) => ({
			name: rule.name,
			files,
			code: outcome.code,
			output: outcome.output,
		}));
		const details = { failures: checkFailures.map(({ name, files, code }) => ({ rule: name, files, code })) };

		const attempt = counter.tryConsume();
		if (attempt === undefined) {
			const text = giveUpMessage(checkFailures, counter.limit, loaded.config.maxOutputChars);
			ctx.ui.notify(
				`pi-hooks: gave up after ${counter.limit} fix attempt(s). Remaining errors:\n${failures
					.map(({ rule, files, outcome }) => `- ${rule.name} on ${files.join(", ")}:\n${truncateOutput(outcome.output, 600)}`)
					.join("\n")}`,
				"error",
			);
			trace({ event: "settle-giveup", attempts: counter.attempts, ...details, message: truncateOutput(text, 2000) });
			return {
				entries: [
					{ type: "custom_message", customType: MESSAGE_TYPE, display: true, content: text, details: { ...details, gaveUp: true } },
				],
			};
		}

		const text = fixRequestMessage(checkFailures, attempt, counter.limit, loaded.config.maxOutputChars);
		ctx.ui.notify(`pi-hooks: checks failed; asking the agent to fix (attempt ${attempt}/${counter.limit}).`, "warning");
		trace({ event: "settle-continue", attempt, ...details, message: truncateOutput(text, 2000) });
		return {
			entries: [{ type: "custom_message", customType: MESSAGE_TYPE, display: true, content: text, details: { ...details, attempt } }],
			continue: true,
		};
	});
}
