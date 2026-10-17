import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createHarness, makeDir } from "./harness.ts";

const steer = { message: { customType: "resume-handoff-wrap-up", content: "Context is nearly full and this session will be handed off. Finish the current step only. Start nothing new. Summarise the current state, then end your turn.", display: true }, options: { deliverAs: "steer" } };
const dispatch = { text: "/resume-handoff auto", options: { expandPromptTemplates: true } };
const invalid = { message: "自動交接設定無效，已停用；請檢查 resume-handoff/config.json", level: "warning" };
type Harness = ReturnType<typeof createHarness>;

async function fixture(t: test.TestContext, config: string | undefined = '{"enabled":true}', options: Parameters<typeof createHarness>[0] = {}) {
	const agentDir = makeDir();
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	mkdirSync(join(agentDir, "resume-handoff"));
	const path = join(agentDir, "resume-handoff", "config.json");
	if (config !== undefined) writeFileSync(path, config);
	const harness = createHarness({ agentDir, pendingMessages: true, ...options });
	await harness.startSession();
	return { harness, path };
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

for (const config of [undefined, "{}", '{"enabled":false}', '{"enabled":"true"}']) {
	test(`inert configuration ${config}`, async (t) => {
		const { harness, path } = await fixture(t, config === undefined ? "{}" : config);
		if (config === undefined) { rmSync(path); await harness.startSession(); }
		assert.equal(harness.permanentHandlerCount(), 4);
		await turn(harness, 90);
		await settled(harness, 90);
		assert.deepEqual(harness.state.steers, []);
		assert.equal(harness.state.aborts, 0);
		assert.deepEqual(harness.state.userMessages, []);
		assert.deepEqual(harness.state.notifications, config === '{"enabled":"true"}' ? [invalid] : []);
		writeFileSync(path, '{"enabled":true}');
		await harness.startSession();
		await turn(harness, 75);
		assert.deepEqual(harness.state.steers, [steer]);
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
	test(`invalid configuration is latched ${config}`, async (t) => {
		const { harness, path } = await fixture(t, config);
		await harness.startSession();
		await turn(harness, 90);
		await settled(harness, 90);
		assert.deepEqual(harness.state.notifications, [invalid]);
		assert.equal(harness.state.aborts, 0);
		assert.deepEqual(harness.state.steers, []);
		assert.deepEqual(harness.state.userMessages, []);
		writeFileSync(path, '{"enabled":true}');
		await harness.startSession();
		await turn(harness, 75);
		assert.deepEqual(harness.state.notifications, [invalid]);
		assert.deepEqual(harness.state.steers, [steer]);
		writeFileSync(path, config);
		await harness.startSession();
		assert.deepEqual(harness.state.notifications, [invalid, invalid]);
	});
}

test("unreadable config is invalid; rpc never reads it", async (t) => {
	const { harness, path } = await fixture(t);
	rmSync(path);
	mkdirSync(path);
	await harness.startSession();
	assert.deepEqual(harness.state.notifications, [invalid]);
	const rpc = createHarness({ agentDir: join(path, "../.."), mode: "rpc" });
	await rpc.startSession();
	await turn(rpc, 90);
	await settled(rpc, 90);
	assert.deepEqual(rpc.state.notifications, []);
	assert.equal(rpc.state.aborts, 0);
	assert.deepEqual(rpc.state.userMessages, []);
	assert.deepEqual(rpc.state.steers, []);
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
	await harness.fire("before_agent_start", { messageType: "user" });
	await settled(harness, 80);
	assert.deepEqual(harness.state.userMessages, [dispatch]);
	assert.deepEqual(harness.state.settledDispatchOrder, ["queued", "handlers-done", "dispatched"]);
	assert.equal(inputs, 0);
});

test("soft cycles re-arm on each normal run", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 80);
	await settled(harness, 78);
	await harness.fire("before_agent_start", { messageType: "user" });
	await turn(harness, 80);
	assert.deepEqual(harness.state.steers, [steer, steer]);
	assert.deepEqual(harness.state.userMessages, [dispatch]);
});

test("hard cycles re-arm after unknown aborted settlement", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 90);
	await settled(harness, undefined, true);
	assert.deepEqual(harness.state.userMessages, []);
	await harness.fire("before_agent_start", { messageType: "user" });
	await turn(harness, 90);
	await settled(harness, 90, true);
	assert.equal(harness.state.aborts, 2);
	assert.deepEqual(harness.state.userMessages, [dispatch]);
});

test("Escape suppresses only its run", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 80);
	await settled(harness, 80, true);
	assert.equal(harness.state.aborts, 0);
	assert.deepEqual(harness.state.userMessages, []);
	await harness.fire("before_agent_start", { messageType: "user" });
	await settled(harness, 80);
	assert.deepEqual(harness.state.userMessages, [dispatch]);
});

test("settled without prior observation dispatches at soft equality", async (t) => {
	const { harness } = await fixture(t);
	await settled(harness, 75);
	assert.deepEqual(harness.state.userMessages, [dispatch]);
});

test("generation is skipped and other custom runs re-arm", async (t) => {
	const { harness } = await fixture(t);
	await turn(harness, 75);
	await harness.fire("before_agent_start", { messageType: "custom", message: { customType: "resume-handoff-generation" } });
	await turn(harness, 99);
	await settled(harness, 99);
	assert.equal(harness.state.aborts, 0);
	assert.deepEqual(harness.state.userMessages, []);
	assert.deepEqual(harness.state.steers, [steer]);
	await harness.fire("before_agent_start", { messageType: "custom", message: { customType: "other" } });
	await turn(harness, 75);
	assert.deepEqual(harness.state.steers, [steer, steer]);
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
