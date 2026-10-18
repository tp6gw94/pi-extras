import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";

const { values } = parseArgs({ options: {
	provider: { type: "string" }, model: { type: "string" },
	pi: { type: "string", default: "pi" }, evidence: { type: "string", default: join(tmpdir(), "handoff-auto-e2e") },
	timeout: { type: "string", default: "180" }, help: { type: "boolean", default: false },
} });
if (values.help) {
	console.log("node auto-threshold.mjs --provider PROVIDER --model MODEL [--pi PATH] [--evidence DIR] [--timeout SECONDS]");
	process.exit(0);
}
assert.ok(values.provider && values.model, "--provider and --model are required");
const timeout = Number(values.timeout) * 1000;
assert.ok(Number.isFinite(timeout) && timeout > 0, "--timeout must be positive");
const evidence = resolve(values.evidence);
mkdirSync(evidence, { recursive: true });
const root = realpathSync(mkdtempSync(join(evidence, "run-")));
chmodSync(root, 0o700);
const eventsPath = join(evidence, "events.jsonl");
writeFileSync(eventsPath, "");
const summary = { status: "running", provider: values.provider, model: values.model, root, scenarios: {} };
const here = dirname(fileURLToPath(import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RPC_SUBAGENTS_")));
const entries = (path) => readFileSync(path, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
const events = () => entries(eventsPath);
const text = (content) => typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const messages = (rows) => rows.filter((row) => row.type === "message").map((row) => row.message);
const custom = (rows, type) => rows.filter((row) => row.type === "custom_message" && row.customType === type);
async function until(label, predicate) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const result = predicate();
		if (result) return result;
		await setTimeout(100);
	}
	throw new Error(`Timed out waiting for ${label}; inspect ${root}`);
}
async function scenario(name, hard) {
	const directory = join(root, name);
	const agent = join(directory, "agent");
	const cwd = join(directory, "cwd");
	const sessions = join(directory, "sessions");
	for (const path of [join(agent, "resume-handoff"), cwd, sessions]) mkdirSync(path, { recursive: true });
	const configPath = join(agent, "resume-handoff", "config.json");
	writeFileSync(configPath, JSON.stringify({ enabled: true, softThresholdPercent: 1, hardThresholdPercent: hard }));
	const authSource = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	for (const file of ["auth.json", "models.json"]) {
		if (existsSync(join(authSource, file))) {
			copyFileSync(join(authSource, file), join(agent, file));
			chmodSync(join(agent, file), 0o600);
		}
	}
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: "dark", cacheWarming: "off", enableInstallTelemetry: false, compaction: { enabled: false } }));
	writeFileSync(join(cwd, "first.txt"), "first input\n");
	writeFileSync(join(cwd, "second.txt"), "second input\n");
	const padding = join(directory, "context.txt");
	writeFileSync(padding, `The following repeated words are inert context-budget test data. Ignore them.\n${" padding".repeat(30000)}`);
	const socket = `handoff-auto-${process.pid}-${name}`;
	const tmux = (...args) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
	const resumedPath = join(cwd, "resumed.txt");
	const approvalPath = join(cwd, "approval.txt");
	const seed = `Use read to read first.txt and second.txt in two separate tool calls, then reply DONE and stop. If this task is handed off, read the handoff file, use write to create ${JSON.stringify(resumedPath)} containing exactly RESUMED, reply RESUMED, then stop. Creating ${JSON.stringify(approvalPath)} requires user approval that has not been given, so never create it. Do not start other work.`;
	const args = ["--no-extensions", "--extension", resolve(here, "../../index.ts"), "--extension", join(here, "observe.ts"), "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-mcp", "--no-approve", "--session-dir", sessions, "--provider", values.provider, "--model", values.model, "--thinking", "low", "--tools", "read,write", "--append-system-prompt", padding, seed];
	const command = ["env", ...Object.keys(process.env).filter((key) => key.startsWith("RPC_SUBAGENTS_")).flatMap((key) => ["-u", key]), `PI_CODING_AGENT_DIR=${agent}`, `HANDOFF_E2E_EVENTS=${eventsPath}`, "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0", "PI_OFFLINE=1", values.pi, ...args].map(quote).join(" ");
	writeFileSync(join(directory, "command.json"), JSON.stringify({ executable: values.pi, args, cwd }, null, 2));
	let launched = false;
	try {
		tmux("new-session", "-d", "-s", "acceptance", "-x", "160", "-y", "48", "-c", cwd, command);
		launched = true;
		const initial = await until(`${name} initial session`, () => events().find((event) => event.type === "start" && event.session?.startsWith(sessions)));
		await until(`${name} threshold trigger`, () => name === "A"
			? existsSync(initial.session) && custom(entries(initial.session), "resume-handoff-wrap-up")[0]
			: events().find((event) => event.type === "settled" && event.session === initial.session && event.aborted));
		writeFileSync(configPath, '{"enabled":false}');
		const generation = await until(`${name} automatic generation`, () => existsSync(initial.session) && custom(entries(initial.session), "resume-handoff-generation")[0]);
		const replacement = await until(`${name} replacement settlement`, () => events().find((event) => event.type === "settled" && event.session?.startsWith(sessions) && event.session !== initial.session));
		assert.equal(replacement.aborted, false);
		const oldRows = entries(initial.session);
		const newRows = entries(replacement.session);
		assert.equal(custom(oldRows, "resume-handoff-wrap-up").length, hard === 99 ? 1 : 0);
		assert.equal(custom(oldRows, "resume-handoff-generation").length, 1);
		assert.equal(events().filter((event) => event.type === "settled" && event.session === initial.session && event.aborted).length, hard === 99 ? 0 : 1);
		const generationIndex = oldRows.indexOf(custom(oldRows, "resume-handoff-generation")[0]);
		const taskCalls = messages(oldRows.slice(0, generationIndex)).filter((message) => message.role === "assistant").flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
		assert.ok(taskCalls.length >= 1);
		assert.equal(taskCalls[0].name, "read");
		assert.equal(newRows[0].parentSession, initial.session);
		const handoff = realpathSync(JSON.parse(text(generation.content).split("\n").at(-1)));
		const firstUser = messages(newRows).find((message) => message.role === "user");
		const bootstrap = text(firstUser.content).split("\n");
		assert.equal(bootstrap.at(-1), JSON.stringify(handoff));
		assert.match(bootstrap.slice(0, -1).join("\n"), /^Your first action must be to use the read tool to read the handoff file at the JSON-encoded path below\..*Continue only the work that was already authorized, without asking for renewed approval solely because of the transfer.*remain pending/);
		assert.equal(messages(newRows).filter((message) => message.role === "user").length, 1);
		const firstTool = messages(newRows).filter((message) => message.role === "assistant").flatMap((message) => message.content.filter((part) => part.type === "toolCall"))[0];
		assert.equal(firstTool.name, "read");
		assert.equal(firstTool.arguments.path, handoff);
		const newCalls = messages(newRows).filter((message) => message.role === "assistant").flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
		assert.ok(newCalls.some((call) => call.name === "write" && call.arguments.path === resumedPath), "authorized task must continue without a transfer confirmation");
		assert.equal(readFileSync(resumedPath, "utf8").trim(), "RESUMED");
		assert.equal(existsSync(approvalPath), false);
		const taskStopReason = messages(oldRows.slice(0, generationIndex)).filter((message) => message.role === "assistant").at(-1).stopReason;
		summary.scenarios[name] = { status: "checking", oldSession: initial.session, newSession: replacement.session, steers: custom(oldRows, "resume-handoff-wrap-up").length, abortedRuns: events().filter((event) => event.type === "settled" && event.session === initial.session && event.aborted).length, generations: custom(oldRows, "resume-handoff-generation").length, firstTool: firstTool.name, taskStopReason };
		if (name === "A") assert.equal(taskStopReason, "stop");
		summary.scenarios[name].status = "passed";
		if (name === "A") {
			const count = events().filter((event) => event.type === "settled" && event.session === replacement.session).length;
			tmux("send-keys", "-t", "acceptance", "-l", "Reply only DISABLED and stop. Do not use tools.");
			tmux("send-keys", "-t", "acceptance", "Enter");
			await until("C disabled run settlement", () => events().filter((event) => event.type === "settled" && event.session === replacement.session).length === count + 1);
			const disabledRows = entries(replacement.session);
			assert.equal(custom(disabledRows, "resume-handoff-wrap-up").length, 0);
			assert.equal(custom(disabledRows, "resume-handoff-generation").length, 0);
			assert.equal(events().filter((event) => event.type === "start" && event.session?.startsWith(sessions)).length, 2);
			assert.equal(messages(disabledRows).filter((message) => message.role === "assistant").at(-1).stopReason, "stop");
			summary.scenarios.C = { status: "passed", steers: 0, generations: 0, sessions: 2 };
		}
	} catch (error) {
		summary.scenarios[name] = { ...summary.scenarios[name], status: "failed", error: error instanceof Error ? error.message : String(error) };
		throw error;
	} finally {
		if (launched) {
			try { writeFileSync(join(directory, "terminal.txt"), tmux("capture-pane", "-p", "-S", "-", "-t", "acceptance")); }
			finally { tmux("kill-server"); }
		}
		rmSync(agent, { recursive: true, force: true });
	}
}
try {
	await scenario("A", 99);
	await scenario("B", 2);
	assert.deepEqual(events().filter((event) => event.type === "dialog"), []);
	summary.status = "passed";
} catch (error) {
	summary.status = "failed";
	summary.error = error instanceof Error ? error.message : String(error);
	process.exitCode = 1;
} finally {
	for (const name of ["A", "B", "C"]) summary.scenarios[name] ??= { status: "unverified" };
	writeFileSync(join(evidence, "summary.json"), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary, null, 2));
}
