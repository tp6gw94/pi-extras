import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import annotation, { newSessionWithAnnotation } from "../index.ts";
import { SESSION_SWITCHED } from "../server.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

type Handler = (args: string, ctx: any) => Promise<void>;
type Listener = (event: unknown, ctx: any) => unknown;
type Connection = { sessionId: string; port: number; token: string; file: string };
type TabProps = { sessionId: string; connectionFile: string };

interface Reply {
	status: number;
	body: string;
}

function call(port: number, sessionId: string, method: string, endpoint: string, token?: string, body?: unknown, origin?: string): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {};
		if (token) headers["x-annotate-token"] = token;
		if (body !== undefined) headers["content-type"] = "application/json";
		if (origin) headers.origin = origin;
		const req = httpRequest({ host: "127.0.0.1", port, method, path: `/${encodeURIComponent(sessionId)}/api/${endpoint}`, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}

function canListen(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
	});
}

async function freePort(): Promise<number> {
	for (;;) {
		const port = 20000 + Math.floor(Math.random() * 1200) * 10;
		let free = true;
		for (let offset = 0; offset < 10 && free; offset++) free = await canListen(port + offset);
		if (free) return port;
	}
}

const msg = (id: string, role: string, content: unknown) => ({ type: "message", id, message: { role, content } });
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function setup(options: {
	env?: NodeJS.ProcessEnv;
	hasUI?: boolean;
	editor?: string;
	sessionId?: string;
	annotationDir?: string;
	branch?: unknown[];
	exec?: (...args: any[]) => any;
	newSession?: ExtensionCommandContext["newSession"];
} = {}) {
	const commands = new Map<string, Handler>();
	const listeners = new Map<string, Listener[]>();
	const notices: string[] = [];
	const userMessages: unknown[] = [];
	const tabs: TabProps[] = [];
	const execCalls: string[][] = [];
	let editorText = options.editor ?? "";
	let stale = false;
	let sessionId = options.sessionId ?? "session-a";
	let branch = options.branch ?? [msg("u1", "user", "explain the cache"), msg("a1", "assistant", [{ type: "text", text: "The cache is LRU." }])];
	const guard = () => {
		if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
	};
	const exec = options.exec ?? (async (_command: string, args: string[]) => {
		execCalls.push(args);
		if (args[0] === "ls") return { code: 0, stdout: '{"spaces":[]}', stderr: "", killed: false };
		if (args[1] === "tab.new") {
			const props = JSON.parse(args[2]!).props as TabProps;
			tabs.push(props);
			return { code: 0, stdout: JSON.stringify({ tab: `tab-${tabs.length}` }), stderr: "", killed: false };
		}
		return { code: 0, stdout: "{}", stderr: "", killed: false };
	});
	const pi = {
		registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec.handler),
		registerShortcut: () => {},
		exec,
		on: (event: string, handler: Listener) => listeners.set(event, [...(listeners.get(event) ?? []), handler]),
		sendUserMessage: (message: unknown, delivery: unknown) => {
			userMessages.push({ message, delivery });
		},
	};
	const ctx = {
		newSession: options.newSession ?? (async () => ({ cancelled: false })),
		hasUI: options.hasUI ?? true,
		cwd: "/work/project",
		model: { provider: "fixture", id: "local" },
		sessionManager: {
			getBranch: () => {
				guard();
				return branch;
			},
			getSessionId: () => {
				guard();
				return sessionId;
			},
			getSessionFile: () => undefined,
			getLeafId: () => "leaf",
		},
		ui: {
			notify: (message: string) => {
				guard();
				notices.push(message);
			},
			pasteToEditor: () => {
				throw new Error("pasteToEditor must not be used");
			},
			setEditorText: (text: string) => {
				guard();
				editorText = text;
			},
			getEditorText: () => {
				guard();
				return editorText;
			},
			setStatus: () => {},
		},
	};
	const env = options.env ?? { PI_ANNOTATE_PORT: String(await freePort()) };
	const created = options.annotationDir === undefined;
	const annotationDir = options.annotationDir ?? mkdtempSync(join(tmpdir(), "native-annotation-"));
	if (created) cleanups.push(() => rmSync(annotationDir, { recursive: true, force: true }));
	annotation(pi as never, { env, refreshDelayMs: 0, longPollMs: 3000, annotationDir });
	const emit = async (event: string) => {
		for (const listener of listeners.get(event) ?? []) await listener({ type: event }, ctx);
		await delay(20);
	};
	const shutdown = () => emit("session_shutdown");
	cleanups.push(shutdown);
	const connection = (): Connection => {
		const props = tabs.at(-1);
		assert.ok(props, "no tab was opened");
		return { ...JSON.parse(readFileSync(props.connectionFile, "utf8")), file: props.connectionFile };
	};
	return {
		ctx,
		env,
		commands,
		listeners,
		notices,
		userMessages,
		tabs,
		execCalls,
		annotationDir,
		emit,
		shutdown,
		connection,
		launch: (args = "") => commands.get("annotate-herdr")!(args, ctx),
		editor: () => editorText,
		branch: () => branch,
		setBranch: (next: unknown[]) => {
			branch = next;
		},
		makeStale: () => {
			stale = true;
		},
		switchSession: (id: string) => {
			sessionId = id;
		},
		reviewDir: (id = sessionId) => join(annotationDir, "herdr", createHash("sha256").update(id).digest("hex")),
	};
}

describe("native command surface", () => {
	it("registers only /annotate-herdr", async () => {
		const t = await setup();
		assert.deepEqual([...t.commands.keys()], ["annotate-herdr"]);
	});

	it("refuses Herdr review over SSH or without a UI", async () => {
		for (const options of [{ env: { SSH_CONNECTION: "1 2 3 4" } }, { env: { SSH_TTY: "/dev/pts/1" } }]) {
			const t = await setup({ ...options, exec: async () => { throw new Error("Herdr must not run"); } });
			await t.launch();
			assert.match(t.notices.at(-1)!, /local Pi session/);
			assert.deepEqual(t.tabs, []);
		}
		const t = await setup({ hasUI: false, exec: async () => { throw new Error("Herdr must not run"); } });
		await t.launch();
		assert.deepEqual(t.tabs, []);
	});

	it("opens one tab for concurrent calls and publishes the stable review connection", async () => {
		const t = await setup();
		await Promise.all([t.launch(), t.launch()]);
		assert.equal(t.tabs.length, 1);
		assert.equal(t.execCalls.filter((args) => args[0] === "do").length, 1);
		const conn = t.connection();
		assert.equal(conn.sessionId, "session-a");
		assert.equal(conn.port, Number(t.env.PI_ANNOTATE_PORT));
		const dir = t.reviewDir();
		assert.equal(dirname(conn.file), dir);
		assert.equal(dir, join(t.annotationDir, "herdr", createHash("sha256").update("session-a").digest("hex")));
		assert.equal(statSync(conn.file).mode & 0o777, 0o600);
		assert.equal(statSync(dir).mode & 0o777, 0o700);
		const snapshot = await call(conn.port, conn.sessionId, "GET", "snapshot", conn.token);
		assert.equal(snapshot.status, 200);
		assert.deepEqual(JSON.parse(snapshot.body).items.map((item: { text: string }) => item.text), ["explain the cache", "The cache is LRU."]);
		const review = await call(conn.port, conn.sessionId, "GET", "review", conn.token);
		assert.equal(review.status, 200);
		assert.deepEqual(JSON.parse(review.body), { notes: [] });
		for (const endpoint of ["snapshot", "events?after=1", "review"]) {
			assert.equal((await call(conn.port, conn.sessionId, "GET", endpoint)).status, 403, endpoint);
		}
		assert.equal((await call(conn.port, conn.sessionId, "POST", "send", conn.token, { seq: 1, items: [{ quote: "x" }] })).status, 404);
	});

	it("reuses a cached tab and replaces malformed tab data", async () => {
		const root = tempRoot("native-annotation-cache-");
		let opened = 0;
		let cacheFile: string | undefined;
		const t = await setup({
			annotationDir: join(root, "annotation"),
			exec: async (_command, args) => {
				if (args[0] === "ls") return { code: 0, stdout: '{"spaces":[]}', stderr: "", killed: false };
				assert.equal(args[1], "tab.new");
				cacheFile = join(dirname(JSON.parse(args[2]).props.connectionFile), "tab.json");
				return { code: 0, stdout: JSON.stringify({ tab: `tab-${++opened}` }), stderr: "", killed: false };
			},
		});
		await t.launch();
		assert.ok(cacheFile);
		for (const [saved, replacement] of [["{", "tab-2"], ['{"id":"stale"}', "tab-3"]] as const) {
			writeFileSync(cacheFile, saved);
			await t.launch();
			assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")), replacement);
		}
	});

	it("selects the cached Herdr tab instead of opening another", async () => {
		const root = tempRoot("native-annotation-reuse-");
		const calls: string[][] = [];
		const t = await setup({
			annotationDir: join(root, "annotation"),
			exec: async (_command, args) => {
				calls.push(args);
				if (args[0] === "ls") return { code: 0, stdout: JSON.stringify({ spaces: [{ id: "space-1", tabs: [{ id: "tab-saved" }] }] }), stderr: "", killed: false };
				if (args[0] === "do" && (args[1] === "space.select" || args[1] === "tab.select")) return { code: 0, stdout: "{}", stderr: "", killed: false };
				throw new Error("unexpected Herdr command");
			},
		});
		const dir = t.reviewDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "tab.json"), JSON.stringify("tab-saved"));
		await t.launch();
		assert.deepEqual(calls.filter((args) => args[0] === "do").map((args) => args[1]), ["space.select", "tab.select"]);
		assert.equal(calls.some((args) => args[1] === "tab.new"), false);
	});

	it("reports malformed Herdr output as a command failure", async () => {
		for (const [operation, stdout, message] of [
			["ls", "not JSON", /malformed JSON/],
			["ls", "null", /malformed JSON/],
			["ls", '{"spaces":null}', /malformed space data/],
			["tab.new", "{}", /contains no tab ID/],
		] as const) {
			const root = tempRoot("native-annotation-protocol-");
			const t = await setup({
				annotationDir: join(root, "annotation"),
				exec: async (_command, args) => {
					const out = args[0] === "ls" ? (operation === "ls" ? stdout : '{"spaces":[]}') : stdout;
					return { code: 0, stdout: out, stderr: "", killed: false };
				},
			});
			await assert.rejects(t.launch(), message);
		}
	});
});

describe("native review protocol", () => {
	async function reviewSession(root: string) {
		const t = await setup({ annotationDir: join(root, "annotation") });
		await t.launch();
		const conn = t.connection();
		const request = (body?: unknown) => call(conn.port, conn.sessionId, body === undefined ? "GET" : "POST", "review", conn.token, body);
		return { t, conn, request, staged: join(dirname(conn.file), "notes.json.tmp") };
	}

	it("rejects stale and unguarded updates without replacing a newer pending note", async () => {
		const root = tempRoot("native-annotation-save-");
		const { request } = await reviewSession(root);
		const original = { action: "save", anchor: { itemId: "u1", start: 0, end: 7, quote: "explain" }, text: "first" };
		const initial = await request(original);
		assert.equal(initial.status, 200);
		const { noteId } = JSON.parse(initial.body);
		const edit = { ...original, noteId, expectedText: "first", text: "second" };
		const accepted = await request(edit);
		assert.equal(accepted.status, 200);
		assert.equal(JSON.parse(accepted.body).noteId, noteId);
		for (const expectedText of ["first", undefined]) {
			const rejected = await request({ ...edit, expectedText, text: "stale draft" });
			assert.equal(rejected.status, 409);
			assert.match(rejected.body, /note changed/i);
		}
		assert.deepEqual(JSON.parse((await request()).body).notes, JSON.parse(accepted.body).notes);
		const next = await request({ ...edit, expectedText: "second", text: "third" });
		assert.equal(next.status, 200);
		assert.deepEqual(JSON.parse(next.body), { notes: [{ id: noteId, status: "pending", anchor: original.anchor, text: "third" }], noteId });
	});

	it("acknowledges a create replay after reconnect without rewriting, duplicating, or restoring a deleted note", async () => {
		const root = tempRoot("native-annotation-replay-");
		const first = await reviewSession(root);
		const createId = randomUUID();
		const anchor = { itemId: "u1", start: 0, end: 7, quote: "explain" };
		const create = { action: "save", createId, anchor, text: "first" };
		assert.equal((await first.request({ ...create, createId: "../not-a-uuid" })).status, 409);
		assert.equal((await first.request(create)).status, 200);
		const edit = { action: "save", noteId: createId, expectedText: "first", anchor, text: "updated" };
		assert.equal((await first.request(edit)).status, 200);
		await first.t.shutdown();
		const reopened = await reviewSession(root);
		const branch = reopened.t.branch();
		mkdirSync(reopened.staged);
		const replay = await reopened.request(create);
		assert.equal(replay.status, 200);
		assert.deepEqual(JSON.parse(replay.body), { notes: [{ id: createId, status: "pending", anchor, text: "updated" }], noteId: createId });
		reopened.t.setBranch([]);
		const offBranch = await reopened.request(create);
		assert.equal(offBranch.status, 200);
		assert.deepEqual(JSON.parse(offBranch.body), { notes: [], noteId: createId });
		reopened.t.setBranch(branch);
		rmSync(reopened.staged, { recursive: true });
		assert.equal((await reopened.request({ action: "delete", noteId: createId })).status, 200);
		const deleted = await reopened.request(create);
		assert.equal(deleted.status, 200);
		assert.deepEqual(JSON.parse(deleted.body), { notes: [], noteId: createId });
	});

	it("appends only current pending notes using rendered quotes and reports delivery failures", async () => {
		const root = tempRoot("native-annotation-");
		const t = await setup({ annotationDir: join(root, "annotation"), editor: "draft", branch: [msg("u1", "user", "Please **explain** the cache")] });
		await t.launch();
		const conn = t.connection();
		const post = (body: unknown) => call(conn.port, conn.sessionId, "POST", "review", conn.token, body);
		const item = JSON.parse((await call(conn.port, conn.sessionId, "GET", "snapshot", conn.token)).body).items[0];
		assert.equal((await call(conn.port, conn.sessionId, "GET", "review", "wrong")).status, 403);
		assert.equal((await call(conn.port, conn.sessionId, "POST", "send", conn.token, { seq: 1, delivery: "agent", items: [{ quote: "x" }] })).status, 404);
		const saved = await post({ action: "save", anchor: { itemId: item.id, start: 0, end: 18, quote: "Please explain" }, text: "why?" });
		assert.equal(saved.status, 200);
		const id = JSON.parse(saved.body).notes[0].id;
		assert.equal(JSON.parse(saved.body).noteId, id);
		const cloned = JSON.parse((await post({ action: "save", anchor: { itemId: item.id, start: 0, end: 18, quote: "Please explain" }, text: "clone" })).body);
		assert.equal(cloned.noteId, cloned.notes.find((note: { text: string }) => note.text === "clone").id);
		const edited = JSON.parse((await post({ action: "save", noteId: id, expectedText: "why?", anchor: { itemId: item.id, start: 0, end: 18, quote: "Please explain" }, text: "why?" })).body);
		assert.equal(edited.noteId, id);
		const branch = t.branch();
		t.setBranch([]);
		assert.equal((await post({ action: "deliver", noteIds: [id] })).status, 409);
		t.setBranch(branch);
		const notesFile = join(dirname(conn.file), "notes.json");
		mkdirSync(`${notesFile}.tmp`);
		const originalNotify = t.ctx.ui.notify;
		t.ctx.ui.notify = () => { throw new Error("notification failed"); };
		const failed = await post({ action: "deliver", noteIds: [id] });
		t.ctx.ui.notify = originalNotify;
		assert.equal(failed.status, 409);
		assert.equal(t.editor(), "draft");
		assert.match(failed.body, /could not save/i);
		assert.deepEqual(JSON.parse((await call(conn.port, conn.sessionId, "GET", "review", conn.token)).body).notes, JSON.parse(readFileSync(notesFile, "utf8")));
		rmSync(`${notesFile}.tmp`, { recursive: true });
		const setEditorText = t.ctx.ui.setEditorText;
		t.ctx.ui.setEditorText = (text) => {
			assert.equal(JSON.parse(readFileSync(notesFile, "utf8"))[0].status, "appended");
			setEditorText(text);
		};
		const notify = t.ctx.ui.notify;
		t.ctx.ui.notify = (message) => {
			if (message.startsWith("annotate: appended")) throw new Error("notification failed");
			notify(message);
		};
		assert.equal((await post({ action: "deliver", noteIds: [id] })).status, 200);
		assert.match(t.editor(), /^draft[\s\S]*> Please explain[\s\S]*why\?/);
		assert.equal((await post({ action: "deliver", noteIds: [id] })).status, 409);
		const draft = t.editor();
		t.ctx.ui.setEditorText = () => { throw new Error("editor write failed"); };
		const rejected = await post({ action: "deliver", noteIds: [cloned.noteId] });
		assert.equal(rejected.status, 409);
		assert.match(rejected.body, /batch was consumed/i);
		assert.equal(t.editor(), draft);
		assert.equal((await post({ action: "deliver", noteIds: [cloned.noteId] })).status, 409);
		assert.equal(JSON.parse(readFileSync(notesFile, "utf8"))[1].status, "appended");
		assert.deepEqual(t.userMessages, []);
	});

	it("requires the native capability, same origin, and a current session", async () => {
		const t = await setup();
		await t.launch();
		const conn = t.connection();
		assert.equal((await call(conn.port, conn.sessionId, "GET", "review")).status, 403);
		assert.equal((await call(conn.port, conn.sessionId, "GET", "review", "wrong")).status, 403);
		assert.equal((await call(conn.port, conn.sessionId, "GET", "review", conn.token, undefined, "http://evil.example")).status, 403);
		assert.equal((await call(conn.port, "other-session", "GET", "review", conn.token)).status, 403);
		assert.equal((await call(conn.port, conn.sessionId, "GET", "review", conn.token, undefined, `http://127.0.0.1:${conn.port}`)).status, 200);
		assert.equal((await call(conn.port, conn.sessionId, "GET", "snapshot", conn.token)).status, 200);
	});

	it("keeps review notes and releases the owner lock when the session shuts down", async () => {
		const root = tempRoot("native-annotation-persist-");
		const first = await setup({ annotationDir: join(root, "annotation") });
		await first.launch();
		const conn = first.connection();
		const saved = await call(conn.port, conn.sessionId, "POST", "review", conn.token, { action: "save", anchor: { itemId: "u1", start: 0, end: 7, quote: "explain" }, text: "keep me" });
		assert.equal(saved.status, 200);
		await first.shutdown();
		const second = await setup({ annotationDir: join(root, "annotation") });
		await second.launch();
		const next = second.connection();
		const review = await call(next.port, next.sessionId, "GET", "review", next.token);
		assert.equal(review.status, 200);
		assert.deepEqual(JSON.parse(review.body).notes, [{ id: JSON.parse(saved.body).noteId, status: "pending", anchor: { itemId: "u1", start: 0, end: 7, quote: "explain" }, text: "keep me" }]);
	});
});

describe("native live updates", () => {
	it("pushes appended messages and branch resets after message_end and session_tree", async () => {
		const t = await setup();
		await t.launch();
		const conn = t.connection();
		const poll = call(conn.port, conn.sessionId, "GET", "events?after=1", conn.token);
		await delay(50);
		t.setBranch([...t.branch(), msg("a2", "assistant", [{ type: "text", text: "Second reply" }])]);
		await t.emit("message_end");
		const appended = await poll;
		assert.equal(appended.status, 200);
		assert.deepEqual(JSON.parse(appended.body), { version: 2, reset: false, items: [{ id: "a2", kind: "assistant", label: "Assistant", text: "Second reply" }] });
		const reset = call(conn.port, conn.sessionId, "GET", "events?after=2", conn.token);
		await delay(50);
		t.setBranch([msg("u2", "user", "new branch")]);
		await t.emit("session_tree");
		assert.deepEqual(JSON.parse((await reset).body), { version: 3, reset: true, items: [{ id: "u2", kind: "user", label: "You", text: "new branch" }] });
	});
});

describe("native handoff", () => {
	function handoffExec(connections: Map<string, string>) {
		return async (_command: string, args: string[]) => {
			if (args[0] === "ls") return { code: 0, stdout: '{"spaces":[]}', stderr: "", killed: false };
			const props = JSON.parse(args[2]!).props as TabProps;
			connections.set(props.sessionId, props.connectionFile);
			return { code: 0, stdout: JSON.stringify({ tab: props.sessionId }), stderr: "", killed: false };
		};
	}

	async function connect(source: Awaited<ReturnType<typeof setup>>, id: string, connections: Map<string, string>): Promise<Connection> {
		await source.launch();
		const file = connections.get(id);
		assert.ok(file, `no connection for ${id}`);
		return { ...JSON.parse(readFileSync(file, "utf8")), file };
	}

	it("keeps native review data and capabilities bound to the original source", async () => {
		const root = tempRoot("annotation-handoff-");
		const annotationDir = join(root, "annotation");
		const connections = new Map<string, string>();
		const exec = handoffExec(connections);
		let original: Awaited<ReturnType<typeof setup>>;
		let replacement: Awaited<ReturnType<typeof setup>>;
		original = await setup({
			annotationDir,
			exec,
			newSession: async () => {
				await original.shutdown();
				original.makeStale();
				replacement = await setup({ annotationDir, exec, sessionId: "session-b" });
				await replacement.emit("session_start");
				return { cancelled: false };
			},
		});
		const old = await connect(original, "session-a", connections);
		assert.equal((await call(old.port, old.sessionId, "POST", "review", old.token, { action: "save", anchor: { itemId: "u1", start: 0, end: 7, quote: "explain" }, text: "keep this in A" })).status, 200);
		await newSessionWithAnnotation(original.ctx as never);
		const next = await connect(replacement!, "session-b", connections);
		assert.equal(next.port, old.port);
		assert.notEqual(connections.get("session-a"), connections.get("session-b"));
		assert.equal((await call(next.port, next.sessionId, "GET", "review", old.token)).status, 403);
		const review = await call(next.port, next.sessionId, "GET", "review", next.token);
		assert.equal(review.status, 200);
		assert.deepEqual(JSON.parse(review.body), { notes: [] });
		assert.equal(JSON.parse((await call(next.port, next.sessionId, "GET", "snapshot", next.token)).body).sessionId, "session-b");
		assert.equal(JSON.parse(readFileSync(join(original.reviewDir("session-a"), "notes.json"), "utf8"))[0].text, "keep this in A");
	});

	it("unparks the same server when the replacement is cancelled", async () => {
		const t = await setup({ newSession: async () => ({ cancelled: true }) });
		await t.launch();
		const conn = t.connection();
		assert.deepEqual(await newSessionWithAnnotation(t.ctx as never, { parentSession: "/parent.jsonl" }), { cancelled: true });
		assert.equal((await call(conn.port, conn.sessionId, "GET", "snapshot", conn.token)).status, 200);
		assert.deepEqual(JSON.parse((await call(conn.port, conn.sessionId, "GET", "review", conn.token)).body), { notes: [] });
		assert.equal(t.connection().token, conn.token);
	});

	it("closes a parked server when the replacement has no annotation instance", async () => {
		let releaseSource!: () => Promise<void>;
		const t = await setup({
			newSession: async () => {
				await releaseSource();
				return { cancelled: false };
			},
		});
		releaseSource = t.shutdown;
		await t.launch();
		const conn = t.connection();
		await newSessionWithAnnotation(t.ctx as never);
		await assert.rejects(call(conn.port, conn.sessionId, "GET", "snapshot", conn.token));
		assert.equal(await canListen(conn.port), true);
	});

	it("closes the parked server when the replacement throws", async () => {
		let releaseSource!: () => Promise<void>;
		const t = await setup({
			newSession: async () => {
				await releaseSource();
				throw new Error("replacement failed");
			},
		});
		releaseSource = t.shutdown;
		await t.launch();
		const conn = t.connection();
		await assert.rejects(newSessionWithAnnotation(t.ctx as never), /replacement failed/);
		await assert.rejects(call(conn.port, conn.sessionId, "GET", "snapshot", conn.token));
		assert.equal(await canListen(conn.port), true);
	});

	it("passes through newSession when no annotation server runs", async () => {
		const calls: unknown[] = [];
		const t = await setup({
			newSession: async (options) => {
				calls.push(options);
				return { cancelled: false };
			},
		});
		assert.deepEqual(await newSessionWithAnnotation(t.ctx as never, { parentSession: "/parent.jsonl" }), { cancelled: false });
		assert.deepEqual(calls, [{ parentSession: "/parent.jsonl" }]);
		assert.deepEqual(t.tabs, []);
	});

	it("does not follow a plain new session into a replacement instance", async () => {
		let releaseSource!: () => Promise<void>;
		let replacement: Awaited<ReturnType<typeof setup>>;
		const t = await setup({
			newSession: async () => {
				await releaseSource();
				t.makeStale();
				replacement = await setup({ annotationDir: t.annotationDir, sessionId: "session-b" });
				await replacement.emit("session_start");
				return { cancelled: false };
			},
		});
		releaseSource = t.shutdown;
		await t.launch();
		const conn = t.connection();
		await t.ctx.newSession({});
		await assert.rejects(call(conn.port, conn.sessionId, "GET", "snapshot", conn.token));
		assert.deepEqual(replacement!.tabs, []);
		assert.deepEqual(replacement!.notices, []);
	});

	it("does not launch a tab when shutdown aborts an in-flight command", async () => {
		let releaseSource!: () => Promise<void>;
		const started = deferred<void>();
		const opened: TabProps[] = [];
		const t = await setup({
			exec: async (_command: string, args: string[], options: { signal?: AbortSignal }) => {
				if (args[0] === "ls") {
					started.resolve();
					await delay(80);
					options?.signal?.throwIfAborted();
					return { code: 0, stdout: '{"spaces":[]}', stderr: "", killed: false };
				}
				opened.push(JSON.parse(args[2]!).props as TabProps);
				return { code: 0, stdout: '{"tab":"tab-1"}', stderr: "", killed: false };
			},
			newSession: async () => {
				await releaseSource();
				return { cancelled: false };
			},
		});
		releaseSource = t.shutdown;
		const launch = t.launch();
		await started.promise;
		await newSessionWithAnnotation(t.ctx as never);
		await launch;
		assert.deepEqual(opened, []);
		assert.equal(await canListen(Number(t.env.PI_ANNOTATE_PORT)), true);
	});
});
