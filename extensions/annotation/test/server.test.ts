import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createConnection, createServer, type Server } from "node:net";
import { after, describe, it } from "node:test";
import type { Annotation } from "../quote.ts";
import {
	type AnnotateServer,
	type CloseReason,
	DEFAULT_PORT,
	diffItems,
	FRAME_CSP,
	mermaidPath,
	MAX_BODY_BYTES,
	preferredPort,
	SESSION_SWITCHED,
	startAnnotateServer,
} from "../server.ts";
import type { SnapshotItem } from "../snapshot.ts";

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function request(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: { host: `127.0.0.1:${port}`, ...options.headers } },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

const item = (id: string, text: string, kind: SnapshotItem["kind"] = "assistant"): SnapshotItem => ({ id, kind, label: kind, text });
const SID = "0199-session-a";

const servers: AnnotateServer[] = [];
const holders: Server[] = [];
after(() => {
	for (const server of servers) server.close("session");
	for (const holder of holders) holder.close();
});

async function start(overrides: { isCurrent?: () => boolean; onSend?: (items: Annotation[]) => number; longPollMs?: number; port?: number } = {}) {
	const sent: Annotation[][] = [];
	const closes: CloseReason[] = [];
	const server = await startAnnotateServer({
		sessionId: SID,
		items: [item("u1", "hello", "user")],
		port: overrides.port ?? 0,
		isCurrent: overrides.isCurrent ?? (() => true),
		longPollMs: overrides.longPollMs ?? 2000,
		onSend:
			overrides.onSend ??
			((items) => {
				sent.push(items);
				return items.length;
			}),
		onClose: (reason) => closes.push(reason),
	});
	servers.push(server);
	const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ "x-annotate-token": server.token, ...extra });
	const api = (endpoint: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
		request(server.port, { method: init.method, path: `/${SID}/api/${endpoint}`, headers: init.headers ?? auth(), body: init.body });
	const send = (seq: number, items: Annotation[] = [{ quote: "hello", note: "why" }], headers: Record<string, string> = auth({ "content-type": "application/json" })) =>
		api("send", { method: "POST", headers, body: JSON.stringify({ seq, items }) });
	return { server, sent, closes, auth, api, send };
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

function hold(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const holder = createServer();
		holder.once("error", reject);
		holder.listen(port, "127.0.0.1", () => {
			holders.push(holder);
			resolve(holder);
		});
	});
}

describe("port selection", () => {
	it("defaults to 4747 and honors PI_ANNOTATE_PORT", () => {
		assert.equal(DEFAULT_PORT, 4747);
		assert.equal(preferredPort({}), 4747);
		assert.equal(preferredPort({ PI_ANNOTATE_PORT: "5100" }), 5100);
		assert.equal(preferredPort({ PI_ANNOTATE_PORT: "nope" }), 4747);
		assert.equal(preferredPort({ PI_ANNOTATE_PORT: "70000" }), 4747);
	});

	it("takes the next port when the preferred one is busy and checks Host against the bound port", async () => {
		const base = await freePort();
		await hold(base);
		const { server, auth } = await start({ port: base });
		assert.equal(server.port, base + 1);
		assert.equal(server.url, `http://127.0.0.1:${base + 1}/${SID}#t=${server.token}`);
		assert.equal((await request(server.port, { path: `/${SID}/api/snapshot`, headers: auth() })).status, 200);
		assert.equal((await request(server.port, { path: `/${SID}/api/snapshot`, headers: auth({ host: `127.0.0.1:${base}` }) })).status, 403);
	});

	it("falls back to a random port when the whole range is busy", async () => {
		const base = await freePort();
		const held: number[] = [];
		for (let port = base; port < base + 10; port++) {
			try {
				await hold(port);
				held.push(port);
			} catch {}
		}
		const { server } = await start({ port: base });
		assert.ok(server.port < base || server.port >= base + 10, String(server.port));
	});
});

describe("annotate server over real HTTP", () => {
	it("serves the page without the token, with CSP and no CORS headers", async () => {
		const { server } = await start();
		const page = await request(server.port, { path: `/${SID}` });
		assert.equal(page.status, 200);
		assert.match(String(page.headers["content-type"]), /^text\/html/);
		const csp = String(page.headers["content-security-policy"]);
		assert.match(csp, /default-src 'none'/);
		const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
		assert.ok(nonce && page.body.includes(`<script nonce="${nonce}">`));
		assert.ok(!page.body.includes(server.token));
		for (const name of Object.keys(page.headers)) assert.ok(!name.startsWith("access-control-"), name);
		assert.equal(
			csp,
			`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		);
		assert.ok(page.body.includes("function createMarkdown(document)"));
		assert.ok(!page.body.includes("__MARKDOWN_JS__") && !page.body.includes("__NONCE__"));
		assert.ok(!page.body.includes("mermaid.min.js") && !page.body.includes("/frame/mermaid.js"));
		assert.equal([...page.body.matchAll(/<script\b[^>]*>/g)].length, 2);
		assert.ok([...page.body.matchAll(/<script\b[^>]*>/g)].every((tag) => tag[0] === `<script nonce="${nonce}">`));
	});

	it("answers 410 for another session id on the page and every endpoint", async () => {
		const { server, auth } = await start();
		const page = await request(server.port, { path: "/other-session" });
		assert.equal(page.status, 410);
		assert.match(page.body, /Session switched/);
		for (const endpoint of ["snapshot", "events?after=1"]) assert.equal((await request(server.port, { path: `/other-session/api/${endpoint}`, headers: auth() })).status, 410);
		const send = await request(server.port, { method: "POST", path: "/other-session/api/send", headers: auth({ "content-type": "application/json" }), body: JSON.stringify({ seq: 1, items: [{ quote: "x" }] }) });
		assert.equal(send.status, 410);
	});

	it("returns the snapshot with version and next seq, and no CORS headers", async () => {
		const { api, auth } = await start();
		const reply = await api("snapshot", { headers: auth({ origin: "http://evil.example" }) });
		assert.equal(reply.status, 200);
		assert.deepEqual(JSON.parse(reply.body), { sessionId: SID, version: 1, nextSeq: 1, items: [item("u1", "hello", "user")] });
		for (const name of Object.keys(reply.headers)) assert.ok(!name.startsWith("access-control-"), name);
	});

	it("rejects data requests with a missing or wrong token", async () => {
		const { server, api, send, sent } = await start();
		assert.equal((await api("snapshot", { headers: {} })).status, 403);
		assert.equal((await api("events?after=1", { headers: { "x-annotate-token": "wrong" } })).status, 403);
		const wrong = `${server.token.slice(0, -1)}${server.token.endsWith("A") ? "B" : "A"}`;
		assert.equal((await send(1, undefined, { "x-annotate-token": wrong, "content-type": "application/json" })).status, 403);
		assert.equal((await send(1, undefined, { "content-type": "application/json" })).status, 403);
		assert.equal(sent.length, 0);
	});

	it("does not accept the fragment token as a query parameter", async () => {
		const { server, sent } = await start();
		for (const query of [`t=${server.token}`, `token=${server.token}`]) {
			assert.equal((await request(server.port, { path: `/${SID}/api/snapshot?${query}` })).status, 403);
			assert.equal((await request(server.port, { path: `/${SID}/api/events?after=1&${query}` })).status, 403);
			const send = await request(server.port, { method: "POST", path: `/${SID}/api/send?${query}`, headers: { "content-type": "application/json" }, body: JSON.stringify({ seq: 1, items: [{ quote: "x" }] }) });
			assert.equal(send.status, 403);
		}
		assert.equal(sent.length, 0);
	});

	it("rejects requests whose Host is not 127.0.0.1:<port>", async () => {
		const { server, auth, sent } = await start();
		for (const host of [`localhost:${server.port}`, "127.0.0.1", `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`]) {
			assert.equal((await request(server.port, { path: `/${SID}`, headers: { host } })).status, 403, host);
			assert.equal((await request(server.port, { path: `/${SID}/api/snapshot`, headers: auth({ host }) })).status, 403, host);
			const send = await request(server.port, { method: "POST", path: `/${SID}/api/send`, headers: auth({ host, "content-type": "application/json" }), body: JSON.stringify({ seq: 1, items: [{ quote: "x" }] }) });
			assert.equal(send.status, 403, host);
		}
		assert.equal(sent.length, 0);
	});

	it("rejects a send that is not application/json, too large, or malformed", async () => {
		const { send, auth, sent } = await start();
		assert.equal((await send(1, undefined, auth({ "content-type": "text/plain" }))).status, 415);
		assert.equal((await send(1, undefined, auth())).status, 415);
		assert.equal((await send(1, [{ quote: "x".repeat(MAX_BODY_BYTES), note: "" }])).status, 413);
		assert.equal((await send(1, [])).status, 400);
		assert.equal((await send(0)).status, 400);
		assert.equal((await send(1, [{ quote: " ", note: "" }])).status, 400);
		assert.equal(sent.length, 0);
	});

	it("rejects a chunked body that grows over 1 MB", async () => {
		const { server, sent } = await start();
		const status = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: server.port,
					method: "POST",
					path: `/${SID}/api/send`,
					headers: { host: `127.0.0.1:${server.port}`, "x-annotate-token": server.token, "content-type": "application/json", "transfer-encoding": "chunked" },
				},
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				},
			);
			req.on("error", reject);
			for (let i = 0; i < 5; i++) req.write(Buffer.alloc(256 * 1024, "x"));
			req.end();
		});
		assert.equal(status, 413);
		assert.equal(sent.length, 0);
	});

	it("accepts any number of sends in seq order and rejects duplicate or old seq with 409", async () => {
		const { server, send, sent } = await start();
		const first = await send(1, [{ quote: "a", note: "1" }]);
		assert.deepEqual(JSON.parse(first.body), { ok: true, inserted: 1, seq: 1, nextSeq: 2 });
		const duplicate = await send(1, [{ quote: "a", note: "1" }]);
		assert.equal(duplicate.status, 409);
		assert.equal(JSON.parse(duplicate.body).expectedSeq, 2);
		assert.equal((await send(3)).status, 409);
		assert.equal((await send(2, [{ quote: "b", note: "2" }])).status, 200);
		assert.equal((await send(1)).status, 409);
		assert.equal((await send(2)).status, 409);
		assert.equal((await send(3, [{ quote: "c", note: "3" }])).status, 200);
		assert.deepEqual(sent.map((items) => items[0]!.quote), ["a", "b", "c"]);
		assert.equal(server.closed, false);
	});

	it("rejects with 410 and inserts nothing once the session switched", async () => {
		let current = true;
		const { api, send, sent } = await start({ isCurrent: () => current });
		current = false;
		assert.equal((await api("snapshot")).status, 410);
		const reply = await send(1);
		assert.equal(reply.status, 410);
		assert.equal(JSON.parse(reply.body).error, SESSION_SWITCHED);
		assert.equal(sent.length, 0);
	});

	it("does not consume the seq when inserting fails", async () => {
		let fail = true;
		const { send } = await start({
			onSend: () => {
				if (fail) throw new Error("editor busy");
				return 1;
			},
		});
		assert.equal((await send(1)).status, 500);
		fail = false;
		assert.equal((await send(1)).status, 200);
	});
});

describe("live updates", () => {
	it("computes append and reset diffs", () => {
		const a = item("a", "1");
		const b = item("b", "2");
		const c = item("c", "3");
		assert.equal(diffItems([a, b], [a, b]), undefined);
		assert.deepEqual(diffItems([a], [a, b, c]), { reset: false, items: [b, c] });
		assert.deepEqual(diffItems([a, b], [a, c]), { reset: true, items: [a, c] });
		assert.deepEqual(diffItems([a, b], [a]), { reset: true, items: [a] });
		assert.deepEqual(diffItems([a], [item("a", "changed")]), { reset: true, items: [item("a", "changed")] });
	});

	it("holds a long-poll until new items arrive and then returns only the new items", async () => {
		const { server, api } = await start();
		const started = Date.now();
		const poll = api("events?after=1");
		await new Promise((resolve) => setTimeout(resolve, 150));
		server.update([item("u1", "hello", "user"), item("a1", "reply")]);
		const reply = await poll;
		assert.equal(reply.status, 200);
		assert.deepEqual(JSON.parse(reply.body), { version: 2, reset: false, items: [item("a1", "reply")] });
		assert.ok(Date.now() - started >= 140);
		assert.deepEqual(JSON.parse((await api("events?after=1")).body), { version: 2, reset: false, items: [item("a1", "reply")] });
	});

	it("sends a full reset when the earlier items are no longer a prefix", async () => {
		const { server, api } = await start();
		server.update([item("u1", "hello", "user"), item("a1", "reply")]);
		const poll = api("events?after=2");
		server.update([item("u1", "hello", "user"), item("a2", "other branch")]);
		assert.deepEqual(JSON.parse((await poll).body), { version: 3, reset: true, items: [item("u1", "hello", "user"), item("a2", "other branch")] });
		assert.deepEqual(JSON.parse((await api("events?after=1")).body).reset, true);
		assert.deepEqual(JSON.parse((await api("events?after=0")).body), { version: 3, reset: true, items: [item("u1", "hello", "user"), item("a2", "other branch")] });
		assert.deepEqual(JSON.parse((await api("events?after=99")).body).reset, true);
	});

	it("answers an idle long-poll with an empty response after the timeout", async () => {
		const { api } = await start({ longPollMs: 200 });
		const started = Date.now();
		const reply = await api("events?after=1");
		assert.deepEqual(JSON.parse(reply.body), { version: 1, reset: false, items: [] });
		assert.ok(Date.now() - started >= 190);
	});

	it("allows four concurrent long-polls and rejects the fifth with 429", async () => {
		const { server, api } = await start();
		const polls = [1, 2, 3, 4].map(() => api("events?after=1"));
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal((await api("events?after=1")).status, 429);
		server.update([item("u1", "hello", "user"), item("a1", "reply")]);
		for (const reply of await Promise.all(polls)) assert.equal(reply.status, 200);
		const again = api("events?after=2");
		await new Promise((resolve) => setTimeout(resolve, 50));
		server.update([item("u1", "hello", "user"), item("a1", "reply"), item("a2", "more")]);
		assert.equal((await again).status, 200);
	});

	it("ends a pending long-poll immediately on close and releases the port", async () => {
		const { server, api, closes } = await start({ longPollMs: 20_000 });
		const started = Date.now();
		const poll = api("events?after=1");
		await new Promise((resolve) => setTimeout(resolve, 100));
		server.close("end");
		await assert.rejects(poll);
		assert.ok(Date.now() - started < 2000);
		assert.deepEqual(closes, ["end"]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		const holder = await hold(server.port);
		assert.ok(holder.listening);
	});
});

describe("annotate server robustness", () => {
	const crashes: unknown[] = [];
	const onCrash = (error: unknown) => crashes.push(error);
	process.on("uncaughtException", onCrash);
	process.on("unhandledRejection", onCrash);
	after(() => {
		process.off("uncaughtException", onCrash);
		process.off("unhandledRejection", onCrash);
	});

	it("answers malformed percent-encoding with 400 and keeps serving", async () => {
		const { server, auth, api } = await start();
		const paths = ["/%E0", "/%E0/api/snapshot", "/%E0/api/events?after=1", "/%E0/api/send", "/%", "/%ZZ/api/events?after=%E0", `/${SID}%E0/api/snapshot`];
		for (const path of paths) {
			for (const headers of [{}, auth()]) {
				const reply = await request(server.port, { path, headers });
				assert.ok(reply.status >= 400 && reply.status < 500, `${path} ${reply.status}`);
			}
		}
		assert.equal((await request(server.port, { path: "/%E0" })).status, 400);
		assert.equal((await request(server.port, { path: "/%E0/api/snapshot", headers: auth() })).status, 400);
		assert.equal((await request(server.port, { path: "/%E0/api/events?after=1", headers: auth() })).status, 400);
		assert.equal((await request(server.port, { method: "POST", path: "/%E0/api/send", headers: auth({ "content-type": "application/json" }), body: "{}" })).status, 400);
		assert.equal((await request(server.port, { path: `/${SID}/api/events?after=%E0`, headers: auth() })).status, 400);
		assert.equal((await request(server.port, { path: `/${SID}/api/events`, headers: auth() })).status, 400);
		const snapshot = await api("snapshot");
		assert.equal(snapshot.status, 200);
		assert.equal(JSON.parse(snapshot.body).sessionId, SID);
		assert.equal((await request(server.port, { path: `/${SID}` })).status, 200);
		assert.equal(server.closed, false);
		assert.deepEqual(crashes, []);
	});

	it("rejects a request target that is not a path", async () => {
		const { server, api } = await start();
		const reply = await new Promise<string>((resolve, reject) => {
			const socket = createConnection(server.port, "127.0.0.1", () => socket.end(`GET * HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`));
			const chunks: Buffer[] = [];
			socket.on("data", (chunk: Buffer) => chunks.push(chunk));
			socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			socket.on("error", reject);
		});
		assert.match(reply, /^HTTP\/1\.1 400 /);
		assert.equal((await api("snapshot")).status, 200);
		assert.deepEqual(crashes, []);
	});

	it("turns an error thrown inside a handler into 500 and keeps serving", async () => {
		let calls = 0;
		let throwAt = 0;
		const { server, api, send, sent } = await start({
			isCurrent: () => {
				calls++;
				if (calls === throwAt) throw new Error("boom");
				return true;
			},
		});
		throwAt = calls + 1;
		assert.equal((await request(server.port, { path: `/${SID}` })).status, 500);
		throwAt = calls + 1;
		assert.equal((await api("snapshot")).status, 500);
		throwAt = calls + 2;
		assert.equal((await send(1)).status, 500);
		assert.deepEqual(sent, []);
		const poll = api("events?after=1");
		await new Promise((resolve) => setTimeout(resolve, 100));
		throwAt = calls + 1;
		server.update([item("u1", "hello", "user"), item("a1", "reply")]);
		assert.equal((await poll).status, 500);
		throwAt = 0;
		assert.equal((await api("snapshot")).status, 200);
		assert.equal((await send(1)).status, 200);
		assert.equal(sent.length, 1);
		assert.equal(JSON.parse((await api("events?after=1")).body).items.length, 1);
		assert.equal(server.closed, false);
		assert.deepEqual(crashes, []);
	});

	it("turns a failing onSend into 500 without using up the seq", async () => {
		let fail = true;
		const { send } = await start({
			onSend: (items) => {
				if (fail) throw new TypeError("editor exploded");
				return items.length;
			},
		});
		assert.equal((await send(1)).status, 500);
		fail = false;
		assert.equal((await send(1)).status, 200);
		assert.deepEqual(crashes, []);
	});
});

describe("annotate diagram frame routes", () => {
	const frameCsp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";

	it("serves /frame without the token, with its own CSP and no conversation or token", async () => {
		const { server } = await start();
		server.update([item("u1", "hello", "user"), item("a1", "SECRET-CONVERSATION-TEXT")]);
		const frame = await request(server.port, { path: "/frame" });
		assert.equal(frame.status, 200);
		assert.equal(FRAME_CSP, frameCsp);
		assert.equal(frame.headers["content-security-policy"], frameCsp);
		assert.match(String(frame.headers["content-type"]), /^text\/html; charset=utf-8$/);
		assert.equal(frame.headers["x-frame-options"], "SAMEORIGIN");
		assert.equal(frame.headers["x-content-type-options"], "nosniff");
		assert.equal(frame.body, readFileSync(new URL("../frame.html", import.meta.url), "utf8"));
		assert.deepEqual([...frame.body.matchAll(/<script\b[^>]*>/g)].map((tag) => tag[0]), ['<script src="/frame/mermaid.js">', '<script src="/frame/frame.js">']);
		for (const body of [frame.body, (await request(server.port, { path: "/frame/frame.js" })).body]) {
			assert.ok(!body.includes(server.token));
			assert.ok(!body.includes("SECRET-CONVERSATION-TEXT"));
			assert.ok(!body.includes(SID));
		}
		for (const name of Object.keys(frame.headers)) assert.ok(!name.startsWith("access-control-"), name);
	});

	it("serves mermaid.min.js from the installed package and the frame script, both as JavaScript", async () => {
		const { server } = await start();
		const file = mermaidPath();
		assert.ok(file !== undefined && file.endsWith("mermaid/dist/mermaid.min.js"), String(file));
		const mermaid = await request(server.port, { path: "/frame/mermaid.js" });
		assert.equal(mermaid.status, 200);
		assert.match(String(mermaid.headers["content-type"]), /^text\/javascript; charset=utf-8$/);
		assert.equal(mermaid.headers["x-content-type-options"], "nosniff");
		assert.equal(mermaid.headers["content-security-policy"], frameCsp);
		assert.equal(Number(mermaid.headers["content-length"]), statSync(file).size);
		assert.equal(Buffer.byteLength(mermaid.body), statSync(file).size);
		assert.ok(!mermaid.body.includes(server.token));
		const etag = String(mermaid.headers.etag);
		assert.equal((await request(server.port, { path: "/frame/mermaid.js", headers: { "if-none-match": etag } })).status, 304);
		const script = await request(server.port, { path: "/frame/frame.js" });
		assert.equal(script.status, 200);
		assert.match(String(script.headers["content-type"]), /^text\/javascript; charset=utf-8$/);
		assert.equal(script.body, readFileSync(new URL("../frame.js", import.meta.url), "utf8"));
		assert.equal((await request(server.port, { path: "/frame?x=1" })).status, 200);
	});

	it("serves nothing else under /frame: traversal and other names get 404", async () => {
		const { server } = await start();
		const paths = [
			"/frame/",
			"/frame/x",
			"/frame/mermaid.min.js",
			"/frame/mermaid.js/",
			"/frame/mermaid.js/x",
			"/frame/../package.json",
			"/frame/%2e%2e/package.json",
			"/frame/%2E%2E/%2E%2E/package.json",
			"/frame/..%2fpackage.json",
			"/frame/..%5cpackage.json",
			"/frame/frame.html",
			"/frame/page.html",
			"/frame/server.ts",
			"/frame/./mermaid.js",
			"/frame//mermaid.js",
			"/frame/%6d%65rmaid.js",
			"/frame/node_modules/mermaid/package.json",
		];
		for (const path of paths) {
			const reply = await request(server.port, { path });
			assert.equal(reply.status, 404, path);
			assert.ok(!reply.body.includes('"version"') && !reply.body.includes("mermaid"), path);
		}
		for (const path of ["/frame%2Fmermaid.js", "/FRAME", "/frame.js", "/mermaid.js", "/package.json", "/../package.json"]) {
			const reply = await request(server.port, { path });
			assert.ok(reply.status === 404 || reply.status === 410, `${path} ${reply.status}`);
			assert.ok(!reply.body.includes('"version"'), path);
		}
		assert.equal((await request(server.port, { method: "POST", path: "/frame" })).status, 405);
		assert.equal((await request(server.port, { path: "/frame", headers: { host: "localhost" } })).status, 403);
		assert.equal((await request(server.port, { path: "/frame/mermaid.js", headers: { host: `127.0.0.1:${server.port + 1}` } })).status, 403);
	});
});

