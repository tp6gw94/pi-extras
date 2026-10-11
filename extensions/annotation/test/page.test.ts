import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../page.html", import.meta.url), "utf8");
const script = /<script nonce="__NONCE__">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
	tag: string;
	className = "";
	hidden = false;
	value = "";
	rows = 0;
	type = "";
	disabled = false;
	offsetWidth = 300;
	offsetHeight = 120;
	style: Record<string, string> = {};
	attributes: Record<string, string> = {};
	children: FakeElement[] = [];
	listeners: Record<string, Listener[]> = {};
	ownText = "";
	removed = false;
	constructor(tag: string) {
		this.tag = tag;
	}
	set textContent(text: string) {
		this.children = [];
		this.ownText = String(text);
	}
	get textContent(): string {
		return this.ownText + this.children.map((child) => child.textContent).join("");
	}
	set innerHTML(_value: string) {
		throw new Error("innerHTML must not be used");
	}
	set outerHTML(_value: string) {
		throw new Error("outerHTML must not be used");
	}
	insertAdjacentHTML(): void {
		throw new Error("insertAdjacentHTML must not be used");
	}
	append(...nodes: FakeElement[]): void {
		this.children = this.children.filter((child) => !child.removed);
		this.children.push(...nodes);
	}
	replaceChildren(...nodes: FakeElement[]): void {
		this.ownText = "";
		this.children = [...nodes];
	}
	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
	}
	addEventListener(type: string, listener: Listener): void {
		(this.listeners[type] ??= []).push(listener);
	}
	dispatch(type: string, event: Record<string, unknown> = {}): void {
		for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {}, ...event });
	}
	contains(): boolean {
		return true;
	}
	querySelector(selector: string): FakeElement | undefined {
		const className = selector.replace(/^\./, "");
		return this.all().slice(1).find((element) => element.className.split(" ").includes(className));
	}
	remove(): void {
		this.removed = true;
	}
	focus(): void {}
	all(): FakeElement[] {
		return [this, ...this.children.flatMap((child) => child.all())];
	}
}

type Reply = { status: number; body: unknown };

function loadPage(snapshot: unknown, options: { send?: Reply[]; globals?: Record<string, unknown> } = {}) {
	const ids = ["conversation", "list", "send", "status", "composer", "composer-quote", "note", "count", "empty"];
	const byId = new Map(ids.map((id) => [id, new FakeElement(id === "note" ? "textarea" : "div")]));
	const created: FakeElement[] = [];
	const requests: { path: string; init: Record<string, unknown> }[] = [];
	const sendReplies = [...(options.send ?? [])];
	const eventWaiters: ((reply: Reply) => void)[] = [];
	const eventQueue: Reply[] = [];
	let selectionText = "";
	const timers: (() => void)[] = [];
	const location = { pathname: "/sid-1", hash: "#t=tok123", search: "" };
	const history = {
		calls: [] as unknown[][],
		replaceState(...args: unknown[]) {
			this.calls.push(args);
			location.hash = "";
		},
	};
	const document = {
		documentElement: { scrollHeight: 2000 },
		getElementById: (id: string) => byId.get(id),
		createElement: (tag: string) => {
			const element = new FakeElement(tag);
			created.push(element);
			return element;
		},
		addEventListener: () => {},
		write: () => {
			throw new Error("document.write must not be used");
		},
	};
	const window = {
		innerWidth: 1200,
		innerHeight: 800,
		scrollX: 0,
		scrollY: 0,
		scrollTo: () => {},
		getSelection: () => ({
			isCollapsed: selectionText === "",
			rangeCount: selectionText === "" ? 0 : 1,
			getRangeAt: () => ({ commonAncestorContainer: {}, getBoundingClientRect: () => ({ top: 100, bottom: 120, left: 50, right: 200 }), cloneRange: () => ({ clone: selectionText }) }),
			toString: () => selectionText,
			removeAllRanges: () => {
				selectionText = "";
			},
		}),
	};
	const respond = (reply: Reply) => ({ ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body });
	const fetch = (path: string, init: Record<string, unknown> = {}) => {
		requests.push({ path, init });
		if (path === "/sid-1/api/snapshot") return Promise.resolve(respond({ status: 200, body: snapshot }));
		if (path.startsWith("/sid-1/api/events")) {
			const answer = (reply: Reply) => (reply.status === 0 ? Promise.reject(new TypeError("network")) : Promise.resolve(respond(reply)));
			const queued = eventQueue.shift();
			if (queued) return answer(queued);
			return new Promise((resolve, reject) => eventWaiters.push((reply) => answer(reply).then(resolve, reject)));
		}
		if (path === "/sid-1/api/send") {
			const reply = sendReplies.shift() ?? { status: 200, body: { ok: true, inserted: 1, nextSeq: 2 } };
			if (reply.status === 0) return Promise.reject(new TypeError("network"));
			return Promise.resolve(respond(reply));
		}
		return Promise.resolve(respond({ status: 404, body: {} }));
	};
	const context = vm.createContext({
		document,
		window,
		fetch,
		location,
		history,
		URLSearchParams,
		setTimeout: (fn: () => void) => timers.push(fn),
		JSON,
		Date,
		String,
		Object,
		Math,
		isNaN,
		Promise,
		TypeError,
		...options.globals,
	});
	vm.runInContext(script, context);
	const flush = async () => {
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
			while (timers.length) timers.shift()!();
		}
	};
	const select = (text: string) => {
		selectionText = text;
		byId.get("conversation")!.dispatch("mouseup");
	};
	const pushEvent = async (reply: Reply) => {
		const waiter = eventWaiters.shift();
		if (waiter) waiter(reply);
		else eventQueue.push(reply);
		await flush();
	};
	const annotate = async (text: string, noteText = "") => {
		select(text);
		await flush();
		byId.get("note")!.value = noteText;
		byId.get("note")!.dispatch("keydown", { key: "Enter" });
	};
	const sends = () => requests.filter((entry) => entry.path === "/sid-1/api/send").map((entry) => JSON.parse(String(entry.init.body)));
	const blocks = () => byId.get("conversation")!.children.filter((child) => child.tag === "article").map((child) => child.attributes["data-id"]);
	return { byId, created, requests, flush, select, history, location, pushEvent, annotate, sends, blocks };
}

const item = (id: string, text: string, kind = "assistant") => ({ id, kind, label: kind, text });
const plain = (items: unknown[]) => JSON.parse(JSON.stringify(items));

describe("annotate page script", () => {
	it("never uses HTML-parsing sinks", () => {
		assert.ok(script.length > 1000);
		for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on", "EventSource"]) {
			assert.ok(!html.includes(sink), sink);
		}
	});

	it("renders <img onerror> content as inert text, initially and in live updates", async () => {
		const payload = '<img src=x onerror="window.pwned=1"><b>bold</b>';
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("u1", payload, "user"), { id: "t1", kind: "tool", label: `Tool ${payload}`, text: payload }] });
		await page.flush();
		await page.pushEvent({ status: 200, body: { version: 2, reset: false, items: [item("a1", payload)] } });
		const conversation = page.byId.get("conversation")!;
		const tags = conversation.all().map((element) => element.tag);
		assert.ok(!tags.includes("img") && !tags.includes("b") && !tags.includes("script"));
		assert.equal(conversation.all().filter((element) => element.ownText === payload).length, 3);
		assert.ok(conversation.textContent.includes(`Tool ${payload}`));
		assert.ok(conversation.all().some((element) => element.tag === "details"));
	});

	it("reads the token from the fragment, removes it at once and sends it only in the header", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [] });
		assert.deepEqual(plain(page.history.calls), [[null, "", "/sid-1"]]);
		assert.equal(page.location.hash, "");
		await page.flush();
		assert.equal(page.requests[0]!.path, "/sid-1/api/snapshot");
		assert.deepEqual(plain([page.requests[0]!.init.headers]), [{ "X-Annotate-Token": "tok123" }]);
		assert.equal(page.requests[1]!.path, "/sid-1/api/events?after=1");
		assert.ok(page.requests.every((entry) => !entry.path.includes("tok123")));
	});

	it("appends new items from the long-poll and keeps polling with the new version", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("u1", "q", "user")] });
		await page.flush();
		await page.pushEvent({ status: 200, body: { version: 1, reset: false, items: [] } });
		await page.pushEvent({ status: 200, body: { version: 2, reset: false, items: [item("a1", "answer")] } });
		assert.deepEqual(page.blocks(), ["u1", "a1"]);
		assert.equal(page.requests.at(-1)!.path, "/sid-1/api/events?after=2");
		assert.match(page.byId.get("status")!.textContent, /^Live · 2 messages/);
	});

	it("replaces the conversation on a reset but keeps the annotation list", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("u1", "q", "user"), item("a1", "first answer")] });
		await page.flush();
		await page.annotate("first answer", "keep me");
		await page.pushEvent({ status: 200, body: { version: 3, reset: true, items: [item("u1", "q", "user"), item("a9", "other branch")] } });
		assert.deepEqual(page.blocks(), ["u1", "a9"]);
		assert.equal(page.byId.get("count")!.textContent, "1");
		assert.equal(page.byId.get("list")!.children[0]!.all().find((element) => element.tag === "blockquote")!.textContent, "first answer");
	});

	it("adds a selection with its note on Enter, keeps Shift+Enter, discards on Esc, and sends JSON with seq in list order", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "alpha beta gamma")] });
		await page.flush();
		const note = page.byId.get("note")!;
		const composer = page.byId.get("composer")!;
		page.select("alpha");
		await page.flush();
		assert.equal(composer.hidden, false);
		assert.equal(page.byId.get("composer-quote")!.textContent, "alpha");
		note.value = "first<img src=x onerror=1>";
		let prevented = false;
		note.dispatch("keydown", { key: "Enter", shiftKey: true, preventDefault: () => (prevented = true) });
		assert.equal(prevented, false);
		note.dispatch("keydown", { key: "Enter", shiftKey: false });
		assert.equal(composer.hidden, true);
		page.select("beta");
		await page.flush();
		note.value = "dropped";
		note.dispatch("keydown", { key: "Escape" });
		page.select("gamma");
		await page.flush();
		note.value = "";
		note.dispatch("keydown", { key: "Enter", isComposing: true });
		assert.equal(composer.hidden, false);
		note.dispatch("keydown", { key: "Enter" });
		const list = page.byId.get("list")!;
		assert.equal(list.children.length, 2);
		assert.ok(!list.all().some((element) => element.tag === "img"));
		const edit = list.children[1]!.all().find((element) => element.tag === "textarea")!;
		edit.value = "edited";
		edit.dispatch("input");
		page.byId.get("send")!.dispatch("click");
		await page.flush();
		const request = page.requests.find((entry) => entry.path === "/sid-1/api/send")!;
		assert.equal(request.init.method, "POST");
		assert.deepEqual(plain([request.init.headers]), [{ "X-Annotate-Token": "tok123", "Content-Type": "application/json" }]);
		assert.deepEqual(page.sends(), [{ seq: 1, items: [{ quote: "alpha", note: "first<img src=x onerror=1>" }, { quote: "gamma", note: "edited" }] }]);
	});

	it("clears the list after a successful send, stays open, and uses the next seq for the next round", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "one two")] }, { send: [{ status: 200, body: { ok: true, inserted: 1, seq: 1, nextSeq: 2 } }, { status: 200, body: { ok: true, inserted: 1, seq: 2, nextSeq: 3 } }] });
		await page.flush();
		await page.annotate("one", "first");
		page.byId.get("send")!.dispatch("click");
		await page.flush();
		assert.equal(page.byId.get("count")!.textContent, "0");
		assert.equal(page.byId.get("send")!.disabled, true);
		assert.match(page.byId.get("status")!.textContent, /round 1/);
		await page.annotate("two", "second");
		assert.equal(page.byId.get("send")!.disabled, false);
		page.byId.get("send")!.dispatch("click");
		await page.flush();
		assert.deepEqual(page.sends().map((body) => [body.seq, body.items[0].quote]), [[1, "one"], [2, "two"]]);
		assert.match(page.byId.get("status")!.textContent, /round 2/);
	});

	it("keeps the list and adopts the expected seq on 409", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "x")] }, { send: [{ status: 409, body: { error: "expected seq 4", expectedSeq: 4 } }] });
		await page.flush();
		await page.annotate("x");
		page.byId.get("send")!.dispatch("click");
		await page.flush();
		assert.equal(page.byId.get("count")!.textContent, "1");
		assert.match(page.byId.get("status")!.textContent, /Another tab sent first/);
		page.byId.get("send")!.dispatch("click");
		await page.flush();
		assert.deepEqual(page.sends().map((body) => body.seq), [1, 4]);
	});

	it("deletes list items", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "x y")] });
		await page.flush();
		await page.annotate("x");
		const remove = page.byId.get("list")!.all().find((element) => element.tag === "button")!;
		remove.dispatch("click");
		assert.equal(page.byId.get("count")!.textContent, "0");
		assert.equal(page.byId.get("send")!.disabled, true);
	});

	function highlightApi() {
		const registry = new Map<string, { ranges: unknown[] }>();
		class Highlight {
			ranges: unknown[];
			constructor(...ranges: unknown[]) {
				this.ranges = ranges;
			}
		}
		return { registry, globals: { CSS: { highlights: registry }, Highlight } };
	}

	it("keeps the selection highlighted while the note box is open and clears it on Enter and Esc", async () => {
		const { registry, globals } = highlightApi();
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "alpha beta")] }, { globals });
		await page.flush();
		const note = page.byId.get("note")!;
		page.select("alpha");
		await page.flush();
		assert.deepEqual(plain(registry.get("annotate-pending")!.ranges), [{ clone: "alpha" }]);
		note.dispatch("keydown", { key: "Enter" });
		assert.equal(registry.has("annotate-pending"), false);
		page.select("beta");
		await page.flush();
		assert.equal(registry.has("annotate-pending"), true);
		note.dispatch("keydown", { key: "Escape" });
		assert.equal(registry.has("annotate-pending"), false);
		page.select("beta");
		await page.flush();
		page.select("alpha");
		await page.flush();
		assert.deepEqual(plain(registry.get("annotate-pending")!.ranges), [{ clone: "alpha" }]);
	});

	it("falls back silently when the highlight API is missing or throws", async () => {
		for (const globals of [{}, { CSS: {} }, { CSS: { highlights: { set() { throw new Error("no"); }, delete() { throw new Error("no"); } } }, Highlight: class {} }]) {
			const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "alpha")] }, { globals });
			await page.flush();
			page.select("alpha");
			await page.flush();
			assert.equal(page.byId.get("composer")!.hidden, false);
			page.byId.get("note")!.dispatch("keydown", { key: "Enter" });
			assert.equal(page.byId.get("count")!.textContent, "1");
		}
	});

	it("shows the session-switched message when a send or the long-poll gets 410", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "x")] }, { send: [{ status: 410, body: { error: "Session switched, run /annotate again." } }] });
		await page.flush();
		await page.annotate("x");
		page.byId.get("send")!.dispatch("click");
		await page.flush();
		assert.equal(page.byId.get("status")!.textContent, "Session switched, run /annotate again.");
		assert.equal(page.byId.get("send")!.disabled, true);
		const other = loadPage({ version: 1, nextSeq: 1, items: [] });
		await other.flush();
		await other.pushEvent({ status: 410, body: {} });
		assert.equal(other.byId.get("status")!.textContent, "Session switched, run /annotate again.");
	});

	it("pauses on 429 and says why", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [] });
		await page.flush();
		const before = page.requests.length;
		page.pushEvent({ status: 429, body: {} });
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(page.byId.get("status")!.textContent, /Too many open annotate tabs/);
		await page.flush();
		assert.equal(page.requests.length, before + 1);
	});

	it("keeps the list when the server goes away, retries, and then reports a session switch", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "x")] }, { send: [{ status: 0, body: null }] });
		await page.flush();
		await page.annotate("x");
		page.byId.get("send")!.dispatch("click");
		await page.flush();
		assert.match(page.byId.get("status")!.textContent, /^Disconnected from pi, retrying/);
		assert.equal(page.byId.get("count")!.textContent, "1");
		assert.equal(page.byId.get("send")!.disabled, false);
		const polls = () => page.requests.filter((entry) => entry.path.startsWith("/sid-1/api/events")).length;
		const before = polls();
		await page.pushEvent({ status: 0, body: null });
		assert.match(page.byId.get("status")!.textContent, /^Disconnected from pi, retrying/);
		assert.equal(polls(), before + 1);
		await page.pushEvent({ status: 410, body: {} });
		assert.equal(page.byId.get("status")!.textContent, "Session switched, run /annotate again.");
		assert.equal(page.byId.get("send")!.disabled, true);
	});

	it("recovers after a dropped long-poll and stops on a token the server no longer knows", async () => {
		const page = loadPage({ version: 1, nextSeq: 1, items: [item("a1", "x")] });
		await page.flush();
		await page.pushEvent({ status: 0, body: null });
		assert.match(page.byId.get("status")!.textContent, /^Disconnected/);
		await page.pushEvent({ status: 200, body: { version: 1, reset: false, items: [] } });
		assert.match(page.byId.get("status")!.textContent, /^Live/);
		await page.pushEvent({ status: 403, body: {} });
		assert.match(page.byId.get("status")!.textContent, /token is no longer valid/);
		assert.equal(page.byId.get("send")!.disabled, true);
	});
});
