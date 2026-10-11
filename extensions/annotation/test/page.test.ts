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
	focus(): void {}
	all(): FakeElement[] {
		return [this, ...this.children.flatMap((child) => child.all())];
	}
}

function loadPage(snapshot: unknown, sendStatus = 200, globals: Record<string, unknown> = {}) {
	const ids = ["conversation", "list", "send", "status", "composer", "composer-quote", "note", "count", "empty"];
	const byId = new Map(ids.map((id) => [id, new FakeElement(id === "note" ? "textarea" : "div")]));
	const main = new FakeElement("main");
	const created: FakeElement[] = [];
	const requests: { path: string; init: Record<string, unknown> }[] = [];
	let selectionText = "";
	const timers: (() => void)[] = [];
	const location = { pathname: "/", search: "?token=tok123" };
	const history = {
		calls: [] as unknown[][],
		replaceState(...args: unknown[]) {
			this.calls.push(args);
			location.search = "";
		},
	};
	const document = {
		getElementById: (id: string) => byId.get(id),
		createElement: (tag: string) => {
			const element = new FakeElement(tag);
			created.push(element);
			return element;
		},
		querySelector: (selector: string) => (selector === "main" ? main : undefined),
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
	const fetch = async (path: string, init: Record<string, unknown> = {}) => {
		requests.push({ path, init });
		if (path === "/api/snapshot") return { ok: true, status: 200, json: async () => snapshot };
		return { ok: sendStatus === 200, status: sendStatus, json: async () => (sendStatus === 200 ? { ok: true, inserted: 1 } : { error: "nope" }) };
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
		...globals,
	});
	vm.runInContext(script, context);
	const flush = async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
		while (timers.length) timers.shift()!();
	};
	const select = (text: string) => {
		selectionText = text;
		byId.get("conversation")!.dispatch("mouseup");
	};
	return { byId, main, created, requests, flush, select, history, location };
}

describe("annotate page script", () => {
	it("never uses HTML-parsing sinks", () => {
		assert.ok(script.length > 1000);
		for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on"]) {
			assert.ok(!html.includes(sink), sink);
		}
	});

	it("renders <img onerror> content as inert text", async () => {
		const payload = '<img src=x onerror="window.pwned=1"><b>bold</b>';
		const page = loadPage({
			takenAt: "2026-10-11T08:00:00.000Z",
			items: [
				{ id: "u1", kind: "user", label: "You", text: payload },
				{ id: "t1", kind: "tool", label: `Tool ${payload}`, text: payload },
			],
		});
		await page.flush();
		const conversation = page.byId.get("conversation")!;
		const tags = conversation.all().map((element) => element.tag);
		assert.ok(!tags.includes("img") && !tags.includes("b") && !tags.includes("script"));
		const texts = conversation.all().filter((element) => element.ownText === payload);
		assert.equal(texts.length, 2);
		assert.ok(conversation.textContent.includes(`Tool ${payload}`));
		assert.ok(conversation.all().some((element) => element.tag === "details"));
	});

	it("sends the token in the X-Annotate-Token header, not the URL", async () => {
		const page = loadPage({ takenAt: "", items: [] });
		await page.flush();
		assert.equal(page.requests[0]!.path, "/api/snapshot");
		assert.deepEqual(JSON.parse(JSON.stringify(page.requests[0]!.init.headers)), { "X-Annotate-Token": "tok123" });
	});

	it("removes the token from the address bar right after reading it", async () => {
		const page = loadPage({ takenAt: "", items: [] });
		assert.deepEqual(JSON.parse(JSON.stringify(page.history.calls)), [[null, "", "/"]]);
		assert.equal(page.location.search, "");
		await page.flush();
		assert.deepEqual(JSON.parse(JSON.stringify(page.requests[0]!.init.headers)), { "X-Annotate-Token": "tok123" });
	});

	it("adds a selection with its note on Enter, keeps Shift+Enter, discards on Esc, and sends JSON in list order", async () => {
		const page = loadPage({ takenAt: "", items: [{ id: "a1", kind: "assistant", label: "Assistant", text: "alpha beta gamma" }] });
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
		assert.equal(page.byId.get("count")!.textContent, "2");
		const list = page.byId.get("list")!;
		assert.equal(list.children.length, 2);
		assert.ok(!list.all().some((element) => element.tag === "img"));
		const edit = list.children[1]!.all().find((element) => element.tag === "textarea")!;
		edit.value = "edited";
		edit.dispatch("input");
		const send = page.byId.get("send")!;
		assert.equal(send.disabled, false);
		send.dispatch("click");
		await page.flush();
		const request = page.requests.find((entry) => entry.path === "/api/send")!;
		assert.equal(request.init.method, "POST");
		assert.deepEqual(JSON.parse(JSON.stringify(request.init.headers)), { "X-Annotate-Token": "tok123", "Content-Type": "application/json" });
		assert.deepEqual(JSON.parse(String(request.init.body)), {
			items: [
				{ quote: "alpha", note: "first<img src=x onerror=1>" },
				{ quote: "gamma", note: "edited" },
			],
		});
		assert.match(page.main.textContent, /Done/);
		assert.match(page.main.textContent, /Nothing was sent to the model/);
	});

	it("deletes list items", async () => {
		const page = loadPage({ takenAt: "", items: [{ id: "a1", kind: "assistant", label: "Assistant", text: "x y" }] });
		await page.flush();
		page.select("x");
		await page.flush();
		page.byId.get("note")!.dispatch("keydown", { key: "Enter" });
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
		const page = loadPage({ takenAt: "", items: [{ id: "a1", kind: "assistant", label: "Assistant", text: "alpha beta" }] }, 200, globals);
		await page.flush();
		const note = page.byId.get("note")!;
		page.select("alpha");
		await page.flush();
		assert.deepEqual(JSON.parse(JSON.stringify(registry.get("annotate-pending")?.ranges)), [{ clone: "alpha" }]);
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
		assert.deepEqual(JSON.parse(JSON.stringify(registry.get("annotate-pending")?.ranges)), [{ clone: "alpha" }]);
	});

	it("falls back silently when the highlight API is missing or throws", async () => {
		for (const globals of [{}, { CSS: {} }, { CSS: { highlights: { set() { throw new Error("no"); }, delete() { throw new Error("no"); } } }, Highlight: class {} }]) {
			const page = loadPage({ takenAt: "", items: [{ id: "a1", kind: "assistant", label: "Assistant", text: "alpha" }] }, 200, globals);
			await page.flush();
			page.select("alpha");
			await page.flush();
			assert.equal(page.byId.get("composer")!.hidden, false);
			page.byId.get("note")!.dispatch("keydown", { key: "Enter" });
			assert.equal(page.byId.get("count")!.textContent, "1");
		}
	});

	it("shows the session-switched message on 409", async () => {
		const page = loadPage({ takenAt: "", items: [{ id: "a1", kind: "assistant", label: "Assistant", text: "x" }] }, 409);
		await page.flush();
		page.select("x");
		await page.flush();
		page.byId.get("note")!.dispatch("keydown", { key: "Enter" });
		page.byId.get("send")!.dispatch("click");
		await page.flush();
		assert.equal(page.byId.get("status")!.textContent, "Session switched, run /annotate again.");
		assert.equal(page.byId.get("send")!.disabled, true);
	});
});
