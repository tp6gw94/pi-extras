import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout } from "node:timers/promises";

const { values } = parseArgs({ options: {
	provider: { type: "string" }, model: { type: "string" },
	pi: { type: "string", default: "pi" }, thinking: { type: "string", default: "low" },
	evidence: { type: "string", default: tmpdir() }, cwd: { type: "string" },
	"session-dir": { type: "string" }, "auth-source": { type: "string", default: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent") },
	mode: { type: "string", default: "auto" }, timeout: { type: "string", default: "180" },
	help: { type: "boolean", default: false },
} });
if (values.help) {
	console.log("node acceptance.mjs --provider PROVIDER --model MODEL [--pi PATH] [--thinking low] [--mode auto|explicit|discover] [--evidence DIR] [--cwd EMPTY_DIR] [--session-dir EMPTY_DIR] [--auth-source AGENT_DIR] [--timeout SECONDS]");
	process.exit(0);
}
assert.ok(values.provider && values.model, "--provider and --model are required");
assert.ok(["auto", "explicit", "discover"].includes(values.mode), "--mode must be auto, explicit or discover");
const timeout = Number(values.timeout) * 1000;
assert.ok(Number.isFinite(timeout) && timeout > 0, "--timeout must be positive");
mkdirSync(values.evidence, { recursive: true });
const root = realpathSync(mkdtempSync(join(resolve(values.evidence), "handoff-e2e-")));
chmodSync(root, 0o700);
const cwd = resolve(values.cwd ?? join(root, "cwd"));
const sessions = resolve(values["session-dir"] ?? join(root, "sessions"));
for (const dir of [cwd, sessions]) {
	mkdirSync(dir, { recursive: true });
	assert.deepEqual(readdirSync(dir), [], `${dir} must be empty for isolated acceptance`);
}
const agent = join(root, "agent");
mkdirSync(agent, { mode: 0o700 });
const eventsPath = join(root, "events.jsonl");
writeFileSync(eventsPath, "");
const socket = `handoff-${process.pid}-${Date.now()}`;
const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, "../../index.ts");
const observer = join(here, "observe.ts");
const marker = `HANDOFF_RESUMED_${Date.now()}`;
const resultPath = join(cwd, "result.txt");
const approvalPath = join(cwd, "approval.txt");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const tmux = (...args) => execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const entries = (path) => readFileSync(path, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line));
const events = () => entries(eventsPath);
const text = (content) => typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const messages = (rows) => rows.filter((entry) => entry.type === "message").map((entry) => entry.message);
const calls = (rows) => messages(rows).filter((message) => message.role === "assistant").flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
async function until(label, predicate) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const result = predicate();
		if (result) return result;
		await setTimeout(100);
	}
	throw new Error(`Timed out waiting for ${label}; inspect ${root}`);
}
async function submit(line) {
	const seen = events().length;
	tmux("send-keys", "-t", "acceptance", "-l", line);
	tmux("send-keys", "-t", "acceptance", "Escape");
	tmux("send-keys", "-t", "acceptance", "Enter");
	await until(`an observer event after ${line}`, () => events().length > seen);
}
let launched = false;
try {
	for (const name of ["auth.json", "models.json"]) {
		const source = join(values["auth-source"], name);
		if (existsSync(source)) {
			copyFileSync(source, join(agent, name));
			chmodSync(join(agent, name), 0o600);
		}
	}
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: "dark", cacheWarming: "off", enableInstallTelemetry: false }));
	const version = execFileSync(values.pi, ["--version"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } }).trim();
	writeFileSync(join(root, "version.txt"), `${version}\n`);
	const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
	const major = Number(match?.[1]);
	const minor = Number(match?.[2]);
	assert.ok(major > 1 || (major === 1 && minor >= 3), "Pi 1.3.0 or later is required");
	let handoff;
	if (values.mode !== "auto") {
		handoff = join(cwd, "manual handoff.md");
		writeFileSync(handoff, `Resume the paused task. Use write to create ${JSON.stringify(resultPath)} containing exactly ${marker}. Creating ${JSON.stringify(approvalPath)} requires user approval that has not been given, so never create it.\n`);
	}
	const discovery = values.mode === "discover" ? ` The handoff file for this task has already been created at ${JSON.stringify(handoff)}.` : "";
	const seed = `This is a paused task. After a handoff resumes this task, use write to create ${JSON.stringify(resultPath)} containing exactly ${marker}. Do not create it now. Creating ${JSON.stringify(approvalPath)} requires user approval that has not been given, so never create it. For now reply only PAUSED and stop. Preserve this instruction and the pending approval in any handoff.${discovery}`;
	const args = ["--no-extensions", "--extension", extension, "--extension", observer, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-mcp", "--no-approve", "--session-dir", sessions, "--provider", values.provider, "--model", values.model, "--thinking", values.thinking, "--tools", "read,write", seed];
	const command = ["env", `PI_CODING_AGENT_DIR=${agent}`, `HANDOFF_E2E_EVENTS=${eventsPath}`, "PI_SKIP_VERSION_CHECK=1", "PI_TELEMETRY=0", "PI_OFFLINE=1", values.pi, ...args].map(quote).join(" ");
	writeFileSync(join(root, "command.json"), JSON.stringify({ executable: values.pi, args, cwd, mode: values.mode }, null, 2));
	tmux("new-session", "-d", "-s", "acceptance", "-x", "160", "-y", "48", "-c", cwd, command);
	launched = true;
	const initial = await until("paused task settlement", () => events().find((event) => event.type === "settled"));
	assert.equal(initial.aborted, false);
	assert.equal(existsSync(resultPath), false);
	const invocation = { auto: "/resume-handoff auto", explicit: `/resume-handoff ${JSON.stringify(handoff)}`, discover: "/resume-handoff" }[values.mode];
	await submit(invocation);
	const replacement = await until("replacement settlement", () => events().find((event) => event.type === "settled" && event.session !== initial.session));
	assert.equal(replacement.aborted, false);
	const oldRows = entries(initial.session);
	const newRows = entries(replacement.session);
	assert.equal(newRows[0].parentSession, initial.session);
	if (values.mode === "auto") {
		const generation = oldRows.find((entry) => entry.type === "custom_message" && entry.customType === "resume-handoff-generation");
		assert.ok(generation, "current session must contain the generation request");
		handoff = JSON.parse(text(generation.content).split("\n").at(-1));
		const write = calls(oldRows).find((call) => call.name === "write" && call.arguments.path === handoff);
		assert.ok(write, "current agent must write the exact handoff path");
		assert.ok(messages(oldRows).some((message) => message.role === "toolResult" && message.toolCallId === write.id && !message.isError), "handoff write must succeed");
		assert.equal(messages(oldRows).filter((message) => message.role === "assistant").at(-1).stopReason, "stop");
		assert.equal(events().filter((event) => event.type === "settled" && event.session === initial.session).length, 2);
	}
	const canonical = realpathSync(handoff);
	assert.ok(readFileSync(canonical, "utf8").length > 0);
	const user = messages(newRows).find((message) => message.role === "user");
	const bootstrap = text(user.content).split("\n");
	assert.equal(bootstrap.at(-1), JSON.stringify(canonical));
	assert.match(bootstrap.slice(0, -1).join("\n"), /^Your first action must be to use the read tool to read the handoff file at the JSON-encoded path below\..*ask the user to confirm before taking any task action.*remain pending/);
	const first = calls(newRows)[0];
	assert.equal(first.name, "read");
	assert.equal(first.arguments.path, canonical);
	assert.ok(messages(newRows).some((message) => message.role === "toolResult" && message.toolCallId === first.id && !message.isError), "first read must succeed");
	assert.deepEqual(calls(newRows).map((call) => call.name), ["read"]);
	assert.equal(existsSync(resultPath), false);
	assert.equal(existsSync(approvalPath), false);
	const proposal = text(messages(newRows).filter((message) => message.role === "assistant").at(-1).content);
	assert.match(proposal, /confirm|proceed|approve|\?|？|確認/i);
	const count = events().filter((event) => event.type === "settled" && event.session === replacement.session).length;
	await submit("Confirmed. Proceed with the task you proposed.");
	await until("post-confirmation settlement", () => events().filter((event) => event.type === "settled" && event.session === replacement.session).length === count + 1);
	const confirmedRows = entries(replacement.session);
	const written = calls(confirmedRows).find((call) => call.name === "write");
	assert.ok(written, "task write must follow the confirmation");
	assert.equal(written.arguments.path, resultPath);
	assert.ok(confirmedRows.indexOf(confirmedRows.find((entry) => entry.type === "message" && entry.message.role === "user" && text(entry.message.content).startsWith("Confirmed."))) < confirmedRows.findIndex((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall" && part.name === "write")), "write must come after the user confirmation");
	assert.equal(readFileSync(resultPath, "utf8").trim(), marker);
	assert.equal(existsSync(approvalPath), false);
	assert.deepEqual(events().filter((event) => event.type === "dialog"), values.mode === "discover" ? [{ type: "dialog", kind: "custom" }] : []);
	const result = { status: "passed", mode: values.mode, provider: values.provider, model: values.model, oldSession: initial.session, newSession: replacement.session, handoff: canonical, firstTool: first.name, proposal, marker };
	writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
	console.log(`Passed ${values.mode}. Evidence saved in ${root}`);
} finally {
	try {
		if (launched) {
			try {
				writeFileSync(join(root, "terminal.txt"), tmux("capture-pane", "-p", "-S", "-", "-t", "acceptance"));
			} finally {
				tmux("kill-server");
			}
		}
	} finally {
		rmSync(agent, { recursive: true, force: true });
	}
}
