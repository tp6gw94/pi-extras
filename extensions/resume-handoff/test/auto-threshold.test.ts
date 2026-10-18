import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createHarness, makeDir, settle, withDeadline } from "./harness.ts";

const steer = { message: { customType: "resume-handoff-wrap-up", content: "Context is nearly full and this session will be handed off. Finish the current step only. Start nothing new. Summarise the current state, then end your turn.", display: true }, options: { deliverAs: "steer" } };
const invalid = { message: "自動交接設定無效，已停用；請檢查 resume-handoff/config.json", level: "warning" };
type Harness = ReturnType<typeof createHarness>;

function assertDispatched(harness: Harness, count: number) {
	assert.equal(harness.state.userMessages.length, count);
	for (const message of harness.state.userMessages) {
		assert.match(message.text, /^\/resume-handoff-threshold [0-9a-f-]{36}$/);
		assert.deepEqual(message.options, { expandPromptTemplates: true });
	}
}

function configDir(t: test.TestContext, config: string | null) {
	const agentDir = makeDir();
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	mkdirSync(join(agentDir, "resume-handoff"));
	const path = join(agentDir, "resume-handoff", "config.json");
	if (config !== null) writeFileSync(path, config);
	return { agentDir, path };
}

async function fixture(t: test.TestContext, config: string | null = '{"enabled":true}', options: Parameters<typeof createHarness>[0] = {}) {
	const { agentDir, path } = configDir(t, config);
	const harness = createHarness({ agentDir, pendingMessages: true, ...options });
	await harness.startSession();
	return { harness, path };
}

async function restart(path: string, config: string, options: Parameters<typeof createHarness>[0] = {}) {
	writeFileSync(path, config);
	const harness = createHarness({ agentDir: join(path, "../.."), pendingMessages: true, ...options });
	await harness.startSession();
	return harness;
}

function usage(harness: Harness, percent: number | null | undefined) {
	harness.state.usage = percent === undefined ? undefined : { tokens: null, contextWindow: 1000, percent };
}

async function turn(harness: Harness, percent: number | null | undefined) {
	usage(harness, percent);
	await harness.fire("turn_end");
}

async function settled(harness: Harness, percent: number | null | undefined, aborted = false) {
	usage(harness, percent);
	await harness.fire("agent_settled", { aborted });
	await Promise.all(harness.state.commandRuns);
}

for (const config of [null, "{}", '{"enabled":false}', '{"enabled":"true"}']) {
	test(`inert configuration ${config}`, async (t) => {
		const { harness, path } = await fixture(t, config);
		assert.equal(harness.permanentHandlerCount(), 9);
		await turn(harness, 90);
		await settled(harness, 90);
		assert.deepEqual(harness.state.steers, []);
		assert.equal(harness.state.aborts, 0);
		assert.deepEqual(harness.state.userMessages, []);
		assert.deepEqual(harness.state.notifications, config === '{"enabled":"true"}' ? [invalid] : []);
		const enabled = await restart(path, '{"enabled":true}');
		await turn(enabled, 75);
		assert.deepEqual(enabled.state.steers, [steer]);
	});
}

for (const config of [
	'{"enabled":true,"softThresholdPercent":0}',
	'{"enabled":true,"hardThresholdPercent":75}',
	'{"enabled":true,"softThresholdPercent":89}',
	'{"enabled":true,"hardThresholdPercent":100}',
	'{"enabled":true,"softThresholdPercent":"75"}',
	'{"enabled":true,"softThresholdPercent":null}',
	'{"enabled":true,"softThresholdPercent":1e999}',
	'[]', 'null', '{',
]) {
	test(`invalid configuration warns once per session start ${config}`, async (t) => {
		const { harness, path } = await fixture(t, config);
		await turn(harness, 90);
		await settled(harness, 90);
		assert.deepEqual(harness.state.notifications, [invalid]);
		assert.equal(harness.state.aborts, 0);
		assert.deepEqual(harness.state.steers, []);
		assert.deepEqual(harness.state.userMessages, []);
		const valid = await restart(path, '{"enabled":true}');
		await turn(valid, 75);
		assert.deepEqual(valid.state.notifications, []);
		assert.deepEqual(valid.state.steers, [steer]);
		const again = await restart(path, config);
		assert.deepEqual(again.state.notifications, [invalid]);
	});
}

test("unreadable config is invalid; rpc never reads it", async (t) => {
	const { agentDir, path } = configDir(t, null);
	mkdirSync(path);
	const harness = createHarness({ agentDir });
	await harness.startSession();
	assert.deepEqual(harness.state.notifications, [invalid]);
	const rpc = createHarness({ agentDir, mode: "rpc" });
	await rpc.startSession();
	await turn(rpc, 90);
	await settled(rpc, 90);
	assert.deepEqual(rpc.state.notifications, []);
	assert.equal(rpc.state.aborts, 0);
	assert.deepEqual(rpc.state.userMessages, []);
	assert.deepEqual(rpc.state.steers, []);
});

test("rpc with valid configuration remains inert at hard usage", async (t) => {
	const { harness, path } = await fixture(t, '{"enabled":true}', { mode: "rpc" });
	await turn(harness, 90);
	await settled(harness, 90);
	assert.deepEqual(harness.state.notifications, []);
	assert.deepEqual(harness.state.steers, []);
	assert.deepEqual(harness.state.userMessages, []);
	assert.equal(harness.state.aborts, 0);
	const tui = createHarness({ agentDir: join(path, "../..") });
	await tui.startSession();
	await turn(tui, 90);
	assert.equal(tui.state.aborts, 1);
});

test("default soft threshold leaves fractional usage below 75 untouched", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 74.9);
	await settled(harness, 74.9);
	assert.deepEqual(harness.state.steers, []);
	assert.deepEqual(harness.state.userMessages, []);
	assert.equal(harness.state.aborts, 0);
	await turn(harness, 75);
	assert.deepEqual(harness.state.steers, [steer]);
});

test("custom thresholds apply at equality", async (t) => {
	const { harness } = await fixture(t, '{"enabled":true,"softThresholdPercent":60,"hardThresholdPercent":70}');
	await turn(harness, 59.9);
	assert.equal(harness.state.steers.length, 0);
	await turn(harness, 60);
	assert.deepEqual(harness.state.steers, [steer]);
	await turn(harness, 70);
	assert.equal(harness.state.aborts, 1);
});

for (const [values, steers, aborts] of [
	[[74, 75, 80], 1, 0], [[75, 88], 1, 1], [[90], 0, 1], [[90, 91, 80], 0, 1],
	[[74.9, undefined, null, 75], 1, 0], [[75, 40, 80], 1, 0],
] as const) {
	test(`cycle ${values.join(",")}`, async (t) => {
		const { harness } = await fixture(t);
		for (const value of values) await turn(harness, value);
		await harness.fire("agent_end");
		await turn(harness, 80);
		assert.deepEqual(harness.state.steers, steers === 1 ? [steer] : []);
		assert.equal(harness.state.aborts, aborts);
	});
}

for (const percent of [undefined, null]) {
	test(`unknown usage ${percent} never reuses a reading`, async (t) => {
		const { harness } = await fixture(t);
		await turn(harness, percent);
		await settled(harness, percent);
		assert.deepEqual(harness.state.steers, []);
		assert.equal(harness.state.aborts, 0);
		assert.deepEqual(harness.state.userMessages, []);
		await turn(harness, 80);
		await settled(harness, percent);
		assert.deepEqual(harness.state.steers, [steer]);
		assert.deepEqual(harness.state.userMessages, []);
	});
}

test("settlement re-reads usage and dispatches after all handlers without input", async (t) => {
	const { harness } = await fixture(t);
	let inputs = 0;
	harness.state.handlers.set("input", [() => { inputs++; }]);
	await turn(harness, 80);
	await settled(harness, 70);
	assert.deepEqual(harness.state.userMessages, []);
	await settled(harness, 80);
	assertDispatched(harness, 1);
	assert.deepEqual(harness.state.settledDispatchOrder, ["queued", "handlers-done", "dispatched"]);
	assert.equal(inputs, 0);
});

test("soft cycles re-arm on each normal run", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 80);
	await settled(harness, 78);
	await harness.fire("before_agent_start");
	await turn(harness, 80);
	assert.deepEqual(harness.state.steers, [steer, steer]);
	assertDispatched(harness, 1);
});

test("hard cycles re-arm after unknown aborted settlement", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 90);
	await settled(harness, undefined, true);
	assert.deepEqual(harness.state.userMessages, []);
	await harness.fire("before_agent_start");
	await turn(harness, 90);
	await settled(harness, 90, true);
	assert.equal(harness.state.aborts, 2);
	assertDispatched(harness, 1);
});

test("Escape suppresses only its run", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 80);
	await settled(harness, 80, true);
	assert.equal(harness.state.aborts, 0);
	assert.deepEqual(harness.state.userMessages, []);
	await settled(harness, 80);
	assertDispatched(harness, 1);
});

test("aborted and errored turns are ignored by the detector", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 80);
	usage(harness, 90);
	await harness.fire("turn_end", { outcome: "aborted" });
	await harness.fire("turn_end", { outcome: "error" });
	assert.equal(harness.state.aborts, 0);
	assert.deepEqual(harness.state.steers, [steer]);
	await settled(harness, 90, true);
	assert.deepEqual(harness.state.userMessages, []);
	await turn(harness, 90);
	assert.equal(harness.state.aborts, 1);
});

test("turns of a run the user already aborted are ignored", async (t) => {
	const { harness } = await fixture(t);
	usage(harness, 90);
	harness.state.abortController.abort();
	await harness.fire("turn_end", { outcome: "completed" });
	assert.equal(harness.state.aborts, 0);
	assert.deepEqual(harness.state.steers, []);
	await settled(harness, 90, true);
	assert.deepEqual(harness.state.userMessages, []);
	harness.state.abortController = new AbortController();
	await harness.fire("turn_end", { outcome: "completed" });
	assert.equal(harness.state.aborts, 1);
});

test("settled without prior observation dispatches at soft equality", async (t) => {
	const { harness } = await fixture(t);
	await settled(harness, 75);
	assertDispatched(harness, 1);
});

test("turns are skipped while the command is active and the next run start re-arms", async (t) => {
	let release!: () => void;
	const idle = new Promise<void>((resolve) => { release = resolve; });
	const { harness } = await fixture(t, '{"enabled":true}', { waitForIdle: () => idle });
	await turn(harness, 75);
	assert.deepEqual(harness.state.steers, [steer]);
	const run = harness.run("auto");
	await turn(harness, 99);
	await settled(harness, 99);
	assert.equal(harness.state.aborts, 0);
	assert.deepEqual(harness.state.steers, [steer]);
	assert.deepEqual(harness.state.userMessages, []);
	release();
	await run;
	await turn(harness, 75);
	assert.deepEqual(harness.state.steers, [steer]);
	await harness.fire("before_agent_start");
	await turn(harness, 75);
	assert.deepEqual(harness.state.steers, [steer, steer]);
});

test("threshold dispatch bridges generation and replacement before bootstrap", async (t) => {
	const { harness } = await fixture(t, '{"enabled":true}', { pendingMessages: false });
	usage(harness, 75);
	await harness.fire("agent_settled", { aborted: false });
	assertDispatched(harness, 1);
	assert.deepEqual(harness.state.settledDispatchOrder, ["queued", "handlers-done", "dispatched"]);
	await withDeadline(harness.generationStarted, 2000);
	const generation = harness.state.generationMessages[0];
	assert.equal(generation.message.customType, "resume-handoff-generation");
	assert.deepEqual(generation.options, { triggerTurn: true });
	const path = JSON.parse(generation.message.content.split("\n").at(-1));
	t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
	writeFileSync(path, "Continue the task.\n");
	await turn(harness, 99);
	await harness.fire("message_end", { message: { role: "assistant", stopReason: "stop" } });
	await harness.fire("agent_settled", { aborted: false });
	harness.finishGeneration();
	await withDeadline(Promise.all(harness.state.commandRuns), 2000);
	assert.equal(harness.state.aborts, 0);
	assert.equal(harness.state.userMessages.length, 1);
	assert.equal(harness.state.newSessions.length, 1);
	assert.equal(harness.state.newSessions[0].parentSession, "/sessions/session-1.jsonl");
	assert.deepEqual(harness.state.lifecycle, ["session_start", "session_start", "bootstrap"]);
	assert.equal(harness.state.prompts.length, 1);
	assert.deepEqual(harness.state.prompts[0].options, { expandPromptTemplates: false });
	const bootstrap = harness.state.prompts[0].text.split("\n");
	assert.equal(bootstrap.at(-1), JSON.stringify(realpathSync(path)));
	assert.match(bootstrap.slice(0, -1).join("\n"), /continue only the work that was already authorized, without asking for renewed approval solely because of the transfer/i);
	assert.doesNotMatch(bootstrap.slice(0, -1).join("\n"), /\bconfirm/i);
	assert.equal(harness.handlerCount(), 0);
});

test("failed generation does not recurse and the next normal run retries", async (t) => {
	const { harness } = await fixture(t, '{"enabled":true}', { pendingMessages: false });
	usage(harness, 75);
	await harness.fire("agent_settled", { aborted: false });
	await withDeadline(harness.generationStarted, 2000);
	const firstPath = JSON.parse(harness.state.generationMessages[0].message.content.split("\n").at(-1));
	t.after(() => rmSync(dirname(firstPath), { recursive: true, force: true }));
	await harness.fire("message_end", { message: { role: "assistant", stopReason: "error" } });
	await harness.fire("agent_settled", { aborted: false });
	harness.finishGeneration();
	await Promise.all(harness.state.commandRuns);
	assert.deepEqual(harness.state.notifications, [{ message: "交接檔案生成未成功完成，未切換 session", level: "error" }]);
	assert.deepEqual(harness.state.newSessions, []);
	assertDispatched(harness, 1);
	await harness.fire("agent_settled", { aborted: false });
	assertDispatched(harness, 2);
	await withDeadline((async () => {
		while (harness.state.generationMessages.length !== 2) await settle();
	})(), 2000);
	const secondPath = JSON.parse(harness.state.generationMessages[1].message.content.split("\n").at(-1));
	t.after(() => rmSync(dirname(secondPath), { recursive: true, force: true }));
	await harness.fire("message_end", { message: { role: "assistant", stopReason: "error" } });
	await harness.fire("agent_settled", { aborted: false });
	harness.finishGeneration();
	await Promise.all(harness.state.commandRuns);
	assert.equal(harness.state.generationMessages.length, 2);
	assert.equal(harness.handlerCount(), 0);
});

test("active command awaiting idle suppresses detection without releasing its lease", async (t) => {
	let release!: () => void;
	const idle = new Promise<void>((resolve) => { release = resolve; });
	const { harness } = await fixture(t, '{"enabled":true}', { waitForIdle: () => idle });
	const run = harness.run("auto");
	await turn(harness, 99);
	await harness.fire("agent_settled", { aborted: false });
	assert.equal(harness.state.aborts, 0);
	assert.deepEqual(harness.state.steers, []);
	assert.deepEqual(harness.state.userMessages, []);
	await harness.run("auto");
	assert.deepEqual(harness.state.notifications, [{ message: "resume-handoff 已在執行中，請稍候", level: "warning" }]);
	release();
	await run;
	assert.equal(harness.handlerCount(), 0);
});

async function heldDispatch(t: test.TestContext) {
	const { harness } = await fixture(t, '{"enabled":true}', { pendingMessages: false });
	harness.holdSettledDispatch();
	usage(harness, 75);
	await harness.fire("agent_settled", { aborted: false });
	assertDispatched(harness, 1);
	assert.equal(harness.state.generationMessages.length, 0);
	return harness;
}

test("threshold generation instructs the next session to continue authorized work", async (t) => {
	const { harness } = await fixture(t, '{"enabled":true}', { pendingMessages: false });
	usage(harness, 75);
	await harness.fire("agent_settled", { aborted: false });
	await withDeadline(harness.generationStarted, 2000);
	const lines = (harness.state.generationMessages[0].message.content as string).split("\n");
	const path = JSON.parse(lines.at(-1)!);
	t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
	writeFileSync(path, "Continue the task.\n");
	await harness.fire("message_end", { message: { role: "assistant", stopReason: "stop" } });
	await harness.fire("agent_settled", { aborted: false });
	harness.finishGeneration();
	await withDeadline(Promise.all(harness.state.commandRuns), 2000);
	const instruction = lines.slice(0, -1).join("\n");
	assert.match(instruction, /continue only the work that was already authorized, without asking for renewed approval solely because of the transfer/i);
	assert.match(instruction, /remain pending/);
	assert.doesNotMatch(instruction, /\bconfirm/i);
	assert.match(instruction, /Always include a ## Resume policy section/);
	assert.match(instruction, /Preserve conditional instructions for the next session, including branches that become active on handoff, and identify the effective next action with its conditions intact\./);
	assert.match(instruction, /Keep constraints, decisions, pending approvals, and blockers together in one section/);
	assert.equal(instruction.match(/continue only the work/gi)?.length, 1);
});

test("a manual command entered before the queued threshold dispatch keeps manual policy", async (t) => {
	const harness = await heldDispatch(t);
	const manual = harness.run("auto");
	await withDeadline(harness.generationStarted, 2000);
	harness.releaseSettledDispatch();
	await withDeadline(Promise.all(harness.state.commandRuns), 2000);
	assert.deepEqual(harness.state.notifications, []);
	assert.equal(harness.state.generationMessages.length, 1);
	const lines = (harness.state.generationMessages[0].message.content as string).split("\n");
	const path = JSON.parse(lines.at(-1)!);
	t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
	assert.match(lines.slice(0, -1).join("\n"), /ask the user to confirm before taking any task action/);
	writeFileSync(path, "Pending approval: deploy.\n");
	await harness.fire("message_end", { message: { role: "assistant", stopReason: "stop" } });
	await harness.fire("agent_settled", { aborted: false });
	harness.finishGeneration();
	await withDeadline(manual, 2000);
	assert.match(harness.state.prompts[0].text, /ask the user to confirm before taking any task action/);
});

test("a queued threshold dispatch runs once and a replay does nothing", async (t) => {
	const harness = await heldDispatch(t);
	const [{ text }] = harness.state.userMessages;
	harness.releaseSettledDispatch();
	await withDeadline(harness.generationStarted, 2000);
	harness.finishGeneration();
	const handler = harness.state.commands.get("resume-handoff-threshold")!.handler;
	await handler(text.split(" ")[1], harness.ctx);
	assert.equal(harness.state.generationMessages.length, 1);
	assert.deepEqual(harness.state.notifications.filter((n) => n.level === "warning"), []);
	await Promise.all(harness.state.commandRuns);
	t.after(() => rmSync(dirname(JSON.parse((harness.state.generationMessages[0].message.content as string).split("\n").at(-1)!)), { recursive: true, force: true }));
});

test("a guessed internal token does nothing", async (t) => {
	const { harness } = await fixture(t, '{"enabled":true}', { pendingMessages: false });
	await harness.state.commands.get("resume-handoff-threshold")!.handler("auto", harness.ctx);
	await harness.state.commands.get("resume-handoff-threshold")!.handler("", harness.ctx);
	assert.equal(harness.state.generationMessages.length, 0);
	assert.deepEqual(harness.state.notifications, []);
});

test("a wrong internal token does not authorize the queued threshold dispatch", async (t) => {
	const harness = await heldDispatch(t);
	await harness.state.commands.get("resume-handoff-threshold")!.handler("wrong-token", harness.ctx);
	harness.releaseSettledDispatch();
	await Promise.all(harness.state.commandRuns);
	assert.equal(harness.state.generationMessages.length, 0);
	assert.deepEqual(harness.state.newSessions, []);
	assert.deepEqual(harness.state.prompts, []);
	assert.deepEqual(harness.state.notifications, []);
});

for (const event of ["input", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown", "session_start"]) {
	test(`${event} invalidates a queued threshold dispatch`, async (t) => {
		const harness = await heldDispatch(t);
		await harness.fire(event);
		harness.releaseSettledDispatch();
		await Promise.all(harness.state.commandRuns);
		assert.equal(harness.state.generationMessages.length, 0);
		assert.deepEqual(harness.state.notifications, []);
	});
}

for (const [name, mutate] of [
	["leaf", (harness: Harness) => { harness.state.leafId = "moved"; }],
	["session", (harness: Harness) => { harness.state.sessionId = "session-9"; }],
] as const) {
	test(`a queued threshold dispatch for a different ${name} does nothing`, async (t) => {
		const harness = await heldDispatch(t);
		mutate(harness);
		harness.releaseSettledDispatch();
		await Promise.all(harness.state.commandRuns);
		assert.equal(harness.state.generationMessages.length, 0);
		assert.deepEqual(harness.state.notifications, []);
	});
}
