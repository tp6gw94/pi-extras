import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionCommandContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import annotation, { newSessionWithAnnotation } from "../index.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}


test("Pi awaits source shutdown before handing the annotation server to a replacement", { timeout: 10000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "annotation-lifecycle-"));
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false });
	const connections: { sessionId: string; port: number; token: string }[] = [];
	const shuttingDown = deferred<void>();
	const finishShutdown = deferred<void>();
	const initial = SessionManager.inMemory(root);
	const runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: {
			noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
			extensionFactories: [(pi) => {
				annotation({ ...pi, exec: async (_command, args) => {
					if (args[0] === "ls") return { code: 0, stdout: '{"spaces":[]}', stderr: "", killed: false };
					const { connectionFile } = JSON.parse(args[2]!).props;
					connections.push(JSON.parse(readFileSync(connectionFile, "utf8")));
					return { code: 0, stdout: '{"tab":"fixture"}', stderr: "", killed: false };
				} }, { annotationDir: join(root, "annotation"), env: {} });
				if (sessionManager === initial) pi.on("session_shutdown", async () => {
					shuttingDown.resolve();
					await finishShutdown.promise;
				});
			}],
		} });
		const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
		await result.session.bindExtensions({ uiContext: { notify() {}, setStatus() {} } as unknown as ExtensionUIContext });
		return { ...result, services, diagnostics: services.diagnostics };
	}, { cwd: root, agentDir: root, sessionManager: initial });
	t.after(async () => {
		finishShutdown.resolve();
		try {
			await runtime.dispose();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	await runtime.session.prompt("/annotate-herdr");
	const source = connections[0]!;
	const review = (sessionId: string, token: string) => fetch(`http://127.0.0.1:${source.port}/${sessionId}/api/review`, { headers: { "x-annotate-token": token } });
	assert.equal((await review(source.sessionId, source.token)).status, 200);
	const original = runtime.session;
	const replacement = newSessionWithAnnotation({ newSession: () => runtime.newSession() } as ExtensionCommandContext);
	try {
		await shuttingDown.promise;
		assert.equal(runtime.session, original);
	} finally {
		finishShutdown.resolve();
		await replacement;
	}
	await runtime.session.prompt("/annotate-herdr");
	const successor = connections[1]!;
	assert.equal(successor.port, source.port);
	assert.notEqual(successor.sessionId, source.sessionId);
	assert.equal((await review(successor.sessionId, source.token)).status, 403);
	assert.equal((await review(successor.sessionId, successor.token)).status, 200);
});
