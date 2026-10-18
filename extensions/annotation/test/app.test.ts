import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as lib from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { render } from "grok-mermaid";
import type { Annotation, AnnotationDelivery } from "../quote.ts";
import type { SnapshotItem } from "../snapshot.ts";
import { AnnotateApp } from "../tui/app.ts";
import { type AnnotateClient, createClient, type LiveUpdate, ProtocolError, type SendOutcome } from "../tui/client.ts";

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
	let watcher: { resolve: (update: LiveUpdate) => void; reject: (error: unknown) => void } | undefined;
	let exited = false;
	const client: AnnotateClient = {
		snapshot: async () => ({ version: 1, nextSeq: 1, items: source }),
		watch: (_after, signal) =>
			new Promise<LiveUpdate>((resolve, reject) => {
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
	const app = new AnnotateApp({ lib, tui, client, snapshot: { version: 1, nextSeq: 1, items: source }, title: "pi-annotation · repo · abc12345", onExit: () => (exited = true) });
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
		push: (update: LiveUpdate) => watcher?.resolve(update),
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
