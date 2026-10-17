import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
	provider: { type: "string" },
	model: { type: "string" },
	pi: { type: "string", default: "pi" },
	thinking: { type: "string", default: "low" },
	evidence: { type: "string", default: tmpdir() },
	"auth-source": { type: "string", default: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent") },
	timeout: { type: "string", default: "240" },
	help: { type: "boolean", default: false },
} });
if (values.help) {
	console.log("node replacement.mjs --provider PROVIDER --model MODEL [--pi PATH] [--thinking low] [--evidence DIR] [--auth-source AGENT_DIR] [--timeout SECONDS]");
	process.exit(0);
}
assert.ok(values.provider && values.model, "--provider and --model are required");
const budget = Number(values.timeout) * 1000;
assert.ok(Number.isFinite(budget) && budget > 0, "--timeout must be positive");
mkdirSync(values.evidence, { recursive: true });
const evidence = realpathSync(values.evidence);
const root = realpathSync(mkdtempSync(join(evidence, "replacement-")));
chmodSync(root, 0o700);
const eventsPath = join(evidence, "events.jsonl");
const summaryPath = join(evidence, "summary.json");
const stderrPath = join(root, "stderr.log");
writeFileSync(eventsPath, "");
const cwd = join(root, "cwd");
const sessions = join(root, "sessions");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessions, { recursive: true });
const agent = join(root, "agent");
mkdirSync(agent, { mode: 0o700 });
for (const name of ["auth.json", "models.json"]) {
	const source = join(values["auth-source"], name);
	if (!existsSync(source)) continue;
	copyFileSync(source, join(agent, name));
	chmodSync(join(agent, name), 0o600);
}
writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme: "dark", cacheWarming: "off", enableInstallTelemetry: false }));
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../../index.ts");
const toolList = "read,bash,edit,write,codemode,rpc_subagents_run,rpc_subagents_status,rpc_subagents_result,rpc_subagents_wait,rpc_subagents_cancel,rpc_subagents_respond,rpc_subagents_pending,rpc_subagents_reply,rpc_subagents_steer,rpc_subagents_view,rpc_subagents_schedule_create,rpc_subagents_schedule_list,rpc_subagents_schedule_pause,rpc_subagents_schedule_resume,rpc_subagents_schedule_cancel";
const startedAt = Date.now();
const evidenceCommandPath = join(root, "command.json");
const summary = {
	status: "running", provider: values.provider, model: values.model, pi: values.pi,
	startedAt: new Date(startedAt).toISOString(), pids: {}, tasks: {},
	steps: { 1: "pending", 2: "pending", 3: "pending", 4: "pending", 5: "pending" },
	timings: {},
};
const events = [];
const pendingResponses = new Map();
const recordedPids = [];
let nextRequestId = 0;
let step = "setup";
let piProc;
let buffer = "";

function writeSummary() {
	writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
}
function remaining() {
	return Math.max(1000, budget - (Date.now() - startedAt));
}
function alive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
function processRows() {
	const output = execFileSync("ps", ["-ax", "-ww", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
	return output.split("\n").flatMap((line) => {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
	});
}
function findPid(predicate) {
	return processRows().find(predicate)?.pid;
}
function leaseChildPid(taskId) {
	const leases = join(realpathSync(join(agent, "rpc-subagents", "data")), "session-leases");
	if (!existsSync(leases)) return undefined;
	for (const name of readdirSync(leases)) {
		const file = join(leases, name, "owner.json");
		if (!existsSync(file)) continue;
		try {
			const owner = JSON.parse(readFileSync(file, "utf8"));
			if (owner.taskId === taskId && Number.isInteger(owner.childPid) && owner.childPid > 0) return owner.childPid;
		} catch {}
	}
	return undefined;
}
async function waitUntil(label, predicate, ms) {
	const deadline = Date.now() + Math.min(ms, remaining());
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await delay(100);
	}
}
async function waitEvent(label, predicate, ms = remaining()) {
	return waitUntil(label, () => {
		for (let index = 0; index < events.length; index += 1) if (predicate(events[index], index)) return events[index];
		return undefined;
	}, ms);
}
function request(command) {
	const id = `req-${++nextRequestId}`;
	return new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			pendingResponses.delete(id);
			rejectPromise(new Error(`Timed out waiting for ${command.type} response`));
		}, remaining());
		pendingResponses.set(id, {
			resolve: (record) => { clearTimeout(timer); resolvePromise(record); },
			reject: (error) => { clearTimeout(timer); rejectPromise(error); },
		});
		piProc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
	});
}
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}
function eventTexts(from) {
	const texts = [];
	for (const event of events.slice(from)) {
		if (event.type === "message_end" && event.message?.role === "assistant") texts.push({ source: "assistant", text: textOf(event.message.content) });
		if (event.type === "tool_execution_end" && event.toolName === "codemode" && !event.isError) texts.push({ source: "codemode", text: textOf(event.result?.content) });
	}
	return texts;
}
async function prompt(text, label) {
	const mark = events.length;
	const response = await request({ type: "prompt", message: text });
	assert.equal(response.success, true, `${label}: prompt rejected: ${response.error ?? ""}`);
	return mark;
}
async function settle(label, from) {
	return waitEvent(`${label} settlement`, (event, index) => index >= from && event.type === "agent_settled", remaining());
}
function spawnPrompt(name, seconds, tag) {
	const childPrompt = `Run the shell command \`sleep ${seconds}\` with bash, then reply with the single word done.`;
	return [
		"Use the codemode tool exactly once with this script:",
		`const task = await tools.rpc_subagents_run({ name: ${JSON.stringify(name)}, async: true, tools: ["bash"], prompt: ${JSON.stringify(childPrompt)} });`,
		"return { taskId: task.taskId, status: task.status };",
		`After the tool result, reply with exactly one line and nothing else: ${tag} <taskId>`,
	].join("\n");
}
function callPrompt(tool, taskId, tag) {
	return [
		"Use the codemode tool exactly once with this script, even if you already know the answer:",
		`const result = await tools.${tool}({ taskId: ${JSON.stringify(taskId)} });`,
		"return { taskId: result.taskId, status: result.status, text: result.text };",
		`After the tool result, reply with exactly one line and nothing else: ${tag} <status>`,
	].join("\n");
}
function firstMatch(from, source, pattern) {
	for (const entry of eventTexts(from)) {
		if (entry.source !== source) continue;
		const match = entry.text.match(pattern);
		if (match) return match[1];
	}
	return undefined;
}
function extractTaskId(from, tag) {
	return firstMatch(from, "assistant", new RegExp(`${tag}\\s+([0-9a-f-]{36})`, "i")) ?? firstMatch(from, "codemode", /"taskId":\s*"([0-9a-f-]{36})"/);
}
function extractStatus(from, tag) {
	return firstMatch(from, "assistant", new RegExp(`${tag}\\s+([a-z_]+)`, "i")) ?? firstMatch(from, "codemode", /"status":\s*"([a-z_]+)"/);
}
async function spawnAsyncTask(name, seconds, tag) {
	const mark = await prompt(spawnPrompt(name, seconds, tag), tag);
	await settle(tag, mark);
	const taskId = extractTaskId(mark, tag);
	assert.ok(taskId, `${tag}: task id must be reported`);
	const childPid = await waitUntil(`${tag} child pid`, () => leaseChildPid(taskId), 60000);
	await waitUntil(`${tag} child process`, () => processRows().some((row) => row.pid === childPid && row.ppid === piProc.pid), 15000);
	recordedPids.push(childPid);
	assert.ok(alive(childPid), `${tag}: child pid must be alive`);
	return { taskId, childPid };
}
const isCompletionNotice = (event, taskId) =>
	event.type === "message_start" && event.message?.role === "custom" && event.message?.customType === "rpc-subagents-completion" && event.message?.details?.taskId === taskId;

let failure;
let graceClosed = false;
try {
	const args = [
		"--mode", "rpc",
		"--no-extensions", "--extension", extension, "--extension", "builtin:codemode",
		"--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-mcp", "--no-approve",
		"--session-dir", sessions,
		"--provider", values.provider, "--model", values.model, "--thinking", values.thinking,
		"--tools", toolList,
	];
	writeFileSync(evidenceCommandPath, JSON.stringify({ command: values.pi, args, cwd, agent }, null, 2) + "\n");
	const spawnEnv = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1" };
	for (const key of Object.keys(spawnEnv)) if (key.startsWith("RPC_SUBAGENTS_")) delete spawnEnv[key];
	piProc = spawn(values.pi, args, {
		cwd,
		env: spawnEnv,
		stdio: ["pipe", "pipe", "pipe"],
	});
	summary.pids.pi = piProc.pid;
	recordedPids.push(piProc.pid);
	piProc.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let index = buffer.indexOf("\n");
		while (index !== -1) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line.trim()) continue;
			appendFileSync(eventsPath, `${line}\n`);
			let record;
			try { record = JSON.parse(line); } catch { continue; }
			events.push(record);
			if (record.type === "response" && record.id) {
				const entry = pendingResponses.get(record.id);
				if (entry) { pendingResponses.delete(record.id); entry.resolve(record); }
			}
		}
	});
	piProc.stderr.on("data", (chunk) => appendFileSync(stderrPath, chunk));
	piProc.on("error", (error) => {
		for (const entry of pendingResponses.values()) entry.reject(new Error(`pi process error: ${error.message}`));
		pendingResponses.clear();
	});
	piProc.on("close", (code, signal) => {
		summary.exit = { code, signal };
		for (const entry of pendingResponses.values()) entry.reject(new Error(`pi exited before responding (code ${code}, signal ${signal})`));
		pendingResponses.clear();
	});

	step = "1";
	const step1Start = Date.now();
	const survivor = await spawnAsyncTask("survivor", 75, "TASK");
	summary.tasks.survivor = { taskId: survivor.taskId, childPid: survivor.childPid, startedAt: new Date().toISOString() };
	summary.pids.survivorChild = survivor.childPid;
	const survivorSleepPid = await waitUntil("survivor sleep process", () => findPid((row) => row.command.includes("sleep 75")), 90000);
	summary.tasks.survivor.sleepPid = survivorSleepPid;
	summary.pids.survivorSleep = survivorSleepPid;
	summary.steps[1] = "passed";
	summary.timings.step1Ms = Date.now() - step1Start;
	writeSummary();

	step = "2";
	const step2Start = Date.now();
	await delay(250);
	const replacement = await request({ type: "new_session" });
	assert.equal(replacement.success, true, `step 2: new_session failed: ${replacement.error ?? ""}`);
	assert.equal(replacement.data?.cancelled, false, "step 2: new_session must not be cancelled");
	await delay(500);
	assert.ok(alive(survivor.childPid), "step 2: survivor child must still be alive after session replacement");
	assert.ok(alive(survivorSleepPid), "step 2: sleep must still be running after session replacement");
	summary.steps[2] = "passed";
	summary.timings.step2Ms = Date.now() - step2Start;
	writeSummary();

	step = "3";
	const step3Start = Date.now();
	const newSessionMark = events.length;
	const firstStatus = await prompt(callPrompt("rpc_subagents_status", survivor.taskId, "STATUS"), "step 3");
	await settle("step 3", firstStatus);
	let status = extractStatus(firstStatus, "STATUS");
	if (status === "starting") {
		await delay(10000);
		const retry = await prompt(callPrompt("rpc_subagents_status", survivor.taskId, "STATUS"), "step 3 retry");
		await settle("step 3 retry", retry);
		status = extractStatus(retry, "STATUS");
	}
	assert.equal(status, "running", "step 3: task status in the replaced session");
	summary.steps[3] = "passed";
	summary.timings.step3Ms = Date.now() - step3Start;
	writeSummary();

	step = "4";
	const step4Start = Date.now();
	const completion = await waitEvent("completion notice in the new session", (event, index) => index >= newSessionMark && isCompletionNotice(event, survivor.taskId), 180000);
	const completionIndex = events.indexOf(completion);
	await waitEvent("turn started after the completion notice", (event, index) => index > completionIndex && event.type === "message_start" && event.message?.role === "assistant", remaining());
	await waitEvent("completion wake settlement", (event, index) => index > completionIndex && event.type === "agent_settled", remaining());
	const resultMark = await prompt(callPrompt("rpc_subagents_result", survivor.taskId, "RESULT"), "step 4");
	await settle("step 4", resultMark);
	const resultText = await waitUntil("step 4: rpc_subagents_result output", () => {
		for (const entry of eventTexts(resultMark)) {
			if (entry.source === "codemode" && entry.text.includes(survivor.taskId)) return entry.text;
		}
		return undefined;
	}, 120000);
	assert.match(resultText, new RegExp(`"taskId":\\s*"${survivor.taskId}"`), "step 4: result must describe the survivor task");
	assert.match(resultText, /"status":\s*"completed"/, "step 4: result status must be completed");
	assert.match(resultText, /"text":\s*"[^"]*done/i, "step 4: result text must contain done");
	summary.tasks.survivor.status = "completed";
	summary.tasks.survivor.completedAt = new Date().toISOString();
	summary.steps[4] = "passed";
	summary.timings.step4Ms = Date.now() - step4Start;
	writeSummary();

	step = "5";
	const step5Start = Date.now();
	const second = await spawnAsyncTask("second", 60, "TASK2");
	summary.tasks.second = { taskId: second.taskId, childPid: second.childPid, startedAt: new Date().toISOString(), status: "running" };
	summary.pids.secondChild = second.childPid;
	summary.tasks.second.sleepPid = await waitUntil("second sleep process", () => findPid((row) => row.command.includes("sleep 60")), 90000);
	summary.pids.secondSleep = summary.tasks.second.sleepPid;
	const quitAt = Date.now();
	piProc.stdin.end();
	await waitUntil("second child death after graceful quit", () => !alive(second.childPid), 10000);
	summary.tasks.second.status = "killed after graceful quit";
	summary.tasks.second.childDeathAfterQuitMs = Date.now() - quitAt;
	await Promise.race([once(piProc, "close"), delay(5000)]);
	graceClosed = true;
	summary.steps[5] = "passed";
	summary.timings.step5Ms = Date.now() - step5Start;
	summary.status = "passed";
	writeSummary();
} catch (error) {
	failure = error;
	summary.status = "failed";
	summary.steps[step] = `failed: ${error.message}`;
	if (summary.tasks.survivor) summary.tasks.survivor.status ??= "unknown";
	if (summary.tasks.second) summary.tasks.second.status ??= "unknown";
	writeSummary();
} finally {
	if (piProc && piProc.exitCode === null && !graceClosed) {
		try { piProc.kill("SIGKILL"); } catch {}
	}
	for (const pid of recordedPids) {
		if (!alive(pid)) continue;
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
	if (existsSync(join(agent, "auth.json"))) rmSync(join(agent, "auth.json"), { force: true });
	if (existsSync(join(agent, "models.json"))) rmSync(join(agent, "models.json"), { force: true });
	summary.finishedAt = new Date().toISOString();
	summary.timings.totalMs = Date.now() - startedAt;
	writeSummary();
}

if (failure) {
	console.error(`Step ${step} failed: ${failure.message}`);
	console.error(`Evidence: ${eventsPath}`);
	console.error(`Summary: ${summaryPath}`);
	console.error(`Pi stderr: ${stderrPath}`);
	process.exit(1);
}
console.log(`Passed. Evidence saved in ${evidence}`);
