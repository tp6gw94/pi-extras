import assert from "node:assert/strict";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createHarness, discoveryText, makeDir, messageEntry, withDeadline } from "./harness.ts";

const asksForConfirmation = /\bconfirm/i;
const keepsDecisionsPending = /(remain|stay|keep|left)\w*\s+pending/i;

function assertManualPolicy(text: string, path: string) {
	const lines = text.split("\n");
	assert.equal(lines.at(-1), JSON.stringify(path));
	const instruction = lines.slice(0, -1).join("\n");
	assert.match(instruction, asksForConfirmation);
	assert.match(instruction, keepsDecisionsPending);
}

test("manual explicit file asks for confirmation and keeps pending decisions pending", async () => {
	const dir = makeDir();
	try {
		const file = join(dir, "handoff.md");
		writeFileSync(file, "Pending approval: deploy.");
		const harness = createHarness({ cwd: dir });
		await harness.run(file);
		assert.equal(harness.state.prompts.length, 1);
		assert.deepEqual(harness.state.prompts[0].options, { expandPromptTemplates: false });
		assertManualPolicy(harness.state.prompts[0].text, realpathSync(file));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("manual bare discovery asks for confirmation and keeps pending decisions pending", async () => {
	const dir = makeDir();
	try {
		const file = join(dir, "handoff.md");
		writeFileSync(file, "Pending approval: deploy.");
		const harness = createHarness({
			branch: [messageEntry("entry-1", `the handoff file is ${file}`)],
			complete: () => ({
				stopReason: "stop",
				content: [{ type: "text", text: discoveryText(`the handoff file is ${file}`, [file]) }],
			}),
		});
		await harness.run("");
		assert.equal(harness.state.prompts.length, 1);
		assert.deepEqual(harness.state.prompts[0].options, { expandPromptTemplates: false });
		assertManualPolicy(harness.state.prompts[0].text, realpathSync(file));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("manual auto asks the generator and the next session to confirm before task actions", async () => {
	const harness = createHarness();
	const running = harness.run("auto");
	await withDeadline(harness.generationStarted, 2000);
	const generation = harness.state.generationMessages.at(-1).message.content as string;
	const path = JSON.parse(generation.split("\n").at(-1)!);
	try {
		const instruction = generation.split("\n").slice(0, -1).join("\n");
		assert.match(instruction, asksForConfirmation);
		assert.match(instruction, keepsDecisionsPending);
		writeFileSync(path, "Pending approval: deploy.");
		await harness.fire("message_end", { message: { role: "assistant", stopReason: "stop" } });
		await harness.fire("agent_settled", { aborted: false });
		harness.finishGeneration();
		await withDeadline(running, 2000);
		assert.equal(harness.state.prompts.length, 1);
		assert.deepEqual(harness.state.prompts[0].options, { expandPromptTemplates: false });
		assertManualPolicy(harness.state.prompts[0].text, realpathSync(path));
	} finally {
		rmSync(dirname(path), { recursive: true, force: true });
	}
});
