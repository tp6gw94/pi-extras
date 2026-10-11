import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { after, describe, it } from "node:test";
import type { Annotation } from "../quote.ts";
import { type AnnotateServer, type CloseReason, MAX_BODY_BYTES, SESSION_SWITCHED, startAnnotateServer } from "../server.ts";

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function request(server: AnnotateServer, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port: server.port,
				method: options.method ?? "GET",
				path: options.path ?? "/",
				headers: { host: `127.0.0.1:${server.port}`, ...options.headers },
			},
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

const snapshot = { takenAt: "2026-10-11T08:00:00.000Z", items: [{ id: "u1", kind: "user" as const, label: "You", text: "hello" }] };
const goodBody = JSON.stringify({ items: [{ quote: "hello", note: "why" }] });

const servers: AnnotateServer[] = [];
after(() => {
	for (const server of servers) server.close("session");
});

async function start(overrides: { isCurrent?: () => boolean; idleMs?: number; onSend?: (items: Annotation[]) => number } = {}) {
	const sent: Annotation[][] = [];
	const closes: CloseReason[] = [];
	const server = await startAnnotateServer({
		snapshot,
		isCurrent: overrides.isCurrent ?? (() => true),
		idleMs: overrides.idleMs,
		closeDelayMs: 100,
		onSend:
			overrides.onSend ??
			((items) => {
				sent.push(items);
				return items.length;
			}),
		onClose: (reason) => closes.push(reason),
	});
	servers.push(server);
	const token = (extra: Record<string, string> = {}) => ({ "x-annotate-token": server.token, ...extra });
	const send = (headers: Record<string, string> = token({ "content-type": "application/json" }), body = goodBody) =>
		request(server, { method: "POST", path: "/api/send", headers, body });
	return { server, sent, closes, token, send };
}

describe("annotate server over real HTTP", () => {
	it("listens on 127.0.0.1 with a random port and a long URL token", async () => {
		const { server } = await start();
		assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{32}$/);
		assert.notEqual(server.port, 0);
	});

	it("serves the page only with the URL token, with CSP and no CORS headers", async () => {
		const { server } = await start();
		const page = await request(server, { path: `/?token=${server.token}` });
		assert.equal(page.status, 200);
		assert.match(String(page.headers["content-type"]), /^text\/html/);
		const csp = String(page.headers["content-security-policy"]);
		assert.match(csp, /default-src 'none'/);
		const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
		assert.ok(nonce);
		assert.ok(page.body.includes(`<script nonce="${nonce}">`));
		assert.ok(!page.body.includes("__NONCE__"));
		assert.equal(page.headers["cache-control"], "no-store");
		for (const name of Object.keys(page.headers)) assert.ok(!name.startsWith("access-control-"), name);
		assert.equal((await request(server, { path: "/" })).status, 403);
		assert.equal((await request(server, { path: "/?token=wrong" })).status, 403);
	});

	it("does not accept the URL token for API requests", async () => {
		const { server } = await start();
		assert.equal((await request(server, { path: `/api/snapshot?token=${server.token}` })).status, 403);
	});

	it("returns the snapshot with the token header and no CORS headers", async () => {
		const { server, token } = await start();
		const reply = await request(server, { path: "/api/snapshot", headers: token({ origin: "http://evil.example" }) });
		assert.equal(reply.status, 200);
		assert.deepEqual(JSON.parse(reply.body), snapshot);
		for (const name of Object.keys(reply.headers)) assert.ok(!name.startsWith("access-control-"), name);
	});

	it("rejects a send without the token header", async () => {
		const { send, sent } = await start();
		const reply = await send({ "content-type": "application/json" });
		assert.equal(reply.status, 403);
		assert.equal(sent.length, 0);
	});

	it("rejects a send with a wrong token", async () => {
		const { server, send, sent } = await start();
		const wrong = `${server.token.slice(0, -1)}${server.token.endsWith("A") ? "B" : "A"}`;
		assert.equal((await send({ "x-annotate-token": wrong, "content-type": "application/json" })).status, 403);
		assert.equal((await send({ "x-annotate-token": "short", "content-type": "application/json" })).status, 403);
		assert.equal(sent.length, 0);
	});

	it("rejects requests whose Host is not 127.0.0.1:<port>", async () => {
		const { server, token, sent } = await start();
		for (const host of ["localhost:" + server.port, "127.0.0.1", "evil.example:" + server.port, `127.0.0.1:${server.port + 1}`]) {
			const send = await request(server, { method: "POST", path: "/api/send", headers: token({ host, "content-type": "application/json" }), body: goodBody });
			assert.equal(send.status, 403, host);
			assert.equal((await request(server, { path: `/?token=${server.token}`, headers: { host } })).status, 403, host);
			assert.equal((await request(server, { path: "/api/snapshot", headers: token({ host }) })).status, 403, host);
		}
		assert.equal(sent.length, 0);
	});

	it("rejects a send that is not application/json", async () => {
		const { send, token, sent } = await start();
		assert.equal((await send(token({ "content-type": "text/plain" }))).status, 415);
		assert.equal((await send(token({ "content-type": "application/x-www-form-urlencoded" }), "items=x")).status, 415);
		assert.equal((await send(token())).status, 415);
		assert.equal(sent.length, 0);
	});

	it("rejects a body over 1 MB", async () => {
		const { send, token, sent } = await start();
		const big = JSON.stringify({ items: [{ quote: "x".repeat(MAX_BODY_BYTES), note: "" }] });
		assert.equal((await send(token({ "content-type": "application/json" }), big)).status, 413);
		assert.equal(sent.length, 0);
	});

	it("rejects a chunked body that grows over 1 MB", async () => {
		const { server, sent } = await start();
		const reply = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port: server.port,
					method: "POST",
					path: "/api/send",
					headers: { host: `127.0.0.1:${server.port}`, "x-annotate-token": server.token, "content-type": "application/json", "transfer-encoding": "chunked" },
				},
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				},
			);
			req.on("error", reject);
			const chunk = Buffer.alloc(256 * 1024, "x");
			for (let i = 0; i < 5; i++) req.write(chunk);
			req.end();
		});
		assert.equal(reply, 413);
		assert.equal(sent.length, 0);
	});

	it("rejects malformed JSON and items", async () => {
		const { send, token, sent } = await start();
		const json = token({ "content-type": "application/json" });
		assert.equal((await send(json, "{")).status, 400);
		assert.equal((await send(json, JSON.stringify({ items: [] }))).status, 400);
		assert.equal((await send(json, JSON.stringify({ items: [{ quote: " ", note: "" }] }))).status, 400);
		assert.equal((await send(json, JSON.stringify({ items: [{ quote: "a", note: 3 }] }))).status, 400);
		assert.equal(sent.length, 0);
	});

	it("accepts one send, then rejects the second send and closes", async () => {
		const { server, send, sent, closes } = await start();
		const first = await send();
		assert.equal(first.status, 200);
		assert.deepEqual(JSON.parse(first.body), { ok: true, inserted: 1 });
		assert.deepEqual(sent, [[{ quote: "hello", note: "why" }]]);
		const second = await send();
		assert.equal(second.status, 410);
		assert.equal((await request(server, { path: `/?token=${server.token}` })).status, 403);
		assert.equal(sent.length, 1);
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.deepEqual(closes, ["sent"]);
		assert.equal(server.closed, true);
		await assert.rejects(send());
	});

	it("rejects snapshot and send after the session switched, inserting nothing", async () => {
		let current = true;
		const { server, send, token, sent } = await start({ isCurrent: () => current });
		current = false;
		const snap = await request(server, { path: "/api/snapshot", headers: token() });
		assert.equal(snap.status, 409);
		const reply = await send();
		assert.equal(reply.status, 409);
		assert.equal(JSON.parse(reply.body).error, SESSION_SWITCHED);
		assert.equal(sent.length, 0);
		current = true;
		assert.equal((await send()).status, 200);
	});

	it("does not consume the token when inserting fails", async () => {
		let fail = true;
		const { send } = await start({
			onSend: () => {
				if (fail) throw new Error("editor busy");
				return 1;
			},
		});
		const failed = await send();
		assert.equal(failed.status, 500);
		fail = false;
		assert.equal((await send()).status, 200);
	});

	it("closes after the idle timeout", async () => {
		const { server, closes } = await start({ idleMs: 150 });
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual(closes, ["idle"]);
		assert.equal(server.closed, true);
	});

	it("answers unknown paths and methods without leaking anything", async () => {
		const { server, token } = await start();
		assert.equal((await request(server, { path: "/etc/passwd" })).status, 404);
		assert.equal((await request(server, { method: "POST", path: "/api/snapshot", headers: token() })).status, 405);
		assert.equal((await request(server, { method: "GET", path: "/api/send", headers: token() })).status, 405);
		assert.equal((await request(server, { method: "OPTIONS", path: "/api/send", headers: token({ origin: "http://evil.example" }) })).status, 405);
	});
});
