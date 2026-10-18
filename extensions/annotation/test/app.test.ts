import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as lib from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { render } from "grok-mermaid";
import type { Annotation, AnnotationDelivery } from "../quote.ts";
import type { SnapshotItem } from "../snapshot.ts";
import { AnnotateApp } from "../tui/app.ts";
import { type AnnotateClient, createClient, type LiveEvent, ProtocolError, type SendOutcome } from "../tui/client.ts";

const ESC = "\x1b";
const ENTER = "\r";
const TAB = "\t";
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, "");
const settle = () => new Promise((resolve) => setImmediate(resolve));

const items: SnapshotItem[] = [
	{ id: "u1", kind: "user", label: "You", text: "explain the cache" },
	{ id: "a1", kind: "assistant", label: "Assistant", text: "The cache is LRU.\nIt holds 100 entries." },
];

const FLOW = "flowchart TD\n  A[Start] --> B[End]";
const FENCE = "```mermaid\n" + FLOW + "\n```";
const ART = render(FLOW)!;
const WARN_FENCE = "```mermaid\nflowchart TD\n  A --> B\n  --> C\n```";
const WARN_NOTICE = 'Mermaid diagram not rendered: dropped, does not start with a node: "--> C"';
const diagramItem = (text: string): SnapshotItem => ({ id: "a1", kind: "assistant", label: "Assistant", text });

function setup(source: SnapshotItem[], options: { send?: (seq: number, items: readonly Annotation[]) => SendOutcome | Promise<SendOutcome>; rows?: number; columns?: number } = {}) {
	const sent: { seq: number; items: Annotation[] }[] = [];
	const deliveries: AnnotationDelivery[] = [];
	let watcher: { resolve: (event: LiveEvent) => void; reject: (error: unknown) => void } | undefined;
	let sessionId = "abc12345";
	let exited = false;
	const client: AnnotateClient = {
		get sessionId() {
			return sessionId;
		},
		snapshot: async () => ({ version: 1, nextSeq: 1, items: source }),
		watch: (_after, signal) =>
			new Promise<LiveEvent>((resolve, reject) => {
				watcher = { resolve, reject };
				signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
		send: async (seq, batch, delivery) => {
			deliveries.push(delivery);
			sent.push({ seq, items: batch.map(({ quote, note }) => ({ quote, note })) });
			return options.send?.(seq, batch) ?? { ok: true, inserted: batch.length, nextSeq: seq + 1 };
		},
	};
	const columns = options.columns ?? 60;
	const tui = { terminal: { rows: options.rows ?? 20, columns }, requestRender: () => {} } as unknown as TUI;
	const app = new AnnotateApp({ lib, tui, client, snapshot: { version: 1, nextSeq: 1, items: source }, title: (id) => `pi-annotation · repo · ${id.slice(-8)}`, onExit: () => (exited = true) });
	app.focused = true;
	const keys = (...inputs: string[]) => {
		for (const input of inputs) {
			const special = input === ESC || input.startsWith(ESC) || input === ENTER || input === TAB;
			for (const key of special ? [input] : [...input]) app.handleInput(key);
		}
	};
	return {
		app,
		keys,
		screen: () => app.render(columns).map(strip),
		push: (update: Omit<Extract<LiveEvent, { type: "update" }>, "type">) => watcher?.resolve({ type: "update", ...update }),
		pushMoved: (snapshot: { version: number; nextSeq: number; items: SnapshotItem[] }) => watcher?.resolve({ type: "moved", snapshot }),
		moveSession: (id: string) => (sessionId = id),
		fail: (error: unknown) => watcher?.reject(error),
		sent,
		deliveries,
		exited: () => exited,
	};
}

describe("annotation TUI shell", () => {
	it("starts on the last message, fits the terminal and stays inside 60 columns", () => {
		const t = setup(items);
		const screen = t.screen();
		assert.equal(screen.length, 20);
		assert.match(screen[0]!, /^pi-annotation · repo · abc12345 +0 notes {2}● live$/);
		assert.ok(screen.some((line) => line === "  The cache is LRU."));
		assert.ok(screen.some((line) => line === "  It holds 100 entries."));
		assert.ok(screen.some((line) => line.startsWith("● Assistant")));
		assert.match(screen.at(-1)!, /^ NORMAL {2}v select/);
		for (const line of t.app.render(60)) assert.ok(lib.visibleWidth(line) <= 60, JSON.stringify(line));
	});

	it("annotates a character selection and sends it with s", async () => {
		const t = setup(items);
		t.keys("j", "w", "v", "e", "a");
		assert.ok(t.screen().some((line) => line.includes("> holds")));
		t.keys("why", ENTER);
		assert.match(t.screen()[0]!, /1 note {2}● live$/);
		assert.match(t.screen().at(-1)!, /added note 1; s to append, S to submit/);
		t.keys("s");
		await settle();
		assert.deepEqual(t.sent, [{ seq: 1, items: [{ quote: "holds", note: "why" }] }]);
		assert.match(t.screen()[0]!, /0 notes {2}● live$/);
		assert.match(t.screen().at(-1)!, /sent 1 to the pi editor/);
	});

	it("annotates the whole message with A", async () => {
		const t = setup(items);
		t.keys("A", "solid", ENTER, "s");
		await settle();
		assert.deepEqual(t.sent, [{ seq: 1, items: [{ quote: "The cache is LRU.\nIt holds 100 entries.", note: "solid" }] }]);
	});

	it("keeps the visual selection when the note box is cancelled", () => {
		const t = setup(items);
		t.keys("j", "w", "v", "e", "a");
		assert.ok(t.screen().some((line) => line.includes("> holds")));
		t.keys(ESC);
		assert.match(t.screen().at(-1)!, /^ VISUAL/);
		t.keys("a");
		assert.ok(t.screen().some((line) => line.includes("> holds")));
	});

	it("edits and deletes notes from the list", () => {
		const t = setup(items);
		t.keys("A", "one", ENTER, "{", "A", "two", ENTER, TAB);
		assert.ok(t.screen().some((line) => line.includes("> The cache is LRU.")));
		t.keys("e");
		assert.match(t.screen().at(-1)!, /^ NOTE/);
		t.keys("!", ENTER);
		assert.ok(t.screen().some((line) => line === "     one!"));
		t.keys("d");
		assert.ok(!t.screen().some((line) => line === "     one!"));
		assert.ok(t.screen().some((line) => line.includes("> explain the cache")));
		t.keys(TAB);
		assert.match(t.screen().at(-1)!, /^ NORMAL/);
	});

	it("keeps notes when another client sent first", async () => {
		const t = setup(items, { send: () => ({ ok: false, kind: "conflict", expectedSeq: 9 }) });
		t.keys("A", "x", ENTER, "s");
		await settle();
		assert.match(t.screen()[0]!, /1 note {2}● live$/);
		assert.match(t.screen().at(-1)!, /another client sent first; your notes are kept/);
		t.keys("s");
		await settle();
		assert.deepEqual(
			t.sent.map((call) => call.seq),
			[1, 9],
		);
		assert.match(t.screen()[0]!, /1 note {2}● live$/);
	});

	it("keeps notes and clears sending when a send finds a successor", async () => {
		const t = setup(items, { send: () => ({ ok: false, kind: "moved", snapshot: { version: 7, nextSeq: 12, items } }) });
		t.keys("A", "keep me", ENTER, "s");
		await settle();
		assert.match(t.screen()[0]!, /1 note {2}● live$/);
		assert.equal(strip(t.app.render(120).at(-1)!).trim(), "NORMAL  pi moved to a new session; notes kept; choose s or S again");
		t.keys("s");
		await settle();
		assert.deepEqual(t.sent, [
			{ seq: 1, items: [{ quote: "The cache is LRU.\nIt holds 100 entries.", note: "keep me" }] },
			{ seq: 12, items: [{ quote: "The cache is LRU.\nIt holds 100 entries.", note: "keep me" }] },
		]);
		t.keys(TAB);
		assert.ok(t.screen().some((line) => line.trim() === "keep me"));
	});

	for (const first of ["send", "poll"] as const) {
		it(`shares a simultaneous handoff snapshot and moves once when ${first} answers first`, async () => {
			const requests: { path: string; body: unknown; token: string | null }[] = [];
			const replies = new Map<string, (response: Response) => void>();
			const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
				const path = new URL(String(input)).pathname + new URL(String(input)).search;
				requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null, token: new Headers(init?.headers).get("x-annotate-token") });
				return new Promise<Response>((resolve, reject) => {
					replies.set(path, resolve);
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			}) as typeof fetch;
			const client = createClient({ sessionId: "old-session", port: 4747, token: "old-token" }, fetchImpl);
			const moves: unknown[] = [];
			const outcomes: SendOutcome[] = [];
			const observed: AnnotateClient = {
				get sessionId() { return client.sessionId; },
				snapshot: () => client.snapshot(),
				watch: async (after, signal) => {
					const event = await client.watch(after, signal);
					if (event.type === "moved") moves.push(event.snapshot);
					return event;
				},
				send: async (seq, notes, delivery) => {
					const outcome = await client.send(seq, notes, delivery);
					outcomes.push(outcome);
					return outcome;
				},
			};
			const tui = { terminal: { rows: 20, columns: 120 }, requestRender: () => {} } as unknown as TUI;
			const app = new AnnotateApp({ lib, tui, client: observed, snapshot: { version: 1, nextSeq: 1, items }, title: (id) => `pi-annotation · ${id}`, onExit: () => {} });
			const screen = () => app.render(120).map(strip);
			const answer = (path: string, status: number, body: unknown) => replies.get(path)!(new Response(JSON.stringify(body), { status }));
			app.start();
			try {
				for (const key of ["A", ..."keep me", ENTER, "s"]) app.handleInput(key);
				const paths = ["/old-session/api/send", "/old-session/api/events?after=1"];
				if (first === "poll") paths.reverse();
				for (const path of paths) answer(path, 410, { successor: { sessionId: "new-session", token: "new-token" } });
				await settle();
				assert.deepEqual(requests.filter(({ path }) => path.endsWith("/snapshot")), [{ path: "/new-session/api/snapshot", body: null, token: "new-token" }]);
				answer("/new-session/api/snapshot", 200, { version: 7, nextSeq: 12, items });
				await settle();
				assert.deepEqual(moves, first === "poll" ? [{ version: 7, nextSeq: 12, items }] : []);
				assert.deepEqual(outcomes, [{ ok: false, kind: "moved", snapshot: { version: 7, nextSeq: 12, items } }]);
				assert.equal(screen()[0]!.trim().replace(/ +/g, " "), "pi-annotation · new-session 1 note ● live");
				assert.equal(screen().at(-1)!.trim(), "NORMAL  pi moved to a new session; notes kept; choose s or S again");
				assert.equal(requests.at(-1)!.path, "/new-session/api/events?after=7");
				app.handleInput(TAB);
				assert.equal(screen().find((line) => line.trim() === "keep me")?.trim(), "keep me");
				app.handleInput("s");
				assert.deepEqual(requests.at(-1), { path: "/new-session/api/send", token: "new-token", body: { seq: 12, delivery: "editor", items: [{ quote: "The cache is LRU.\nIt holds 100 entries.", note: "keep me" }] } });
				answer("/new-session/api/send", 200, { inserted: 1, nextSeq: 13 });
				await settle();
				assert.match(screen()[0]!, /0 notes {2}● live$/);
			} finally {
				app.stop();
			}
		});
	}

	it("reports the head once when the successor snapshot finds another successor", async () => {
		const requests: { path: string; token: string | null }[] = [];
		const replies = new Map<string, (response: Response) => void>();
		const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const path = url.pathname + url.search;
			requests.push({ path, token: new Headers(init?.headers).get("x-annotate-token") });
			return new Promise<Response>((resolve, reject) => {
				replies.set(path, resolve);
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}) as typeof fetch;
		const client = createClient({ sessionId: "old-session", port: 4747, token: "old-token" }, fetchImpl);
		const events: LiveEvent[] = [];
		const observed: AnnotateClient = {
			get sessionId() { return client.sessionId; },
			snapshot: () => client.snapshot(),
			watch: async (after, signal) => {
				const event = await client.watch(after, signal);
				events.push(event);
				return event;
			},
			send: (seq, notes, delivery) => client.send(seq, notes, delivery),
		};
		const tui = { terminal: { rows: 20, columns: 120 }, requestRender: () => {} } as unknown as TUI;
		const app = new AnnotateApp({ lib, tui, client: observed, snapshot: { version: 1, nextSeq: 1, items }, title: (id) => `pi-annotation · ${id}`, onExit: () => {} });
		const screen = () => app.render(120).map(strip);
		const answer = (path: string, status: number, body: unknown) => replies.get(path)!(new Response(JSON.stringify(body), { status }));
		app.start();
		try {
			for (const key of ["A", ..."keep me", ENTER]) app.handleInput(key);
			answer("/old-session/api/events?after=1", 410, { successor: { sessionId: "new-session", token: "new-token" } });
			await settle();
			answer("/new-session/api/snapshot", 410, { successor: { sessionId: "head-session", token: "head-token" } });
			await settle();
			answer("/head-session/api/snapshot", 200, { version: 9, nextSeq: 14, items });
			await settle();
			assert.deepEqual(events, [{ type: "moved", snapshot: { version: 9, nextSeq: 14, items } }]);
			assert.deepEqual(requests, [
				{ path: "/old-session/api/events?after=1", token: "old-token" },
				{ path: "/new-session/api/snapshot", token: "new-token" },
				{ path: "/head-session/api/snapshot", token: "head-token" },
				{ path: "/head-session/api/events?after=9", token: "head-token" },
			]);
			assert.equal(screen()[0]!.trim().replace(/ +/g, " "), "pi-annotation · head-session 1 note ● live");
			assert.equal(screen().at(-1)!.trim(), "NORMAL  pi moved to a new session; notes kept");
			answer("/head-session/api/events?after=9", 200, { version: 10, reset: false, items: [] });
			await settle();
			assert.deepEqual(events, [
				{ type: "moved", snapshot: { version: 9, nextSeq: 14, items } },
				{ type: "update", version: 10, reset: false, items: [] },
			]);
			assert.deepEqual(requests.at(-1), { path: "/head-session/api/events?after=10", token: "head-token" });
			app.handleInput(TAB);
			assert.equal(screen().find((line) => line.trim() === "keep me")?.trim(), "keep me");
		} finally {
			app.stop();
		}
	});

	it("keeps notes when a delayed send finds the successor already reported by the poll", async () => {
		const requests: string[] = [];
		const replies = new Map<string, (response: Response) => void>();
		const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const path = url.pathname + url.search;
			requests.push(path);
			return new Promise<Response>((resolve, reject) => {
				replies.set(path, resolve);
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}) as typeof fetch;
		const client = createClient({ sessionId: "old-session", port: 4747, token: "old-token" }, fetchImpl);
		const outcomes: SendOutcome[] = [];
		const observed: AnnotateClient = {
			get sessionId() { return client.sessionId; },
			snapshot: () => client.snapshot(),
			watch: (after, signal) => client.watch(after, signal),
			send: async (seq, notes, delivery) => {
				const outcome = await client.send(seq, notes, delivery);
				outcomes.push(outcome);
				return outcome;
			},
		};
		const tui = { terminal: { rows: 20, columns: 120 }, requestRender: () => {} } as unknown as TUI;
		const app = new AnnotateApp({ lib, tui, client: observed, snapshot: { version: 1, nextSeq: 1, items }, title: (id) => `pi-annotation · ${id}`, onExit: () => {} });
		const screen = () => app.render(120).map(strip);
		const answer = (path: string, status: number, body: unknown) => replies.get(path)!(new Response(JSON.stringify(body), { status }));
		const successor = { sessionId: "new-session", token: "new-token" };
		app.start();
		try {
			for (const key of ["A", ..."keep me", ENTER, "s"]) app.handleInput(key);
			answer("/old-session/api/events?after=1", 410, { successor });
			await settle();
			answer("/new-session/api/snapshot", 200, { version: 7, nextSeq: 12, items });
			await settle();
			assert.equal(screen().at(-1)!.trim(), "NORMAL  pi moved to a new session; notes kept");
			app.handleInput("s");
			assert.deepEqual(requests, [
				"/old-session/api/events?after=1",
				"/old-session/api/send",
				"/new-session/api/snapshot",
				"/new-session/api/events?after=7",
			]);
			answer("/old-session/api/send", 410, { successor });
			await settle();
			assert.deepEqual(outcomes, [{ ok: false, kind: "moved", snapshot: undefined }]);
			assert.deepEqual(requests, [
				"/old-session/api/events?after=1",
				"/old-session/api/send",
				"/new-session/api/snapshot",
				"/new-session/api/events?after=7",
			]);
			assert.equal(screen()[0]!.trim().replace(/ +/g, " "), "pi-annotation · new-session 1 note ● live");
			assert.equal(screen().at(-1)!.trim(), "NORMAL  pi moved to a new session; notes kept; choose s or S again");
			app.handleInput(TAB);
			assert.equal(screen().find((line) => line.trim() === "keep me")?.trim(), "keep me");
			app.handleInput("s");
			assert.equal(requests.at(-1), "/new-session/api/send");
			answer("/new-session/api/send", 200, { inserted: 1, nextSeq: 13 });
			await settle();
			assert.deepEqual(outcomes, [
				{ ok: false, kind: "moved", snapshot: undefined },
				{ ok: true, inserted: 1, nextSeq: 13 },
			]);
			assert.match(screen()[0]!, /0 notes {2}● live$/);
		} finally {
			app.stop();
		}
	});

	it("keeps incremental items when a delayed send reports an already applied move", async () => {
		const requests: string[] = [];
		const replies = new Map<string, (response: Response) => void>();
		const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const path = url.pathname + url.search;
			requests.push(path);
			return new Promise<Response>((resolve, reject) => {
				replies.set(path, resolve);
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		}) as typeof fetch;
		const client = createClient({ sessionId: "old-session", port: 4747, token: "old-token" }, fetchImpl);
		const tui = { terminal: { rows: 20, columns: 120 }, requestRender: () => {} } as unknown as TUI;
		const app = new AnnotateApp({ lib, tui, client, snapshot: { version: 1, nextSeq: 1, items }, title: (id) => `pi-annotation · ${id}`, onExit: () => {} });
		const screen = () => app.render(120).map(strip);
		const answer = (path: string, status: number, body: unknown) => replies.get(path)!(new Response(JSON.stringify(body), { status }));
		const successor = { sessionId: "new-session", token: "new-token" };
		app.start();
		try {
			for (const key of ["A", ..."keep me", ENTER, "s"]) app.handleInput(key);
			answer("/old-session/api/events?after=1", 410, { successor });
			await settle();
			answer("/new-session/api/snapshot", 200, { version: 7, nextSeq: 12, items });
			await settle();
			answer("/new-session/api/events?after=7", 200, { version: 8, reset: false, items: [{ id: "a2", kind: "assistant", label: "Assistant", text: "Version eight reply" }] });
			await settle();
			assert.equal(screen().find((line) => line === "  Version eight reply"), "  Version eight reply");
			answer("/old-session/api/send", 410, { successor });
			await settle();
			assert.equal(screen().find((line) => line === "  Version eight reply"), "  Version eight reply");
			assert.equal(screen().at(-1)!.trim(), "NORMAL  pi moved to a new session; notes kept; choose s or S again");
			assert.deepEqual(requests, [
				"/old-session/api/events?after=1",
				"/old-session/api/send",
				"/new-session/api/snapshot",
				"/new-session/api/events?after=7",
				"/new-session/api/events?after=8",
			]);
			app.handleInput(TAB);
			assert.equal(screen().find((line) => line.trim() === "keep me")?.trim(), "keep me");
			app.handleInput("s");
			assert.equal(requests.at(-1), "/new-session/api/send");
			answer("/new-session/api/send", 200, { inserted: 1, nextSeq: 13 });
			await settle();
			assert.match(screen()[0]!, /0 notes {2}● live$/);
		} finally {
			app.stop();
		}
	});

	it("appends live updates and keeps the caret", async () => {
		const t = setup(items);
		t.app.start();
		t.keys("j");
		t.push({ version: 2, reset: false, items: [{ id: "t1", kind: "tool", label: "Tool", text: "called bash" }] });
		await settle();
		const screen = t.screen();
		assert.ok(screen.some((line) => line.startsWith("▸ Tool")));
		assert.ok(screen.some((line) => line === "  It holds 100 entries."));
		t.app.stop();
	});

	it("clears a visual selection when the conversation resets", async () => {
		const t = setup(items);
		t.app.start();
		t.keys("j", "v", "l");
		t.push({ version: 2, reset: true, items: [{ id: "u1", kind: "user", label: "You", text: "explain the cache" }] });
		await settle();
		assert.match(t.screen().at(-1)!, /selection cleared: conversation changed/);
		assert.match(t.screen()[0]!, /0 notes {2}● live$/);
		t.app.stop();
	});

	it("follows a moved session in place while keeping notes and editor text", async () => {
		const t = setup(items);
		t.keys("A", "saved note", ENTER, "A", "draft text");
		t.app.start();
		t.moveSession("new-session-23456789");
		t.pushMoved({ version: 8, nextSeq: 14, items });
		await settle();
		const screen = t.screen();
		assert.match(screen[0]!, /^pi-annotation · repo · 23456789 +1 note {2}● live$/);
		assert.match(screen.at(-1)!, /pi moved to a new session; notes kept/);
		assert.ok(screen.some((line) => line.includes("draft text")), screen.join("\n"));
		assert.match(screen.at(-1)!, /^ NOTE/);
		t.app.stop();
	});

	it("closes the connection when pi switched session and refuses further sends", async () => {
		const t = setup(items);
		t.app.start();
		t.fail(new ProtocolError("switched", "session switched", 410));
		await settle();
		assert.match(t.screen()[0]!, /○ closed$/);
		assert.match(t.screen().at(-1)!, /pi switched session; run \/annotate and attach again/);
		t.keys("A", "late", ENTER, "s");
		await settle();
		assert.deepEqual(t.sent, []);
		assert.match(t.screen().at(-1)!, /pi switched session; run \/annotate and attach again/);
		t.app.stop();
	});

	it("asks again before quitting with unsent notes and disarms on any other key", () => {
		const t = setup(items);
		t.keys("A", ENTER);
		t.keys("q");
		assert.equal(t.exited(), false);
		assert.match(t.screen().at(-1)!, /1 unsent note; press again to quit/);
		t.keys("j", "q");
		assert.equal(t.exited(), false);
		t.keys("q");
		assert.equal(t.exited(), true);
	});

	it("disarms the quit warning when typing into the note editor", () => {
		const t = setup(items);
		t.keys("A", "x", ENTER);
		t.keys("A", "\x03");
		assert.equal(t.exited(), false);
		assert.match(t.screen().at(-1)!, /1 unsent note; press again to quit/);
		t.keys("abc", "\x03");
		assert.equal(t.exited(), false);
		assert.match(t.screen().at(-1)!, /1 unsent note; press again to quit/);
		t.keys("\x03");
		assert.equal(t.exited(), true);
	});

	it("shows the quit warning when Ctrl-C arms it from search mode and exits on the second Ctrl-C", () => {
		const t = setup(items);
		t.keys("A", ENTER);
		t.keys("/", "ca");
		t.keys("\x03");
		assert.equal(t.exited(), false);
		assert.match(t.screen().at(-1)!, /^ NORMAL /);
		assert.match(t.screen().at(-1)!, /1 unsent note; press again to quit/);
		t.keys("\x03");
		assert.equal(t.exited(), true);
	});

	it("keeps the quit warning ahead of a later asynchronous message", async () => {
		let release: (outcome: SendOutcome) => void = () => {};
		const t = setup(items, { send: () => new Promise<SendOutcome>((resolve) => (release = resolve)) });
		t.keys("A", ENTER);
		t.keys("s");
		t.keys("\x03");
		assert.match(t.screen().at(-1)!, /1 unsent note; press again to quit/);
		release({ ok: false, kind: "conflict", expectedSeq: 9 });
		await settle();
		const status = t.screen().at(-1)!;
		assert.match(status, /1 unsent note; press again to quit/);
		assert.ok(status.indexOf("unsent") < status.indexOf("another"), status);
		t.keys("\x03");
		assert.equal(t.exited(), true);
	});

	it("drops the quit warning when a send completes after arming", async () => {
		let release: (outcome: SendOutcome) => void = () => {};
		const t = setup(items, { send: () => new Promise<SendOutcome>((resolve) => (release = resolve)) });
		t.keys("A", ENTER);
		t.keys("s");
		t.keys("\x03");
		assert.match(t.screen().at(-1)!, /1 unsent note; press again to quit/);
		release({ ok: true, inserted: 1, nextSeq: 2 });
		await settle();
		const status = t.screen().at(-1)!;
		assert.ok(!status.includes("press again to quit"), status);
		assert.match(status, /sent 1 to the pi editor/);
		t.keys("\x03");
		assert.equal(t.exited(), true);
	});

	it("disarms the quit warning on an unbound key in normal mode", () => {
		const t = setup(items);
		t.keys("A", ENTER);
		t.keys("\x03");
		assert.match(t.screen().at(-1)!, /1 unsent note; press again to quit/);
		t.keys("x");
		assert.ok(!t.screen().at(-1)!.includes("press again to quit"));
		t.keys("\x03");
		assert.equal(t.exited(), false);
		t.keys("\x03");
		assert.equal(t.exited(), true);
	});

	it("saves typed text exactly even when it contains command keys", () => {
		const t = setup(items);
		t.keys("A", "qsv1", ENTER, TAB);
		assert.ok(t.screen().some((line) => line.trim() === "qsv1"));
	});

	it("searches with / and repeats with n", async () => {
		const t = setup(items);
		t.keys("/");
		assert.ok(t.screen().at(-1)!.startsWith("/"));
		t.keys("cache", ENTER, "a", "first", ENTER);
		t.keys("n", "a", "second", ENTER, "s");
		await settle();
		assert.deepEqual(t.sent, [
			{
				seq: 1,
				items: [
					{ quote: "The cache is LRU.", note: "first" },
					{ quote: "explain the cache", note: "second" },
				],
			},
		]);
	});

	it("reports a search miss", () => {
		const t = setup(items);
		t.keys("/", "zzz", ENTER);
		assert.match(t.screen().at(-1)!, /not found: zzz/);
	});

	it("folds and unfolds tool output with Enter", () => {
		const t = setup([...items, { id: "t1", kind: "tool", label: "Tool", text: "called bash" }]);
		assert.ok(t.screen().some((line) => line.startsWith("▸ Tool")));
		assert.ok(!t.screen().some((line) => line.includes("called bash")));
		t.keys(ENTER);
		assert.ok(t.screen().some((line) => line.startsWith("▾ Tool")));
		assert.ok(t.screen().some((line) => line.includes("called bash")));
	});

	it("draws mermaid art with class SGR and the caret while hiding the fence source", () => {
		const t = setup([items[0]!, diagramItem(FENCE)]);
		const screen = t.screen();
		for (const line of ART.plain) assert.ok(screen.includes("  " + line), `missing art line ${JSON.stringify(line)}\n${screen.join("\n")}`);
		assert.ok(!screen.some((line) => line.includes("flowchart TD")), screen.join("\n"));
		const first = screen.indexOf("  " + ART.plain[0]!);
		assert.ok(first > 0, screen.join("\n"));
		const raw = t.app.render(60);
		assert.match(raw[first]!, /\x1b\[2;7m/);
		assert.match(raw[first + 1]!, /\x1b\[2m│/);
	});

	it("draws the dim notice row under the source when warnings fall back", () => {
		const t = setup([items[0]!, diagramItem(WARN_FENCE)]);
		const screen = t.screen();
		assert.ok(screen.includes("  flowchart TD"), screen.join("\n"));
		const at = screen.findIndex((line) => line.startsWith("  Mermaid diagram not rendered:"));
		assert.ok(at > 0, screen.join("\n"));
		assert.equal(screen[at], strip(lib.truncateToWidth("  " + WARN_NOTICE, 60)));
		assert.match(t.app.render(60)[at]!, /\x1b\[2m/);
	});

	it("paints markdown markers, headings and code spans and keeps the source text", () => {
		const t = setup([
			{ id: "u1", kind: "user", label: "You", text: "## Cache" },
			{ id: "a1", kind: "assistant", label: "Assistant", text: "run `ls` now" },
		]);
		const raw = t.app.render(60);
		const heading = raw.find((line) => strip(line) === "  ## Cache")!;
		assert.match(heading, /\x1b\[2m##\x1b\[0m/);
		assert.match(heading, /\x1b\[1;34m Cache\x1b\[0m/);
		const code = raw.find((line) => strip(line) === "  run `ls` now")!;
		assert.match(code, /\x1b\[33mls\x1b\[0m/);
	});

	it("underlines every art row of a block covered by a note", () => {
		const t = setup([items[0]!, diagramItem(FENCE)]);
		t.keys("A", "x", ENTER);
		const screen = t.screen();
		const raw = t.app.render(60);
		for (const line of ART.plain) {
			const at = screen.indexOf("  " + line);
			assert.ok(at > 0, screen.join("\n"));
			assert.match(raw[at]!, /\x1b\[[0-9;]*4[0-9;]*m/, `no underline on ${line}`);
		}
	});

	it("paints the selection background across every art row of the block", () => {
		const t = setup([items[0]!, diagramItem(FENCE)]);
		t.keys("j", "v", "j");
		const screen = t.screen();
		const raw = t.app.render(60);
		for (const line of ART.plain) {
			const at = screen.indexOf("  " + line);
			assert.ok(at > 0, screen.join("\n"));
			assert.ok(raw[at]!.includes("48;5;24"), `no selection on ${line}`);
		}
	});

	it("paints the notice row with the selection background when the selection covers the fence", () => {
		const t = setup([items[0]!, diagramItem(WARN_FENCE)]);
		t.keys("v", "j", "j", "j", "j", "j");
		const at = t.screen().findIndex((line) => line.startsWith("  Mermaid diagram not rendered:"));
		assert.ok(at > 0, t.screen().join("\n"));
		assert.match(t.app.render(60)[at]!, /\x1b\[2;48;5;24m/);
	});

	it("leaves the notice row unpainted when the selection covers only part of the fence", () => {
		const t = setup([items[0]!, diagramItem(WARN_FENCE)]);
		t.keys("v", "j", "j", "j", "j");
		const at = t.screen().findIndex((line) => line.startsWith("  Mermaid diagram not rendered:"));
		assert.ok(at > 0, t.screen().join("\n"));
		assert.doesNotMatch(t.app.render(60)[at]!, /48;5;24/);
	});

	it("underlines the notice row only when a note covers the whole fence", () => {
		const underlined = /(\x1b\[|;)4(;|m)/;
		const noticeRow = (t: ReturnType<typeof setup>) => t.app.render(60)[t.screen().findIndex((line) => line.startsWith("  Mermaid diagram not rendered:"))]!;
		const partial = setup([items[0]!, diagramItem(WARN_FENCE)]);
		partial.keys("v", "j", "j", "j", "j", "a", "x", ENTER);
		assert.doesNotMatch(noticeRow(partial), underlined);
		const whole = setup([items[0]!, diagramItem(WARN_FENCE)]);
		whole.keys("v", "j", "j", "j", "j", "j", "a", "x", ENTER);
		assert.match(noticeRow(whole), underlined);
	});

	it("lists the diagram toggle in the help screen at 60 columns", () => {
		const t = setup(items);
		t.keys("?", ..."j".repeat(15).split(""));
		assert.ok(t.screen().some((line) => /^ {2}Enter za +fold tool or diagram +normal$/.test(line)), t.screen().join("\n"));
	});

	it("shows the bindings-derived help screen with labels and modes, scrolls it and closes it", () => {
		const t = setup(items);
		t.keys("?");
		const screen = t.screen();
		assert.match(screen.at(-1)!, /^ HELP/);
		assert.ok(screen.some((line) => /^ {2}h ← l → +move by character +normal\/visual$/.test(line)), screen.join("\n"));
		assert.ok(screen.some((line) => /^ {2}Ctrl-f PgDn +page down +normal\/visual$/.test(line)));
		assert.ok(!screen.some((line) => line.includes("send notes")));
		t.keys("j".repeat(15));
		assert.ok(t.screen().some((line) => /^ {2}Esc q +leave visual +visual$/.test(line)), t.screen().join("\n"));
		t.keys("j".repeat(45));
		const scrolled = t.screen();
		assert.ok(scrolled.some((line) => /^ {2}s +append notes to editor +normal\/list$/.test(line)), scrolled.join("\n"));
		t.keys("x");
		assert.match(t.screen().at(-1)!, /^ NORMAL/);
	});

	describe("status hints at 80 columns", () => {
		const bar = (...inputs: string[]) => {
			const t = setup(items, { columns: 80 });
			t.keys(...inputs);
			return t.screen().at(-1)!;
		};
		const shows = (line: string, parts: string[]) => {
			for (const part of parts) assert.ok(line.includes(part), `${part} is missing from: ${line}`);
		};

		it("shows v, a, Tab, s, q and ? in normal mode", () => {
			const line = bar();
			assert.match(line, /^ NORMAL /);
			shows(line, ["v ", "a ", "Tab ", "s ", "q ", "? "]);
			assert.ok(!line.includes("…"), line);
		});

		it("shows a, o and Esc in visual mode and no q quit", () => {
			const line = bar("v");
			assert.match(line, /^ VISUAL /);
			shows(line, ["a ", "o ", "Esc "]);
			assert.ok(!line.includes("q quit"), line);
		});

		it("shows Enter, e, d and s in list mode", () => {
			const line = bar("A", "x", ENTER, TAB);
			assert.match(line, /^ LIST /);
			shows(line, ["Enter ", "e ", "d ", "s "]);
		});

		it("shows Enter save, Ctrl-J new line and Esc in note mode", () => {
			const line = bar("A");
			assert.match(line, /^ NOTE /);
			shows(line, ["Enter save", "Ctrl-J new line", "Esc "]);
		});
	});

	it("keeps the caret row above the note panel when a opens it on the last visible body row", () => {
		const tall = [{ id: "a1", kind: "assistant" as const, label: "Assistant", text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") }];
		const t = setup(tall, { rows: 12 });
		t.keys("j".repeat(8));
		assert.equal(t.screen()[10], "  line 8");
		t.keys("a");
		const screen = t.screen();
		const caretRow = screen.indexOf("  line 8");
		const panelRow = screen.findIndex((line) => line.includes("> line 8"));
		assert.ok(caretRow > 0, screen.join("\n"));
		assert.ok(panelRow > caretRow, screen.join("\n"));
		t.keys(ESC);
		assert.ok(t.screen().includes("  line 8"));
	});

	it("shows the header of the last message on start and the first header after gg", () => {
		const tall = [items[0]!, { id: "a1", kind: "assistant" as const, label: "Assistant", text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") }];
		const t = setup(tall);
		assert.match(t.screen()[1]!, /^● Assistant/);
		assert.equal(t.screen()[2], "  line 0");
		t.keys("gg");
		assert.match(t.screen()[1]!, /^● You/);
	});

	it("walks k up to the previous message and quotes the whole message from its header", () => {
		const t = setup(items);
		t.keys("k", "k");
		t.keys("k", "k");
		t.keys("a");
		assert.ok(t.screen().some((line) => line.includes("> explain the cache")));
		t.keys(ESC);
		t.keys("j", "j", "a");
		assert.ok(t.screen().some((line) => line.includes("> The cache is LRU.")));
		assert.ok(t.screen().some((line) => line.includes("> It holds 100 entries.")));
	});

	it("keeps the caret on screen after a search jumps into a folded tool far down", () => {
		const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
		const t = setup([items[0]!, { id: "a1", kind: "assistant", label: "Assistant", text: long }, { id: "t1", kind: "tool", label: "Tool", text: `${long}\nneedle here` }]);
		t.keys("gg", "/", "needle", ENTER);
		assert.ok(t.screen().some((line) => line === "  needle here"), t.screen().join("\n"));
	});

	it("keeps the notes and the live connection when the server rejects a send", async () => {
		const t = setup(items, { send: () => ({ ok: false, kind: "rejected", reason: "body too large" }) });
		t.keys("A", "x", ENTER, "s");
		await settle();
		assert.match(t.screen()[0]!, /1 note {2}● live$/);
		assert.match(t.screen().at(-1)!, /body too large/);
		t.keys("s");
		await settle();
		assert.equal(t.sent.length, 2);
	});

	it("closes the connection but keeps the notes when a send finds the session switched", async () => {
		const t = setup(items, {
			send: () => {
				throw new ProtocolError("switched", "session switched", 410);
			},
		});
		t.keys("A", "x", ENTER, "s");
		await settle();
		assert.match(t.screen()[0]!, /1 note {2}○ closed$/);
		assert.match(t.screen().at(-1)!, /pi switched session/);
	});
});

describe("direct submission", () => {
	for (const list of [false, true]) {
		it(`submits every saved note from ${list ? "list" : "normal"} mode, retaining later notes`, async () => {
			let release!: (outcome: SendOutcome) => void;
			const t = setup(items, { send: () => new Promise<SendOutcome>((resolve) => { release = resolve; }) });
			t.keys("a", "first", ENTER, "j", "a", "second", ENTER);
			if (list) t.keys(TAB);
			t.keys("S", "s", "S");
			assert.deepEqual(t.sent, [{ seq: 1, items: [
				{ quote: "The cache is LRU.", note: "first" },
				{ quote: "It holds 100 entries.", note: "second" },
			] }]);
			assert.deepEqual(t.deliveries, ["agent"]);
			if (list) t.keys(TAB);
			t.keys("a", "later", ENTER);
			release({ ok: true, inserted: 2, nextSeq: 2 });
			await settle();
			assert.match(t.screen().at(-1)!, /submitted 2 to pi/);
			t.keys(TAB);
			assert.match(t.screen()[0]!, /1 note/);
			assert.ok(t.screen().some((line) => line.trim() === "later"));
		});
	}
	for (const outcome of [
		{ ok: false, kind: "conflict", expectedSeq: 9 },
		{ ok: false, kind: "rejected", reason: "submission failed" },
	] as const) {
		it(`keeps exact notes after direct ${outcome.kind}`, async () => {
			const t = setup(items, { send: () => outcome });
			t.keys("a", "keep me", ENTER, "S");
			await settle();
			t.keys(TAB);
			assert.match(t.screen()[0]!, /1 note/);
			assert.ok(t.screen().some((line) => line.trim() === "keep me"));
			t.keys("s");
			await settle();
			assert.deepEqual(t.deliveries, ["agent", "editor"]);
			assert.deepEqual(t.sent[1], { seq: outcome.kind === "conflict" ? 9 : 1, items: [{ quote: "The cache is LRU.", note: "keep me" }] });
		});
	}
});

describe("client send outcomes", () => {
	const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
	const clientFor = (fetchImpl: typeof fetch) => createClient({ sessionId: "s", port: 1, token: "t" }, fetchImpl);
	const send = (fetchImpl: typeof fetch) => clientFor(fetchImpl).send(1, [{ quote: "q", note: "n" }], "editor");

	it("returns the inserted count on 200 and the expected seq on 409", async () => {
		assert.deepEqual(await send(reply(200, { inserted: 1, nextSeq: 2 })), { ok: true, inserted: 1, nextSeq: 2 });
		assert.deepEqual(await send(reply(409, { error: "expected seq 5", expectedSeq: 5 })), { ok: false, kind: "conflict", expectedSeq: 5 });
	});

	it("yields one moved event and polls the successor path with its token", async () => {
		const requests: { url: string; token: string | null }[] = [];
		const replies = [
			new Response(JSON.stringify({ error: "SESSION_SWITCHED", successor: { sessionId: "new-session", token: "new-token" } }), { status: 410 }),
			new Response(JSON.stringify({ version: 7, nextSeq: 12, items: [] }), { status: 200 }),
			new Response(JSON.stringify({ version: 8, reset: false, items: [{ id: "a", kind: "assistant", label: "Assistant", text: "new reply" }] }), { status: 200 }),
		];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(input), token: new Headers(init?.headers).get("x-annotate-token") });
			return replies.shift()!;
		}) as typeof fetch;
		const client = createClient({ sessionId: "old-session", port: 4747, token: "old-token" }, fetchImpl);
		const signal = new AbortController().signal;
		assert.deepEqual(await client.watch(1, signal), { type: "moved", snapshot: { version: 7, nextSeq: 12, items: [] } });
		assert.deepEqual(await client.watch(7, signal), { type: "update", version: 8, reset: false, items: [{ id: "a", kind: "assistant", label: "Assistant", text: "new reply" }] });
		assert.equal(client.sessionId, "new-session");
		assert.deepEqual(requests, [
			{ url: "http://127.0.0.1:4747/old-session/api/events?after=1", token: "old-token" },
			{ url: "http://127.0.0.1:4747/new-session/api/snapshot", token: "new-token" },
			{ url: "http://127.0.0.1:4747/new-session/api/events?after=7", token: "new-token" },
		]);
	});

	it("follows chained successors to the head snapshot", async () => {
		const requests: { url: string; token: string | null }[] = [];
		const replies = [
			new Response(JSON.stringify({ error: "SESSION_SWITCHED", successor: { sessionId: "new-session", token: "new-token" } }), { status: 410 }),
			new Response(JSON.stringify({ successor: { sessionId: "head-session", token: "head-token" } }), { status: 410 }),
			new Response(JSON.stringify({ version: 3, nextSeq: 4, items: [{ id: "head", kind: "user", label: "You", text: "head conversation" }] }), { status: 200 }),
		];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(input), token: new Headers(init?.headers).get("x-annotate-token") });
			return replies.shift()!;
		}) as typeof fetch;
		const client = createClient({ sessionId: "old-session", port: 4747, token: "old-token" }, fetchImpl);
		assert.deepEqual(await client.snapshot(), { version: 3, nextSeq: 4, items: [{ id: "head", kind: "user", label: "You", text: "head conversation" }] });
		assert.equal(client.sessionId, "head-session");
		assert.deepEqual(requests, [
			{ url: "http://127.0.0.1:4747/old-session/api/snapshot", token: "old-token" },
			{ url: "http://127.0.0.1:4747/new-session/api/snapshot", token: "new-token" },
			{ url: "http://127.0.0.1:4747/head-session/api/snapshot", token: "head-token" },
		]);
	});

	it("accepts a delayed 200 send after a poll moved and yields only one moved event", async () => {
		let finishSend!: (response: Response) => void;
		const requests: string[] = [];
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = String(input);
			requests.push(url);
			if (url.endsWith("/send")) return new Promise<Response>((resolve) => { finishSend = resolve; });
			if (url.includes("/old-session/")) return new Response(JSON.stringify({ successor: { sessionId: "new-session", token: "new-token" } }), { status: 410 });
			if (url.endsWith("/snapshot")) return new Response(JSON.stringify({ version: 7, nextSeq: 1, items: [] }));
			return new Response(JSON.stringify({ version: 8, reset: false, items: [{ id: "reply", kind: "assistant", label: "Assistant", text: "new reply" }] }));
		}) as typeof fetch;
		const client = createClient({ sessionId: "old-session", port: 4747, token: "old-token" }, fetchImpl);
		const pending = client.send(3, [{ quote: "q", note: "n" }], "editor");
		const signal = new AbortController().signal;
		assert.deepEqual(await client.watch(1, signal), { type: "moved", snapshot: { version: 7, nextSeq: 1, items: [] } });
		finishSend(new Response(JSON.stringify({ inserted: 1, nextSeq: 4 })));
		assert.deepEqual(await pending, { ok: true, inserted: 1, nextSeq: 4 });
		assert.deepEqual(await client.watch(7, signal), { type: "update", version: 8, reset: false, items: [{ id: "reply", kind: "assistant", label: "Assistant", text: "new reply" }] });
		assert.deepEqual(requests, [
			"http://127.0.0.1:4747/old-session/api/send",
			"http://127.0.0.1:4747/old-session/api/events?after=1",
			"http://127.0.0.1:4747/new-session/api/snapshot",
			"http://127.0.0.1:4747/new-session/api/events?after=7",
		]);
	});

	it("returns the successor snapshot when a send receives a successor", async () => {
		const requests: { url: string; token: string | null }[] = [];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ url: String(input), token: new Headers(init?.headers).get("x-annotate-token") });
			if (String(input).endsWith("/snapshot")) return new Response(JSON.stringify({ version: 7, nextSeq: 12, items: [{ id: "new", kind: "user", label: "You", text: "new conversation" }] }));
			return new Response(JSON.stringify({ error: "SESSION_SWITCHED", successor: { sessionId: "new-session", token: "new-token" } }), { status: 410 });
		}) as typeof fetch;
		const client = createClient({ sessionId: "old-session", port: 4747, token: "old-token" }, fetchImpl);
		assert.deepEqual(await client.send(3, [{ quote: "q", note: "n" }], "editor"), {
			ok: false, kind: "moved", snapshot: { version: 7, nextSeq: 12, items: [{ id: "new", kind: "user", label: "You", text: "new conversation" }] },
		});
		assert.equal(client.sessionId, "new-session");
		assert.deepEqual(requests, [
			{ url: "http://127.0.0.1:4747/old-session/api/send", token: "old-token" },
			{ url: "http://127.0.0.1:4747/new-session/api/snapshot", token: "new-token" },
		]);
	});

	it("reports 400, 413 and 500 as rejections with the server's text", async () => {
		assert.deepEqual(await send(reply(413, { error: "body too large" })), { ok: false, kind: "rejected", reason: "body too large" });
		assert.deepEqual(await send(reply(400, { error: "invalid JSON" })), { ok: false, kind: "rejected", reason: "invalid JSON" });
		assert.deepEqual(await send(reply(500, {})), { ok: false, kind: "rejected", reason: "HTTP 500" });
	});

	it("ends the connection on 410, 403 and network failure", async () => {
		await assert.rejects(send(reply(410, { error: "switched" })), { code: "switched" });
		await assert.rejects(send(reply(403, { error: "bad token" })), { code: "unauthorized" });
		await assert.rejects(
			send((async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch),
			{ code: "unreachable" },
		);
	});

	it("inserts a new line on Ctrl-J in the note editor and saves only on Enter", () => {
		const t = setup(items);
		t.keys("A", "one", "\n", "two");
		assert.match(t.screen().at(-1)!, /^ NOTE /);
		assert.match(t.screen()[0]!, /0 notes/);
		assert.ok(t.screen().some((line) => line.includes("one")));
		assert.ok(t.screen().some((line) => line.includes("two")));
		t.keys(ENTER);
		assert.match(t.screen()[0]!, /1 note /);
		assert.match(t.screen().at(-1)!, /^ NORMAL /);
	});

	it("routes Escape in note and search mode through the key table and Ctrl-C to quit", () => {
		const t = setup(items);
		t.keys("A", "draft", ESC);
		assert.match(t.screen().at(-1)!, /^ NORMAL /);
		t.keys("/", "ca", ESC);
		assert.match(t.screen().at(-1)!, /^ NORMAL /);
		t.keys("A", "draft", "\x03");
		assert.equal(t.exited(), true);
	});
});
