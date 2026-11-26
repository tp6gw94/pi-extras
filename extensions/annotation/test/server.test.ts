import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createConnection, createServer, type Server } from "node:net";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ReviewError } from "../review.ts";
import {
	type AnnotateServer,
	type CloseReason,
	DEFAULT_PORT,
	MAX_BODY_BYTES,
	preferredPort,
	SESSION_SWITCHED,
	SessionSwitchedError,
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

async function start(overrides: {
	review?: boolean;
	request?: (body?: unknown) => unknown;
	isCurrent?: () => boolean;
	longPollMs?: number;
	port?: number;
} = {}) {
	const closes: CloseReason[] = [];
	const server = await startAnnotateServer({
		sessionId: SID,
		items: [item("u1", "hello", "user")],
		port: overrides.port ?? 0,
		isCurrent: overrides.isCurrent ?? (() => true),
		longPollMs: overrides.longPollMs ?? 2000,
		onClose: (reason) => closes.push(reason),
	});
	servers.push(server);
	const auth = (extra: Record<string, string> = {}): Record<string, string> => ({ "x-annotate-token": server.token, ...extra });
	const api = (endpoint: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
		request(server.port, { method: init.method, path: `/${SID}/api/${endpoint}`, headers: init.headers ?? auth(), body: init.body });
	const reviewToken = overrides.review === false ? undefined : server.enableReview(SID, overrides.request ?? ((body) => ({ ok: true, body: body ?? null })));
	const review = (init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
		request(server.port, {
			method: init.method ?? "GET",
			path: `/${SID}/api/review`,
			headers: { "x-annotate-token": reviewToken!, ...init.headers },
			body: init.body,
		});
	return { server, closes, auth, api, reviewToken, review };
}

async function startWithAdmissions(count = 1, longPollMs?: number) {
	let observe!: () => void;
	const admitted = new Promise<void>((resolve) => { observe = resolve; });
	let remaining = 0;
	const fixture = await start({
		longPollMs,
		isCurrent: () => {
			if (remaining > 0 && --remaining === 0) observe();
			return true;
		},
	});
	remaining = count;
	const waitForAdmission = async (...polls: Promise<Reply>[]) => {
		const deadline = new AbortController();
		try {
			await Promise.race([
				admitted,
				delay(2000, undefined, { signal: deadline.signal }).then(() => assert.fail("Long-poll admission timed out")),
				...polls.map((poll) => poll.then((reply) => assert.fail(`Long-poll answered before admission: HTTP ${reply.status} ${reply.body}`))),
			]);
		} finally {
			deadline.abort();
		}
	};
	return { ...fixture, waitForAdmission };
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
	it("defaults to 4747 and honors a valid PI_ANNOTATE_PORT", () => {
		assert.equal(DEFAULT_PORT, 4747);
		assert.equal(preferredPort({}), 4747);
		assert.equal(preferredPort({ PI_ANNOTATE_PORT: "5100" }), 5100);
		for (const value of ["nope", "0", "70000", "-1", " 4747 "]) assert.equal(preferredPort({ PI_ANNOTATE_PORT: value }), 4747, value);
	});

	it("takes the next port when the preferred one is busy and checks Host against the bound port", async () => {
		const base = await freePort();
		await hold(base);
		const { server, auth } = await start({ port: base });
		assert.equal(server.port, base + 1);
		assert.equal((await request(server.port, { path: `/${SID}/api/snapshot`, headers: auth() })).status, 200);
		assert.equal((await request(server.port, { path: `/${SID}/api/snapshot`, headers: auth({ host: `127.0.0.1:${base}` }) })).status, 403);
	});
});

describe("native HTTP boundary", () => {
	it("serves snapshot and events only with the bound token and Host", async () => {
		const { server, api } = await start();
		const snapshot = await api("snapshot");
		assert.equal(snapshot.status, 200);
		assert.deepEqual(JSON.parse(snapshot.body), { sessionId: SID, version: 1, items: [item("u1", "hello", "user")] });
		assert.equal((await api("events?after=1")).status, 200);
		assert.equal((await api("snapshot", { headers: {} })).status, 403);
		assert.equal((await api("snapshot", { headers: { "x-annotate-token": "wrong" } })).status, 403);
		assert.equal((await request(server.port, { path: `/${SID}/api/snapshot?t=${server.token}` })).status, 403);
		for (const host of [`localhost:${server.port}`, "127.0.0.1", `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`]) {
			assert.equal((await request(server.port, { path: `/${SID}/api/snapshot`, headers: { "x-annotate-token": server.token, host } })).status, 403, host);
		}
		assert.equal((await api("snapshot", { method: "POST" })).status, 405);
	});

	it("removes the browser page, frame, diagram, and send routes", async () => {
		const { server } = await start();
		for (const path of [`/${SID}`, "/frame", "/frame/frame.js", "/frame/mermaid.js"]) {
			assert.equal((await request(server.port, { path })).status, 404, path);
		}
		const send = await request(server.port, {
			method: "POST",
			path: `/${SID}/api/send`,
			headers: { "x-annotate-token": server.token, "content-type": "application/json" },
			body: JSON.stringify({ seq: 1, items: [{ quote: "x" }] }),
		});
		assert.equal(send.status, 404);
	});

	it("answers malformed percent-encoding and event cursors with 400 and keeps serving", async () => {
		const { server, api } = await start();
		for (const path of ["/%E0/api/snapshot", `/${SID}%E0/api/snapshot`, `/${SID}/api/events?after=%E0`, `/${SID}/api/events`]) {
			const reply = await request(server.port, { path, headers: { "x-annotate-token": server.token } });
			assert.equal(reply.status, 400, path);
		}
		assert.equal((await request(server.port, { path: "/%E0", headers: { "x-annotate-token": server.token } })).status, 404);
		assert.equal((await api("snapshot")).status, 200);
	});

	it("rejects a request target that is not a path and keeps serving", async () => {
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
	});

	it("turns a throwing session check into 500 and keeps serving", async () => {
		let calls = 0;
		let throwAt = 0;
		const { api } = await start({
			isCurrent: () => {
				calls++;
				if (calls === throwAt) throw new Error("boom");
				return true;
			},
		});
		throwAt = calls + 1;
		assert.equal((await api("snapshot")).status, 500);
		throwAt = 0;
		assert.equal((await api("snapshot")).status, 200);
		assert.equal((await api("events?after=1")).status, 200);
	});
});

describe("review capability", () => {
	it("requires the native token, the current session path, and a local origin", async () => {
		const { server, auth, reviewToken } = await start();
		const path = `/${SID}/api/review`;
		assert.equal((await request(server.port, { path })).status, 403);
		assert.equal((await request(server.port, { path, headers: { "x-annotate-token": server.token } })).status, 403);
		assert.equal((await request(server.port, { path, headers: { "x-annotate-token": "wrong" } })).status, 403);
		assert.equal((await request(server.port, { path, headers: { "x-annotate-token": reviewToken!, origin: "http://evil.example" } })).status, 403);
		assert.equal((await request(server.port, { path: `/other/api/review`, headers: { "x-annotate-token": reviewToken! } })).status, 403);
		const sameOrigin = await request(server.port, { path, headers: { "x-annotate-token": reviewToken!, origin: `http://127.0.0.1:${server.port}` } });
		assert.equal(sameOrigin.status, 200);
		assert.deepEqual(JSON.parse(sameOrigin.body), { ok: true, body: null });
		assert.equal((await request(server.port, { path: `/${SID}/api/snapshot`, headers: auth({ "x-annotate-token": reviewToken! }) })).status, 200);
	});

	it("accepts JSON review posts and rejects other methods, types, bodies, and sizes", async () => {
		const { server, review, reviewToken } = await start();
		const post = (body: string, headers: Record<string, string> = {}) =>
			request(server.port, { method: "POST", path: `/${SID}/api/review`, headers: { "x-annotate-token": reviewToken!, "content-type": "application/json", ...headers }, body });
		assert.deepEqual(JSON.parse((await post('{"action":"save"}')).body), { ok: true, body: { action: "save" } });
		assert.equal((await review({ method: "PUT" })).status, 405);
		assert.equal((await post("{}", { "content-type": "text/plain" })).status, 415);
		assert.equal((await post("{")).status, 400);
		assert.equal((await post("{".repeat(MAX_BODY_BYTES + 1))).status, 413);
	});

	it("maps review action errors to 409 and unexpected errors to 500", async () => {
		const rejected = await start({ request: () => { throw new ReviewError("Select a current range."); } });
		const rejectedReply = await rejected.review();
		assert.equal(rejectedReply.status, 409);
		assert.deepEqual(JSON.parse(rejectedReply.body), { error: "Select a current range." });
		const broken = await start({ request: () => { throw new TypeError("boom"); } });
		assert.equal((await broken.review()).status, 500);
		assert.equal((await rejected.review({ headers: { origin: "http://evil.example" } })).status, 403);
	});

	it("returns 500 when a review session check throws after admission", async () => {
		let acceptedChecks = Infinity;
		const { review } = await start({ isCurrent: () => {
			if (acceptedChecks-- === 0) throw new Error("source unavailable");
			return true;
		} });
		for (const init of [undefined, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }]) {
			acceptedChecks = 1;
			assert.equal((await review(init)).status, 500);
		}
		acceptedChecks = Infinity;
		assert.equal((await review()).status, 200);
	});

	it("drops to 410 when the session is no longer current", async () => {
		let current = true;
		const { api, review, reviewToken } = await start({ isCurrent: () => current });
		assert.equal((await review()).status, 200);
		current = false;
		assert.equal((await review()).status, 410);
		assert.deepEqual(JSON.parse((await review()).body), { error: SESSION_SWITCHED });
		assert.equal((await api("snapshot")).status, 410);
		assert.equal((await api("snapshot", { headers: { "x-annotate-token": reviewToken! } })).status, 410);
	});

	it("serves review only while a native capability is enabled", async () => {
		const { server } = await start({ review: false });
		const path = `/${SID}/api/review`;
		const token = "native-token";
		assert.equal((await request(server.port, { path, headers: { "x-annotate-token": token } })).status, 404);
		const enabled = server.enableReview(SID, () => ({ ok: true }));
		assert.equal((await request(server.port, { path, headers: { "x-annotate-token": enabled } })).status, 200);
		server.disableReview();
		assert.equal((await request(server.port, { path, headers: { "x-annotate-token": enabled } })).status, 404);
	});

	it("rejects review capabilities for another or stale session", async () => {
		const { server } = await start();
		assert.throws(() => server.enableReview("other", () => null), SessionSwitchedError);
		let current = true;
		const stale = await start({ isCurrent: () => current });
		current = false;
		assert.throws(() => stale.server.enableReview(SID, () => null), SessionSwitchedError);
	});
});

describe("live updates", () => {
	it("holds a long-poll until new items arrive and then returns only the new items", async () => {
		const { server, api, waitForAdmission } = await startWithAdmissions();
		const poll = api("events?after=1");
		await waitForAdmission(poll);
		server.update([item("u1", "hello", "user"), item("a1", "reply")]);
		const reply = await poll;
		assert.equal(reply.status, 200);
		assert.deepEqual(JSON.parse(reply.body), { version: 2, reset: false, items: [item("a1", "reply")] });
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
		const { server, api, waitForAdmission } = await startWithAdmissions(4);
		const polls = [1, 2, 3, 4].map(() => api("events?after=1"));
		await waitForAdmission(...polls);
		assert.equal((await api("events?after=1")).status, 429);
		server.update([item("u1", "hello", "user"), item("a1", "reply")]);
		for (const reply of await Promise.all(polls)) assert.equal(reply.status, 200);
	});

	it("ends a pending long-poll immediately on close and releases the port", async () => {
		const { server, api, closes, waitForAdmission } = await startWithAdmissions(1, 20_000);
		const started = Date.now();
		const poll = api("events?after=1");
		await waitForAdmission(poll);
		server.close("end");
		await assert.rejects(poll);
		assert.ok(Date.now() - started < 2000);
		assert.deepEqual(closes, ["end"]);
		await delay(50);
		assert.equal(await canListen(server.port), true);
	});
});

describe("binding and handoff", () => {
	it("holds snapshot and event requests while parked and answers them after unpark with the same credentials", async () => {
		const { server, api, waitForAdmission } = await startWithAdmissions(1, 40);
		const token = server.token;
		const poll = api("events?after=1");
		await waitForAdmission(poll);
		server.park();
		const snapshot = api("snapshot");
		assert.equal(await Promise.race([Promise.race([poll, snapshot]).then(() => "answered"), delay(80, "held")]), "held");
		server.unpark();
		assert.equal(server.token, token);
		assert.equal((await poll).status, 200);
		const snapshotReply = await snapshot;
		assert.equal(snapshotReply.status, 200);
		assert.deepEqual(JSON.parse(snapshotReply.body), { sessionId: SID, version: 1, items: [item("u1", "hello", "user")] });
	});

	it("publishes updates made while parked when a held poll resumes after unpark", async () => {
		const { server, api, waitForAdmission } = await startWithAdmissions();
		const poll = api("events?after=1");
		await waitForAdmission(poll);
		server.park();
		assert.deepEqual(server.update([item("parked", "parked update")]), {
			version: 2, reset: true, items: [item("parked", "parked update")],
		});
		assert.equal(await Promise.race([poll.then(() => "answered"), delay(50, "held")]), "held");
		server.unpark();
		assert.deepEqual(JSON.parse((await poll).body), { version: 2, reset: true, items: [item("parked", "parked update")] });
	});

	it("rebinds to a new session, rotates credentials, resets history, and answers old tokens with the successor", async () => {
		const { server, auth, review } = await start();
		const oldToken = server.token;
		assert.equal((await review()).status, 200);
		server.park();
		server.rebind({ sessionId: "next", items: [item("n1", "new conversation")], isCurrent: () => true });
		assert.notEqual(server.token, oldToken);
		const oldReply = await request(server.port, { path: `/${SID}/api/snapshot`, headers: { "x-annotate-token": oldToken } });
		assert.equal(oldReply.status, 410);
		assert.deepEqual(JSON.parse(oldReply.body), { error: SESSION_SWITCHED, successor: { sessionId: "next", token: server.token } });
		assert.equal((await request(server.port, { path: `/${SID}/api/review`, headers: { "x-annotate-token": oldToken } })).status, 404);
		const snapshot = await request(server.port, { path: "/next/api/snapshot", headers: { "x-annotate-token": server.token } });
		assert.equal(snapshot.status, 200);
		assert.deepEqual(JSON.parse(snapshot.body), { sessionId: "next", version: 2, items: [item("n1", "new conversation")] });
		const history = await request(server.port, { path: `/${SID}/api/events?after=1`, headers: { "x-annotate-token": oldToken } });
		assert.equal(history.status, 410);
		assert.deepEqual(JSON.parse(history.body), { error: SESSION_SWITCHED, successor: { sessionId: "next", token: server.token } });
		assert.equal((await request(server.port, { path: `/${SID}/api/snapshot`, headers: auth() })).status, 410);
	});

	it("rejects stale native reads without revealing the successor", { timeout: 5000 }, async () => {
		const { server, reviewToken, waitForAdmission } = await startWithAdmissions(1, 20_000);
		const read = (session: string, endpoint: string, token: string) =>
			request(server.port, { path: `/${session}/api/${endpoint}`, headers: { "x-annotate-token": token } });
		const endpoints = ["snapshot", "events?after=0"] as const;
		const assertSwitched = (reply: Reply) => {
			assert.equal(reply.status, 410);
			assert.deepEqual(JSON.parse(reply.body), { error: SESSION_SWITCHED });
		};
		const readOldEndpoints = () => Promise.all(endpoints.map((endpoint) => read(SID, endpoint, reviewToken!)));
		const poll = read(SID, "events?after=1", reviewToken!);
		await waitForAdmission(poll);
		server.park();
		(await readOldEndpoints()).forEach(assertSwitched);

		const items = [item("n1", "new conversation")];
		server.rebind({ sessionId: "next", items, isCurrent: () => true });
		const newToken = server.enableReview("next", () => ({ sessionId: "next" }));
		assertSwitched(await poll);
		(await readOldEndpoints()).forEach(assertSwitched);
		for (const endpoint of endpoints) assert.equal((await read("next", endpoint, reviewToken!)).status, 403);

		const [snapshot, events, review] = await Promise.all([
			read("next", endpoints[0], newToken),
			read("next", endpoints[1], newToken),
			read("next", "review", newToken),
		]);
		for (const reply of [snapshot, events, review]) assert.equal(reply.status, 200);
		assert.deepEqual(JSON.parse(snapshot.body), { sessionId: "next", version: 2, items });
		assert.deepEqual(JSON.parse(events.body), { version: 2, reset: true, items });
		assert.deepEqual(JSON.parse(review.body), { sessionId: "next" });
	});

	it("ends parked polls and held requests on close and releases the port", async () => {
		const { server, api, closes, waitForAdmission } = await startWithAdmissions(1, 40);
		const poll = api("events?after=1");
		await waitForAdmission(poll);
		server.park();
		const snapshot = api("snapshot");
		assert.equal(await Promise.race([Promise.race([poll, snapshot]).then(() => "answered"), delay(120, "held")]), "held");
		const ended = Promise.all([assert.rejects(poll), assert.rejects(snapshot)]);
		server.close("session");
		await ended;
		assert.equal(server.closed, true);
		assert.deepEqual(closes, ["session"]);
		assert.equal(await canListen(server.port), true);
	});

	it("closes once, clears the review capability, and ignores updates after close", async () => {
		const { server, closes } = await start();
		const token = server.enableReview(SID, () => null);
		server.close("end");
		server.close("session");
		assert.equal(server.closed, true);
		assert.deepEqual(closes, ["end"]);
		assert.equal(server.update([item("late", "late")]), undefined);
		await assert.rejects(request(server.port, { path: `/${SID}/api/review`, headers: { "x-annotate-token": token } }));
		assert.throws(() => server.enableReview(SID, () => null), SessionSwitchedError);
	});
});
