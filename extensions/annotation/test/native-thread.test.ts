import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { childTurn } from "../native.ts";
import { openReview } from "../review.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}


test("manual replies recover a failed creation and keep child history after interruption", { timeout: 45000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "annotation-thread-"));
	let closeReview: (() => Promise<void>) | undefined;
	t.after(async () => {
		try {
			await closeReview?.();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	const requests: any[] = [];
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push(JSON.parse(Buffer.concat(chunks).toString()));
		if (requests.length === 2) return;
		if (requests.length === 4) {
			res.writeHead(401);
			res.end('{"error":{"message":"Unauthorized"}}');
			return;
		}
		const replyText = "result " + requests.length;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: replyText }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const configureModel = (id: string) => writeFileSync(join(root, "models.json"), JSON.stringify({
		providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture", models: [{ id }] } },
	}));
	configureModel("local");

	const before = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(() => {
		if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = before;
	});

	let canCapture = false;
	const ctx = {
		cwd: root,
		sessionManager: {
			getSessionFile: () => undefined,
			getBranch: () => {
				if (!canCapture) throw new Error("Fixture failed to capture the source");
				return [{ type: "message", id: "source", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "source context", timestamp: Date.now() } }];
			},
		},
	};
	const dir = join(root, "review");
	const open = () => {
		const review = openReview(dir, {
			items: () => [{ id: "source", text: "source context", label: "User", kind: "user" }],
			model: () => ({ provider: "fixture", id: "local" }),
			prepareDelivery: () => assert.fail("Unexpected delivery"),
			run: (...args) => childTurn(ctx as never, ...args),
			reportPersistenceError: assert.fail,
		});
		let closing: Promise<void> | undefined;
		const close = () => closing ??= review.close();
		closeReview = close;
		return { ...review, close };
	};
	let owner = open();
	assert.throws(open, /already has a review owner/);
	const wait = async (predicate: () => boolean) => {
		for (let i = 0; i < 300 && !predicate(); i++) await delay(40);
		assert.ok(predicate(), JSON.stringify(owner.request()));
	};
	const current = () => owner.request().notes[0] as { turns: { status: string; reply?: string }[] };
	const id = owner.request({ action: "save", anchor: { itemId: "source", start: 0, end: 6, quote: "source" }, text: "first" }).notes[0]!.id;
	owner.request({ action: "start", noteId: id });
	await wait(() => current().turns[0]?.status !== "running");
	assert.equal(current().turns[0]?.status, "failed");
	assert.equal(readdirSync(dir).some((name) => name.endsWith(".jsonl")), false);
	canCapture = true;
	const reply = (text: string, requestId?: string) => owner.request({ action: "reply", noteId: id, text, requestId });
	const failedId = randomUUID();
	configureModel("different-local-model");
	reply("model unavailable", failedId);
	await wait(() => current().turns[1]?.status !== "running");
	assert.equal(current().turns[1]?.status, "failed");
	assert.equal(requests.length, 0);
	const session = join(dir, `${id}.jsonl`);
	const header = () => JSON.parse(readFileSync(session, "utf8").split("\n")[0]!);
	const childId = header().id;
	canCapture = false;
	await owner.close();
	owner = open();
	const moved = `${session}.moved`;
	renameSync(session, moved);
	try {
		assert.deepEqual(reply("model unavailable", failedId), owner.request());
		assert.throws(() => reply("different text", failedId), /different text/i);
		assert.throws(() => reply("invalid ID", "bad"), /UUID/);
		assert.throws(() => reply("missing child before first successful reply"), /original child session is unavailable/i);
	} finally {
		renameSync(moved, session);
	}
	configureModel("local");
	reply("retry manually");
	await wait(() => current().turns[2]?.status !== "running");
	assert.equal(current().turns[2]?.reply, "result 1", JSON.stringify(current()));
	const userMessages = (index: number) => requests[index].messages.filter((message: any) => message.role === "user").map(({ content }: any) =>
		typeof content === "string" ? content : content.map((block: any) => block.text).join(""));
	assert.deepEqual(userMessages(0), ["source context", "source\n\nfirst\n\nretry manually"]);
	assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name).sort(), ["find", "grep", "ls", "read"]);
	const secondId = randomUUID();
	reply("second", secondId);
	assert.deepEqual(reply("second", secondId), owner.request());
	assert.throws(() => reply("duplicate"), /running/);
	await wait(() => requests.length === 2);
	await owner.close();
	owner = open();
	assert.equal(current().turns[3]?.status, "interrupted");
	assert.equal(current().turns[3]?.reply, undefined);
	reply("third");
	await wait(() => current().turns[4]?.status !== "running");
	assert.equal(current().turns[4]?.reply, "result 3", JSON.stringify(current()));
	assert.equal(header().id, childId);
	assert.deepEqual(userMessages(1), ["source context", "source\n\nfirst\n\nretry manually", "second"]);
	assert.match(JSON.stringify(requests[2].messages), /source context.*result 1.*third/);
	reply("fourth");
	await wait(() => current().turns[5]?.status !== "running");
	assert.equal(current().turns[5]?.status, "failed");
	assert.equal(current().turns[5]?.reply, undefined);
	await owner.close();
	rmSync(session);
	canCapture = true;
	owner = open();
	try {
		assert.throws(() => reply("missing history"), /original child session is unavailable/i);
		assert.equal(existsSync(session), false);
	} finally {
		await owner.close();
	}
});

for (const failure of ["retired staged file", "publication collision", "retired stage with existing destination", "failed intent reset"]) {
	test(`missing child after ${failure}`, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "annotation-link-"));
		const ctx = { cwd: dir, sessionManager: { getSessionFile: () => undefined, getBranch: () => [] } };
		const diagnostics: string[] = [];
		const open = () => openReview(dir, {
			items: () => [{ id: "source", text: "source", label: "User", kind: "user" }],
			model: () => ({ provider: "fixture", id: "local" }),
			prepareDelivery: () => assert.fail("Unexpected delivery"),
			run: (file, model, create, prompt, signal, publication) => childTurn(ctx as never, file, model, create, prompt, signal, {
				...publication,
				recordIntent() {
					publication.recordIntent();
					if (failure === "publication collision" || failure === "retired stage with existing destination") writeFileSync(file, "existing");
					if (failure !== "publication collision") rmSync(join(dir, readdirSync(dir).find(name => name.endsWith(".tmp"))!));
					if (failure === "failed intent reset") mkdirSync(join(dir, "notes.json.tmp"));
				},
			}),
			reportPersistenceError: message => diagnostics.push(message),
		});
		let owner = open();
		t.after(async () => { await owner.close(); rmSync(dir, { recursive: true, force: true }); });
		const save = { action: "save", anchor: { itemId: "source", start: 0, end: 6, quote: "source" }, text: "comment" };
		const id = owner.request(save).notes[0]!.id;
		owner.request({ action: "start", noteId: id });
		owner.request({ ...save, text: "other note" });
		const turnStatus = () => {
			const note = owner.request().notes[0]!;
			return note.status === "thread" && note.turns[0]!.status;
		};
		for (let i = 0; i < 100 && turnStatus() === "running"; i++) await delay(10);
		assert.equal(turnStatus(), "failed");
		await owner.close();
		if (failure === "publication collision" || failure === "retired stage with existing destination") rmSync(join(dir, `${id}.jsonl`));
		if (failure === "failed intent reset") {
			assert.match(diagnostics.join("\n"), /could not save.*EISDIR/i);
			rmSync(join(dir, "notes.json.tmp"), { recursive: true });
		}
		owner = open();
		assert.equal(owner.request().notes[1]?.text, "other note");
		const retry = () => owner.request({ action: "reply", noteId: id, text: "retry" });
		if (failure !== "retired staged file") assert.throws(retry, /original child session is unavailable/i);
		else assert.doesNotThrow(retry);
	});
}

test("an interrupted publication cannot replace missing child history after reopening", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "annotation-interrupted-link-"));
	const result = deferred<string>();
	const open = () => openReview(dir, {
		items: () => [{ id: "source", text: "source", label: "User", kind: "user" }],
		model: () => ({ provider: "fixture", id: "local" }),
		prepareDelivery: () => assert.fail("Unexpected delivery"),
		run: async (_file, _model, _create, _prompt, _signal, publication) => {
			publication.recordIntent();
			return result.promise;
		},
		reportPersistenceError: assert.fail,
	});
	const owner = open();
	const id = owner.request({ action: "save", anchor: { itemId: "source", start: 0, end: 6, quote: "source" }, text: "comment" }).notes[0]!.id;
	owner.request({ action: "start", noteId: id });
	const closing = owner.close();
	result.resolve("late");
	await closing;
	const reopened = open();
	t.after(async () => { await reopened.close(); rmSync(dir, { recursive: true, force: true }); });
	assert.throws(() => reopened.request({ action: "reply", noteId: id, text: "retry" }), /original child session is unavailable/i);
	assert.equal(existsSync(join(dir, `${id}.jsonl`)), false);
});

test("a failed publication-intent write does not expose the child session", { timeout: 5000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "annotation-publication-"));
	const blocker = join(dir, "notes.json.tmp");
	const persistenceError = deferred<string>();
	const ctx = {
		cwd: dir,
		sessionManager: {
			getSessionFile: () => undefined,
			getBranch: () => {
				mkdirSync(blocker);
				return [];
			},
		},
	};
	const owner = openReview(dir, {
		items: () => [{ id: "source", text: "source", label: "User", kind: "user" }],
		model: () => ({ provider: "fixture", id: "local" }),
		prepareDelivery: () => assert.fail("Unexpected delivery"),
		run: (...args) => childTurn(ctx as never, ...args),
		reportPersistenceError: persistenceError.resolve,
	});
	t.after(async () => {
		rmSync(blocker, { recursive: true, force: true });
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const id = owner.request({ action: "save", anchor: { itemId: "source", start: 0, end: 6, quote: "source" }, text: "comment" }).notes[0]!.id;
	owner.request({ action: "start", noteId: id });
	assert.match(await persistenceError.promise, /could not save.*EISDIR/i);
	assert.equal(existsSync(join(dir, `${id}.jsonl`)), false);
});

test("a corrupt review lock database is not reported as another review owner", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "annotation-lock-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "owner.sqlite"), "not a database".repeat(100));
	assert.throws(() => openReview(dir, {
		items: () => [],
		model: () => undefined,
		prepareDelivery: () => assert.fail("Unexpected delivery"),
		run: async () => assert.fail("Unexpected turn"),
		reportPersistenceError: assert.fail,
	}), /file is not a database/);
});

test("failed request writes preserve persisted notes and allow a retry", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "annotation-requests-"));
	const owner = openReview(dir, {
		items: () => [{ id: "source", text: "source", label: "User", kind: "user" }],
		model: () => ({ provider: "fixture", id: "local" }),
		prepareDelivery: () => assert.fail("Unexpected delivery"),
		run: async (file, _model, create, prompt, _signal, publication) => {
			if (create) {
				publication.recordIntent();
				writeFileSync(file, "fixture child");
			}
			return prompt.reply ?? prompt.original;
		},
		reportPersistenceError() {},
	});
	t.after(async () => {
		await owner.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const save = { action: "save", anchor: { itemId: "source", start: 0, end: 6, quote: "source" }, text: "comment" };
	const id = owner.request(save).notes[0]!.id;
	const file = join(dir, "notes.json");
	const staged = `${file}.tmp`;
	const failsWithoutChangingNotes = (action: unknown) => {
		const before = structuredClone(owner.request());
		const disk = readFileSync(file, "utf8");
		mkdirSync(staged);
		try {
			assert.throws(() => owner.request(action), /could not save/i);
			assert.deepEqual(owner.request(), before);
			assert.equal(readFileSync(file, "utf8"), disk);
		} finally {
			rmSync(staged, { recursive: true });
		}
	};
	failsWithoutChangingNotes({ ...save, text: "new" });
	failsWithoutChangingNotes({ ...save, noteId: id, expectedText: save.text, text: "edit" });
	failsWithoutChangingNotes({ action: "delete", noteId: id });
	const start = { action: "start", noteId: id };
	failsWithoutChangingNotes(start);
	owner.request(start);
	await delay(0);
	const reply = { action: "reply", noteId: id, text: "follow-up", requestId: randomUUID() };
	failsWithoutChangingNotes(reply);
	owner.request(reply);
	await delay(0);
	assert.deepEqual(owner.request(reply), owner.request());
	const distinct = { ...reply, requestId: randomUUID() };
	owner.request(distinct);
	await delay(0);
	const note = owner.request().notes[0]!;
	assert.equal(note.status, "thread");
	assert.deepEqual(note.turns.slice(1).map(turn => turn.id), [reply.requestId, distinct.requestId]);
	assert.deepEqual(note.turns.map((turn) => turn.status === "completed" && turn.reply), ["source\n\ncomment", "follow-up", "follow-up"]);
});

for (const phase of ["completion", "shutdown"]) {
	test(`review reports a filesystem write failure during ${phase} and releases ownership`, async (t) => {
		const dir = mkdtempSync(join(tmpdir(), "annotation-persist-"));
		t.after(() => rmSync(dir, { recursive: true, force: true }));
		const diagnostics: string[] = [];
		const result = deferred<string>();
		const open = () => openReview(dir, {
			items: () => [{ id: "source", text: "source", label: "User", kind: "user" }],
			model: () => ({ provider: "fixture", id: "local" }),
			prepareDelivery: () => assert.fail("Unexpected delivery"),
			run: () => result.promise,
			reportPersistenceError: (message) => diagnostics.push(message),
		});
		const owner = open();
		const id = owner.request({ action: "save", anchor: { itemId: "source", start: 0, end: 6, quote: "source" }, text: "comment" }).notes[0]!.id;
		owner.request({ action: "start", noteId: id });
		const staged = join(dir, "notes.json.tmp");
		mkdirSync(staged);
		result.resolve("unpersisted reply");
		if (phase === "completion") {
			await delay(0);
			const note = owner.request().notes[0]!;
			assert.equal(note.status, "thread");
			const turn = note.turns[0]!;
			assert.equal(turn.status, "failed");
			assert.match(turn.error, /could not save/i);
		}
		await owner.close();
		assert.match(diagnostics.join("\n"), /could not save.*EISDIR/i);
		rmSync(staged, { recursive: true });
		const reopened = open();
		const note = reopened.request().notes[0]!;
		assert.equal(note.status, "thread");
		assert.equal(note.turns[0]!.status, "interrupted");
		await reopened.close();
	});
}

test("an RPC child exit after prompt acceptance fails the turn and allows a reply", { timeout: 10000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "annotation-rpc-exit-"));
	const dir = join(root, "review");
	const path = process.env.PATH;
	process.env.PATH = `${root}:${path}`;
	const model = { provider: "fixture", id: "local" };
	writeFileSync(join(root, "node"), `#!${process.execPath}
const { createInterface } = require("node:readline");
const sessionFile = process.argv[process.argv.indexOf("--session") + 1];
const send = (value, callback) => process.stdout.write(JSON.stringify(value) + "\\n", callback);
createInterface({ input: process.stdin }).on("line", (line) => {
	const { type, id, message } = JSON.parse(line);
	const data = type === "prompt" ? { disposition: "started" } : { sessionFile, model: ${JSON.stringify(model)} };
	if (type === "prompt" && !message.endsWith("try again")) {
		send({ type: "response", id, success: true, data }, () => process.exit(1));
		return;
	}
	send({ type: "response", id, success: true, data });
	if (type === "prompt") {
		send({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] } });
		send({ type: "agent_settled", aborted: false });
	}
});
`, { mode: 0o700 });
	const ctx = { cwd: root, sessionManager: { getSessionFile: () => undefined, getBranch: () => [] } };
	const owner = openReview(dir, {
		items: () => [{ id: "source", text: "source", label: "User", kind: "user" }],
		model: () => model,
		prepareDelivery: () => assert.fail("Unexpected delivery"),
		run: (...args) => childTurn(ctx as never, ...args),
		reportPersistenceError: assert.fail,
	});
	t.after(async () => {
		await owner.close();
		process.env.PATH = path;
		rmSync(root, { recursive: true, force: true });
	});
	const id = owner.request({ action: "save", anchor: { itemId: "source", start: 0, end: 6, quote: "source" }, text: "comment" }).notes[0]!.id;
	const waitForTurn = async (index: number) => {
		const turn = () => (owner.request().notes[0] as { turns: { status: string; reply?: string }[] }).turns[index];
		for (let i = 0; i < 100 && turn()?.status === "running"; i++) await delay(40);
		return turn();
	};
	owner.request({ action: "start", noteId: id });
	assert.equal((await waitForTurn(0))?.status, "failed");
	owner.request({ action: "reply", noteId: id, text: "try again" });
	const retry = await waitForTurn(1);
	assert.equal(retry?.status, "completed");
	assert.equal(retry.reply, "recovered");
});

for (const command of ["get_state", "prompt"]) {
	test(`abort stops the child while RPC ${command} is unanswered`, { timeout: 5000 }, async (t) => {
		const root = mkdtempSync(join(tmpdir(), "annotation-rpc-"));
		const file = join(root, "child.jsonl");
		const blocked = join(root, "blocked");
		const path = process.env.PATH;
		process.env.PATH = `${root}:${path}`;
		t.after(() => {
			process.env.PATH = path;
			rmSync(root, { recursive: true, force: true });
		});
		writeFileSync(file, "");
		writeFileSync(join(root, "node"), `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
	const { type, id } = JSON.parse(line);
	if (type === ${JSON.stringify(command)}) {
		writeFileSync(${JSON.stringify(blocked)}, String(process.pid));
		return;
	}
	const data = { sessionFile: ${JSON.stringify(file)}, model: { provider: "fixture", id: "local" } };
	console.log(JSON.stringify({ type: "response", id, success: true, data }));
});
`, { mode: 0o700 });
		const controller = new AbortController();
		const turn = childTurn({ cwd: root } as never, file, { provider: "fixture", id: "local" }, false, { original: "run" }, controller.signal, { recordIntent: assert.fail, clearUnpublishedIntent: assert.fail });
		const settled = assert.rejects(turn, { name: "AbortError" });
		for (let i = 0; i < 60 && !existsSync(blocked); i++) await delay(20);
		controller.abort();
		const pid = Number(readFileSync(blocked, "utf8"));
		await settled;
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	});
}
