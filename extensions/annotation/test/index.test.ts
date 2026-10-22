import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import annotation, { BIN_PATH, newSessionWithAnnotation } from "../index.ts";
import { SESSION_SWITCHED } from "../server.ts";
import { listEntries } from "../registry.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;
type Listener = (event: unknown, ctx: unknown) => unknown;

function call(url: URL, method: string, endpoint: string, token: string | undefined, body?: unknown): Promise<{ status: number; body: string }> {
	const sid = url.pathname.slice(1);
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {};
		if (token) headers["x-annotate-token"] = token;
		if (body !== undefined) headers["content-type"] = "application/json";
		const req = httpRequest({ host: "127.0.0.1", port: url.port, method, path: `/${sid}/api/${endpoint}`, headers }, (res) => {
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

async function setup(options: {
	env?: NodeJS.ProcessEnv;
	hasUI?: boolean;
	editor?: string;
	submitError?: Error;
	sessionId?: string;
	registryDir?: string;
	newSession?: ExtensionCommandContext["newSession"];
} = {}) {
	const commands = new Map<string, Handler>();
	const listeners = new Map<string, Listener[]>();
	const notices: string[] = [];
	const statuses: (string | undefined)[] = [];
	const userMessages: unknown[] = [];
	let editorText = options.editor ?? "";
	let stale = false;
	let sessionId = options.sessionId ?? "session-a";
	let branch: unknown[] = [msg("u1", "user", "explain the cache"), msg("a1", "assistant", [{ type: "text", text: "The cache is LRU." }])];
	const guard = () => {
		if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
	};
	const pi = {
		registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec.handler),
		registerShortcut: () => {},
		on: (event: string, handler: Listener) => listeners.set(event, [...(listeners.get(event) ?? []), handler]),
		sendUserMessage: (message: unknown, delivery: unknown) => {
			if (options.submitError) throw options.submitError;
			userMessages.push({ message, delivery });
		},
	};
	const ctx = {
		newSession: options.newSession ?? (async () => ({ cancelled: false })),
		hasUI: options.hasUI ?? true,
		cwd: "/work/project",
		sessionManager: {
			getBranch: () => {
				guard();
				return branch;
			},
			getSessionId: () => {
				guard();
				return sessionId;
			},
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
			setStatus: (_key: string, text: string | undefined) => {
				guard();
				statuses.push(text);
			},
		},
	};
	const env = options.env ?? { PI_ANNOTATE_PORT: String(await freePort()) };
	const registry = options.registryDir ?? mkdtempSync(join(tmpdir(), "annotate-registry-"));
	if (!options.registryDir) cleanups.push(() => rmSync(registry, { recursive: true, force: true }));
	annotation(pi as never, { env, refreshDelayMs: 0, longPollMs: 3000, registryDir: registry });
	const emit = async (event: string) => {
		for (const listener of listeners.get(event) ?? []) await listener({ type: event }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
	};
	const lastUrl = () => /http:\/\/127\.0\.0\.1:\d+\/[\w-]+#t=[\w-]+/.exec(notices.filter((n) => n.includes("Browser: ")).at(-1) ?? "")![0];
	const parts = () => {
		const url = new URL(lastUrl());
		return { url, token: new URLSearchParams(url.hash.slice(1)).get("t")! };
	};
	return {
		ctx,
		run: (args = "") => commands.get("annotate")!(args, ctx),
		registry,
		commands,
		emit,
		lastUrl,
		parts,
		notices,
		statuses,
		userMessages,
		editor: () => editorText,
		setBranch: (next: unknown[]) => {
			branch = next;
		},
		branch: () => branch,
		shutdown: () => emit("session_shutdown"),
		makeStale: () => {
			stale = true;
		},
		switchSession: (id: string) => {
			sessionId = id;
		},
	};
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

describe("/annotate command", () => {
	it("starts on PI_ANNOTATE_PORT with the session id in the path and the token in the fragment", async () => {
		const port = await freePort();
		const t = await setup({ env: { PI_ANNOTATE_PORT: String(port) } });
		cleanups.push(t.shutdown);
		await t.run();
		const { url, token } = t.parts();
		assert.equal(url.port, String(port));
		assert.equal(url.pathname, "/session-a");
		assert.equal(url.search, "");
		assert.match(token, /^[\w-]{32}$/);
		assert.equal(t.statuses.at(-1), `annotate: live on 127.0.0.1:${port}`);
		assert.equal(
			t.notices.at(-1),
			[`annotate: live on 127.0.0.1:${port}`, `Browser: ${t.lastUrl()}`, `Terminal: '${BIN_PATH}' session-a`, "Run /annotate again to stop it."].join("\n"),
		);
	});

	it("uses 4747 by default, or the next free port", async () => {
		const t = await setup({ env: {} });
		cleanups.push(t.shutdown);
		await t.run();
		const port = Number(t.parts().url.port);
		assert.ok((port >= 4747 && port <= 4756) || port > 0, String(port));
	});

	it("registers /annotate and no /annotation-end", async () => {
		const t = await setup();
		assert.deepEqual([...t.commands.keys()], ["annotate", "annotation-mode"]);
	});

	it("adds the ssh -L hint to the notice over SSH", async () => {
		const port = await freePort();
		const t = await setup({ env: { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22", PI_ANNOTATE_PORT: String(port) } });
		cleanups.push(t.shutdown);
		await t.run();
		assert.equal(
			t.notices.at(-1),
			[
				`annotate: live on 127.0.0.1:${port}`,
				`Browser: ${t.lastUrl()}`,
				`Terminal: '${BIN_PATH}' session-a`,
				`Over SSH, forward the port from your machine first: ssh -L ${port}:127.0.0.1:${port} <host>`,
				"Run /annotate again to stop it.",
			].join("\n"),
		);
	});

	it("does nothing without a UI", async () => {
		const t = await setup({ hasUI: false });
		await t.run();
		assert.equal(t.notices.length, 0);
	});
});

describe("sending", () => {
	it("submits only annotation text as followUp without touching the editor", async () => {
		const t = await setup({ editor: "DRAFT" });
		cleanups.push(t.shutdown);
		await t.run();
		const { url, token } = t.parts();
		const result = await call(url, "POST", "send", token, { seq: 1, delivery: "agent", items: [{ quote: "quoted", note: "fix it" }] });
		assert.equal(result.status, 200);
		assert.deepEqual(JSON.parse(result.body), { ok: true, inserted: 1, seq: 1, nextSeq: 2 });
		assert.equal(t.editor(), "DRAFT");
		assert.deepEqual(t.userMessages, [{ message: "> quoted\n\nfix it\n\n", delivery: { deliverAs: "followUp" } }]);
		const appended = await call(url, "POST", "send", token, { seq: 2, delivery: "editor", items: [{ quote: "quoted", note: "fix it" }] });
		assert.equal(appended.status, 200);
		assert.equal(t.editor(), "DRAFT\n> quoted\n\nfix it\n\n");
	});

	it("does not consume the sequence after synchronous submission failure", async () => {
		const t = await setup({ editor: "DRAFT", submitError: new Error("submission failed") });
		cleanups.push(t.shutdown);
		await t.run();
		const { url, token } = t.parts();
		const items = [{ quote: "quoted", note: "fix it" }];
		assert.equal((await call(url, "POST", "send", token, { seq: 1, delivery: "agent", items })).status, 500);
		assert.equal(t.editor(), "DRAFT");
		assert.equal((await call(url, "POST", "send", token, { seq: 1, delivery: "editor", items })).status, 200);
		assert.equal(t.editor(), "DRAFT\n> quoted\n\nfix it\n\n");
	});

	it("appends two send rounds to the editor in order and never messages the agent", async () => {
		const t = await setup({ editor: "draft" });
		cleanups.push(t.shutdown);
		await t.run();
		const { url, token } = t.parts();
		assert.equal((await call(url, "POST", "send", token, { seq: 1, items: [{ quote: "The cache is LRU.", note: "why LRU?" }] })).status, 200);
		assert.equal((await call(url, "POST", "send", token, { seq: 2, items: [{ quote: "explain the cache", note: "" }, { quote: "LRU", note: "and LFU?" }] })).status, 200);
		assert.equal(t.editor(), "draft\n> The cache is LRU.\n\nwhy LRU?\n\n> explain the cache\n\n> LRU\n\nand LFU?\n\n");
		assert.equal(t.userMessages.length, 0);
		const old = await call(url, "POST", "send", token, { seq: 2, items: [{ quote: "again", note: "" }] });
		assert.equal(old.status, 409);
		assert.ok(!t.editor().includes("again"));
	});

	for (const [editor, expected] of [
		["", "> quote\n\nnote\n\n"],
		["draft", "draft\n> quote\n\nnote\n\n"],
		["draft\n", "draft\n> quote\n\nnote\n\n"],
		["a\n\n", "a\n\n> quote\n\nnote\n\n"],
	] as const) {
		it(`appends after ${JSON.stringify(editor)} with one newline only when needed`, async () => {
			const t = await setup({ editor });
			cleanups.push(t.shutdown);
			await t.run();
			const { url, token } = t.parts();
			assert.equal((await call(url, "POST", "send", token, { seq: 1, items: [{ quote: "quote", note: "note" }] })).status, 200);
			assert.equal(t.editor(), expected);
		});
	}

	it("strips control sequences before appending", async () => {
		const t = await setup();
		cleanups.push(t.shutdown);
		await t.run();
		const { url, token } = t.parts();
		await call(url, "POST", "send", token, { seq: 1, items: [{ quote: "\x1b[31mred\x1b[0m", note: "n\x1b]0;x\x07\x1b[201~" }] });
		assert.equal(t.editor(), "> red\n\nn\n\n");
	});

	it("rejects with 410 when the ctx went stale and inserts nothing", async () => {
		const t = await setup();
		await t.run();
		const { url, token } = t.parts();
		t.makeStale();
		assert.equal((await call(url, "POST", "send", token, { seq: 1, items: [{ quote: "x", note: "" }] })).status, 410);
		assert.equal(t.editor(), "");
		t.makeStale = () => {};
	});
});

describe("live updates and lifecycle", () => {
	it("pushes a new agent reply to a waiting long-poll after message_end", async () => {
		const t = await setup();
		cleanups.push(t.shutdown);
		await t.run();
		const { url, token } = t.parts();
		const snapshot = JSON.parse((await call(url, "GET", "snapshot", token)).body);
		assert.equal(snapshot.items.length, 2);
		const poll = call(url, "GET", `events?after=${snapshot.version}`, token);
		await new Promise((resolve) => setTimeout(resolve, 50));
		t.setBranch([...t.branch(), msg("u2", "user", "and eviction?"), msg("a2", "assistant", [{ type: "text", text: "Oldest first." }])]);
		await t.emit("message_end");
		const reply = JSON.parse((await poll).body);
		assert.equal(reply.reset, false);
		assert.deepEqual(reply.items.map((i: { id: string }) => i.id), ["u2", "a2"]);
	});

	it("sends a reset after a /tree branch change", async () => {
		const t = await setup();
		cleanups.push(t.shutdown);
		await t.run();
		const { url, token } = t.parts();
		const poll = call(url, "GET", "events?after=1", token);
		await new Promise((resolve) => setTimeout(resolve, 50));
		t.setBranch([msg("u1", "user", "explain the cache")]);
		await t.emit("session_tree");
		const reply = JSON.parse((await poll).body);
		assert.equal(reply.reset, true);
		assert.deepEqual(reply.items.map((i: { id: string }) => i.id), ["u1"]);
	});

	it("a second /annotate stops the server, ends a pending long-poll at once and frees the port", async () => {
		const t = await setup();
		await t.run();
		const { url, token } = t.parts();
		const started = Date.now();
		const poll = call(url, "GET", "events?after=1", token);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await t.run();
		await assert.rejects(poll);
		assert.ok(Date.now() - started < 1500);
		assert.equal(t.notices.at(-1), `annotate: closed, port ${url.port} released`);
		assert.equal(t.statuses.at(-1), undefined);
		await new Promise<void>((resolve, reject) => {
			const probe = createServer();
			probe.once("error", reject);
			probe.listen(Number(url.port), "127.0.0.1", () => probe.close(() => resolve()));
		});
	});

	it("a third /annotate starts a new server with a new token and the old token gets 403", async () => {
		const port = await freePort();
		const t = await setup({ env: { PI_ANNOTATE_PORT: String(port) } });
		cleanups.push(t.shutdown);
		await t.run();
		const old = t.parts();
		await t.run();
		await t.run();
		const fresh = t.parts();
		assert.equal(fresh.url.port, String(port));
		assert.equal(fresh.url.pathname, old.url.pathname);
		assert.notEqual(fresh.token, old.token);
		assert.equal(t.statuses.at(-1), `annotate: live on 127.0.0.1:${port}`);
		assert.equal((await call(old.url, "GET", "snapshot", old.token)).status, 403);
		assert.equal((await call(old.url, "POST", "send", old.token, { seq: 1, items: [{ quote: "x", note: "" }] })).status, 403);
		assert.equal((await call(fresh.url, "GET", "snapshot", fresh.token)).status, 200);
		assert.equal(t.editor(), "");
	});

	it("two rapid /annotate calls while the server is starting end with it closed and the port released", async () => {
		const port = await freePort();
		const t = await setup({ env: { PI_ANNOTATE_PORT: String(port) } });
		cleanups.push(t.shutdown);
		await Promise.all([t.run(), t.run()]);
		assert.equal(t.notices.at(-1), `annotate: closed, port ${port} released`);
		assert.equal(t.statuses.at(-1), undefined);
		await new Promise<void>((resolve, reject) => {
			const probe = createServer();
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
		});
		await t.run();
		const { url, token } = t.parts();
		assert.equal(url.port, String(port));
		assert.equal(t.statuses.at(-1), `annotate: live on 127.0.0.1:${port}`);
		assert.equal((await call(url, "GET", "snapshot", token)).status, 200);
	});

	it("a session shutdown while the server is starting closes it as soon as it binds", async () => {
		const port = await freePort();
		const t = await setup({ env: { PI_ANNOTATE_PORT: String(port) } });
		const run = t.run();
		await t.shutdown();
		await run;
		await new Promise<void>((resolve, reject) => {
			const probe = createServer();
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
		});
	});

	it("/annotate after /new starts a fresh server for the new session id even if the old one still runs", async () => {
		const port = await freePort();
		const t = await setup({ env: { PI_ANNOTATE_PORT: String(port) } });
		cleanups.push(t.shutdown);
		await t.run();
		const old = t.parts();
		t.switchSession("session-b");
		await t.run();
		const fresh = t.parts();
		assert.equal(fresh.url.pathname, "/session-b");
		assert.equal(fresh.url.port, String(port));
		assert.notEqual(fresh.token, old.token);
		assert.equal(t.statuses.at(-1), `annotate: live on 127.0.0.1:${port}`);
		assert.equal((await call(fresh.url, "GET", "snapshot", fresh.token)).status, 200);
		assert.equal((await call(old.url, "GET", "snapshot", old.token)).status, 410);
	});

	it("after a session switch the old tab gets 410 from the new server and nothing is inserted", async () => {
		const port = await freePort();
		const t = await setup({ env: { PI_ANNOTATE_PORT: String(port) } });
		await t.run();
		const old = t.parts();
		await t.shutdown();
		t.switchSession("session-b");
		await t.run();
		cleanups.push(t.shutdown);
		const fresh = t.parts();
		assert.equal(fresh.url.port, String(port));
		assert.equal(fresh.url.pathname, "/session-b");
		assert.notEqual(fresh.token, old.token);
		assert.equal((await call(old.url, "POST", "send", old.token, { seq: 1, items: [{ quote: "x", note: "" }] })).status, 410);
		assert.equal((await call(old.url, "GET", "events?after=1", old.token)).status, 410);
		assert.equal(t.editor(), "");
	});

	it("keeps only one server across extension instances", async () => {
		const port = await freePort();
		const a = await setup({ env: { PI_ANNOTATE_PORT: String(port) } });
		const b = await setup({ env: { PI_ANNOTATE_PORT: String(port) } });
		cleanups.push(a.shutdown, b.shutdown);
		await a.run();
		const first = a.parts();
		await b.run();
		assert.equal(b.parts().url.port, String(port));
		assert.notEqual(b.parts().token, first.token);
		assert.equal((await call(first.url, "GET", "snapshot", first.token)).status, 403);
	});
});

describe("annotation handoff", () => {
	it("follows into a new extension instance on the same port with fresh credentials and delivery callbacks", async () => {
		let replacement: Awaited<ReturnType<typeof setup>>;
		let heldSnapshot: ReturnType<typeof call>;
		let heldSend: ReturnType<typeof call>;
		const t = await setup({
			editor: "SOURCE DRAFT",
			newSession: async (options) => {
				assert.equal(options?.parentSession, "/sessions/source.jsonl");
				await t.shutdown();
				t.makeStale();
				replacement = await setup({ sessionId: "session-b", registryDir: t.registry, editor: "NEW DRAFT" });
				cleanups.push(replacement.shutdown);
				replacement.setBranch([msg("new-user", "user", "read the handoff")]);
				await replacement.emit("session_start");
				heldSnapshot = call(old.url, "GET", "snapshot", old.token);
				heldSend = call(old.url, "POST", "send", old.token, { seq: 1, delivery: "agent", items: [{ quote: "during handoff" }] });
				assert.equal(await Promise.race([Promise.race([heldSnapshot, heldSend]).then(() => "answered"), delay(50, "held")]), "held");
				assert.deepEqual(t.userMessages, []);
				assert.deepEqual(replacement.userMessages, []);
				await options?.withSession?.(replacement.ctx as never);
				return { cancelled: false };
			},
		});
		cleanups.push(t.shutdown);
		await t.run();
		const old = t.parts();
		const result = await newSessionWithAnnotation(t.ctx as never, {
			parentSession: "/sessions/source.jsonl",
			withSession: async (ctx) => {
				assert.equal(ctx.sessionManager.getSessionId(), "session-b");
				assert.equal(listEntries(t.registry)[0]?.sessionId, "session-a");
				replacement.setBranch([msg("new-user", "user", "read the handoff"), msg("bootstrap", "user", "handoff prompt sent")]);
			},
		});
		assert.deepEqual(result, { cancelled: false });
		const [entry] = listEntries(t.registry);
		assert.equal(entry?.sessionId, "session-b");
		assert.equal(entry?.port, Number(old.url.port));
		assert.notEqual(entry!.token, old.token);
		assert.equal(replacement!.statuses.at(-1), `annotate: live on 127.0.0.1:${old.url.port}`);
		assert.equal(replacement!.notices.at(-1), [
			`annotate: followed to this session on 127.0.0.1:${old.url.port}`,
			`Browser: http://127.0.0.1:${old.url.port}/session-b#t=${entry!.token}`,
			`Terminal: '${BIN_PATH}' session-b`,
			"Run /annotate again to stop it.",
		].join("\n"));
		for (const reply of await Promise.all([heldSnapshot!, heldSend!])) {
			assert.equal(reply.status, 410);
			assert.deepEqual(JSON.parse(reply.body), { error: "Session switched, run /annotate again.", successor: { sessionId: "session-b", token: entry!.token } });
		}
		const retired = await call(old.url, "GET", "snapshot", old.token);
		assert.equal(retired.status, 410);
		assert.deepEqual(JSON.parse(retired.body), { error: SESSION_SWITCHED, successor: { sessionId: "session-b", token: entry!.token } });
		const url = new URL(`http://127.0.0.1:${entry!.port}/session-b`);
		const snapshot = await call(url, "GET", "snapshot", entry!.token);
		assert.equal(snapshot.status, 200);
		assert.equal(JSON.parse(snapshot.body).sessionId, "session-b");
		assert.equal(JSON.parse(snapshot.body).nextSeq, 1);
		assert.deepEqual(JSON.parse(snapshot.body).items.map((item: { id: string }) => item.id), ["new-user", "bootstrap"]);
		assert.equal((await call(url, "GET", "snapshot", old.token)).status, 403);
		const items = [{ quote: "quoted", note: "fix it" }];
		assert.equal((await call(old.url, "POST", "send", old.token, { seq: 1, delivery: "agent", items })).status, 410);
		assert.equal((await call(url, "POST", "send", entry!.token, { seq: 1, delivery: "agent", items })).status, 200);
		assert.deepEqual(replacement!.userMessages, [{ message: "> quoted\n\nfix it\n\n", delivery: { deliverAs: "followUp" } }]);
		assert.deepEqual(t.userMessages, []);
		assert.equal((await call(url, "POST", "send", entry!.token, { seq: 2, delivery: "editor", items })).status, 200);
		assert.equal(replacement!.editor(), "NEW DRAFT\n> quoted\n\nfix it\n\n");
		assert.equal(t.editor(), "SOURCE DRAFT");
		await t.shutdown();
		await replacement!.emit("session_start");
		assert.equal(replacement!.notices.filter((notice) => notice.includes("followed")).length, 1);
		assert.equal((await call(url, "GET", "snapshot", entry!.token)).status, 200);
		await replacement!.shutdown();
		assert.deepEqual(listEntries(t.registry), []);
		assert.equal(await canListen(entry!.port), true);
	});

	it("leaves the token and registry unchanged when the handoff is cancelled", async () => {
		let heldSend: ReturnType<typeof call>;
		const t = await setup({ newSession: async () => {
			heldSend = call(old.url, "POST", "send", old.token, { seq: 1, items: [{ quote: "still here" }] });
			assert.equal(await Promise.race([heldSend.then(() => "answered"), delay(50, "held")]), "held");
			assert.equal(t.editor(), "");
			return { cancelled: true };
		} });
		cleanups.push(t.shutdown);
		await t.run();
		const old = t.parts();
		const entries = listEntries(t.registry);
		assert.deepEqual(await newSessionWithAnnotation(t.ctx as never, {}), { cancelled: true });
		assert.deepEqual(listEntries(t.registry), entries);
		assert.equal((await call(old.url, "GET", "snapshot", old.token)).status, 200);
		const accepted = await heldSend!;
		assert.equal(accepted.status, 200);
		assert.deepEqual(JSON.parse(accepted.body), { ok: true, inserted: 1, seq: 1, nextSeq: 2 });
		assert.equal(t.editor(), "> still here\n\n");
		await t.shutdown();
		assert.deepEqual(listEntries(t.registry), []);
		assert.equal(await canListen(Number(old.url.port)), true);
	});

	it("closes the parked server when replacement completes without an annotation instance", async () => {
		const t = await setup({ newSession: async () => {
			await t.shutdown();
			t.makeStale();
			return { cancelled: false };
		} });
		cleanups.push(t.shutdown);
		await t.run();
		const old = t.parts();
		assert.equal((await call(old.url, "GET", "snapshot", old.token)).status, 200);
		assert.equal(listEntries(t.registry)[0]?.token, old.token);
		assert.deepEqual(await newSessionWithAnnotation(t.ctx as never, {}), { cancelled: false });
		await assert.rejects(call(old.url, "GET", "snapshot", old.token));
		assert.deepEqual(listEntries(t.registry), []);
		assert.equal(await canListen(Number(old.url.port)), true);
	});

	it("closes the parked server if replacement throws after teardown", async () => {
		const failure = new Error("replacement runtime failed");
		const t = await setup({
			newSession: async () => {
				await t.shutdown();
				t.makeStale();
				throw failure;
			},
		});
		cleanups.push(t.shutdown);
		await t.run();
		const old = t.parts();
		assert.equal(listEntries(t.registry)[0]?.token, old.token);
		await assert.rejects(newSessionWithAnnotation(t.ctx as never, {}), failure);
		assert.deepEqual(listEntries(t.registry), []);
		assert.equal(await canListen(Number(old.url.port)), true);
	});

	it("passes through newSession without starting a server when none was running", async () => {
		const result = { cancelled: false };
		let replacement: Awaited<ReturnType<typeof setup>>;
		const t = await setup({
			newSession: async (options) => {
				assert.equal(options?.parentSession, "/sessions/source.jsonl");
				await t.shutdown();
				t.makeStale();
				replacement = await setup({ sessionId: "session-b", registryDir: t.registry });
				cleanups.push(replacement.shutdown);
				await replacement.emit("session_start");
				await options?.withSession?.(replacement.ctx as never);
				return result;
			},
		});
		assert.equal(await newSessionWithAnnotation(t.ctx as never, { parentSession: "/sessions/source.jsonl" }), result);
		assert.deepEqual(listEntries(t.registry), []);
		assert.deepEqual(replacement!.statuses, []);
		assert.deepEqual(replacement!.notices, []);
		await replacement!.run();
		assert.equal(listEntries(t.registry)[0]?.sessionId, "session-b");
		assert.equal(replacement!.statuses.at(-1), `annotate: live on 127.0.0.1:${replacement!.parts().url.port}`);
	});

	it("does not follow a plain new session into the replacement instance", async () => {
		const t = await setup();
		await t.run();
		const old = t.parts();
		await t.shutdown();
		t.makeStale();
		const replacement = await setup({ sessionId: "session-b", registryDir: t.registry });
		cleanups.push(replacement.shutdown);
		await replacement.emit("session_start");
		assert.deepEqual(listEntries(t.registry), []);
		assert.deepEqual(replacement.statuses, []);
		assert.equal(await canListen(Number(old.url.port)), true);
		await replacement.run();
		assert.equal(listEntries(t.registry)[0]?.sessionId, "session-b");
		assert.notEqual(replacement.parts().token, old.token);
	});

	it("does not follow a server that is still starting when the handoff tears down", async () => {
		const port = await freePort();
		const t = await setup({
			env: { PI_ANNOTATE_PORT: String(port) },
			newSession: async (options) => {
				await t.shutdown();
				const replacement = await setup({ sessionId: "session-b", registryDir: t.registry });
				await replacement.emit("session_start");
				await options?.withSession?.(replacement.ctx as never);
				assert.deepEqual(replacement.statuses, []);
				return { cancelled: false };
			},
		});
		cleanups.push(t.shutdown);
		const starting = t.run();
		assert.deepEqual(await newSessionWithAnnotation(t.ctx as never, {}), { cancelled: false });
		await starting;
		assert.equal(t.notices.at(-1), `annotate: closed, port ${port} released`);
		assert.deepEqual(listEntries(t.registry), []);
		assert.equal(await canListen(port), true);
	});
});

describe("session registry and arguments", () => {
	it("registers the session with its pi-tui module and serves the snapshot", async () => {
		const t = await setup();
		cleanups.push(t.shutdown);
		await t.run();
		const [entry] = listEntries(t.registry);
		assert.equal(entry?.sessionId, "session-a");
		assert.equal(entry?.pid, process.pid);
		assert.equal(entry?.cwd, "/work/project");
		assert.match(entry?.tuiModule ?? "", /pi-tui/);
		const url = new URL(`http://127.0.0.1:${entry!.port}/session-a`);
		assert.equal((await call(url, "GET", "snapshot", entry!.token)).status, 200);
	});

	it("registers the session and unregisters it when /annotate stops it", async () => {
		const t = await setup();
		cleanups.push(t.shutdown);
		await t.run();
		assert.equal(listEntries(t.registry)[0]?.token, t.parts().token);
		await t.run();
		assert.deepEqual(listEntries(t.registry), []);
	});

	it("unregisters on session shutdown", async () => {
		const t = await setup();
		await t.run();
		await t.shutdown();
		assert.deepEqual(listEntries(t.registry), []);
	});

	it("ignores extra arguments and starts a server like plain /annotate", async () => {
		const t = await setup();
		cleanups.push(t.shutdown);
		await t.run("web again");
		assert.equal(t.notices.length, 1);
		assert.match(t.notices.at(-1)!, /^annotate: live on 127\.0\.0\.1:\d+\nBrowser: http:\/\/127\.0\.0\.1:\d+\/session-a#t=[\w-]{32}\nTerminal: '.*pi-annotation\.ts' session-a\nRun \/annotate again to stop it\.$/);
		assert.equal(listEntries(t.registry)[0]?.sessionId, "session-a");
	});
});
