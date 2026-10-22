import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, type Focusable, type TUI, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { registerAnnotationMode } from "../mode/command.ts";
import { annotationsText } from "../quote.ts";
import { hostHarness, linesComponent, settle } from "./mode-harness.ts";

type Dock = Component & Partial<Focusable> & { dispose?(): void };
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function setup(options: { draft?: string; rows?: number; columns?: number; messages?: Component[]; idle?: boolean; customResolution?: Promise<void> } = {}) {
	const host = hostHarness(options);
	const original = host.chat.render;
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const listeners = new Map<string, () => void>();
	const notices: { text: string; type: string | undefined }[] = [];
	const messages: { text: string; options: unknown }[] = [];
	const timeline: string[] = [];
	let editorText = options.draft ?? "DRAFT";
	let sessionId = "session-a";
	let idle = options.idle ?? true;
	let sendError: Error | undefined;
	let editorError: Error | undefined;
	let customError: Error | undefined;
	let selected = "\x1b[48;5;24m";
	let doneCount = 0;
	let customCount = 0;
	let mounted: Dock | undefined;
	const core: Dock = { render: () => [editorText], invalidate: () => {}, handleInput: (data) => { editorText = data === "\x03" ? "" : editorText + data; } };
	let focus: Dock = core;
	const setFocus = (next: Dock) => {
		if ("focused" in focus) focus.focused = false;
		focus = next;
		if ("focused" in focus) focus.focused = true;
	};
	host.editor.addChild(core);
	const theme = { fg: (_color: string, text: string) => text, getBgAnsi: () => selected } as unknown as Theme;
	const custom: ExtensionUIContext["custom"] = async (factory, customOptions) => {
		assert.equal(customOptions?.overlay, false);
		customCount++;
		const savedText = editorText;
		const result = await new Promise((resolve, reject) => {
			let closed = false;
			let component: Dock | undefined;
			const done = (outcome: unknown) => {
				if (closed) return;
				closed = true;
				doneCount++;
				host.editor.clear();
				host.editor.addChild(core);
				editorText = savedText;
				setFocus(core);
				timeline.push("restore");
				resolve(outcome as never);
				timeline.push("resolve");
				component?.dispose?.();
				timeline.push("dispose");
			};
			Promise.resolve(factory(host.tui as unknown as TUI, theme, {} as never, done)).then((value) => {
				if (closed) return;
				if (customError) throw customError;
				component = value;
				mounted = value;
				host.editor.clear();
				host.editor.addChild(value);
				setFocus(value);
			}).catch(reject);
		});
		if (options.customResolution) await options.customResolution;
		return result as never;
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => idle,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			custom,
			notify: (text: string, type?: string) => notices.push({ text, type }),
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				if (editorError) throw editorError;
				timeline.push("append");
				editorText = text;
			},
		},
	} as unknown as ExtensionCommandContext;
	const pi = {
		registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, spec.handler),
		on: (event: string, listener: () => void) => listeners.set(event, listener),
		sendUserMessage: (text: string, delivery: unknown) => {
			if (sendError) throw sendError;
			timeline.push("submit");
			messages.push({ text, options: delivery });
		},
	} as unknown as ExtensionAPI;
	registerAnnotationMode(pi);
	const shutdown = () => listeners.get("session_shutdown")!();
	cleanups.push(shutdown);
	const run = () => commands.get("annotation-mode")!("", ctx);
	const begin = async () => {
		await run();
		await settle();
		host.draw();
		await settle();
		host.draw();
		return { dock: mounted! };
	};
	const keys = (...inputs: string[]) => {
		for (const data of inputs) {
			focus.handleInput!(data);
			host.draw();
		}
	};
	const type = (text: string) => keys(...text);
	const screen = () => host.editor.render(host.tui.terminal.columns).map(stripTerminalSequences);
	return {
		...host, original, pi, ctx, run, begin, keys, type, screen, notices, messages, timeline, shutdown,
		command: (name: string) => commands.get(name)!("", ctx),
		editorText: () => editorText,
		doneCount: () => doneCount,
		customCount: () => customCount,
		setIdle: (value: boolean) => { idle = value; },
		switchSession: (value: string) => { sessionId = value; },
		failSend: (value?: Error) => { sendError = value; },
		failEditor: (value?: Error) => { editorError = value; },
		failCustom: (value: Error) => { customError = value; },
		setSelectionColor: (value: string) => { selected = value; },
		replaceDock: () => {
			const dialog: Dock = { render: () => ["OTHER DIALOG"], invalidate: () => {}, handleInput: () => {} };
			host.editor.clear();
			host.editor.addChild(dialog);
			setFocus(dialog);
		},
	};
}

function addNote(t: ReturnType<typeof setup>, text = "fix it"): void {
	t.keys("a");
	t.type(text);
	t.keys("\r");
}

describe("annotation-mode entry", () => {
	it("returns while custom remains unresolved and the dock stays active", async () => {
		const t = setup();
		assert.equal(await Promise.race([t.run().then(() => "returned"), settle().then(() => "blocked")]), "returned");
		assert.match(t.screen()[0], /^NORMAL/);
	});

	for (const mode of ["rpc", "json", "print"] as const) {
		it(`refuses ${mode} without opening custom UI`, async () => {
			const t = setup();
			t.ctx.mode = mode;
			t.ctx.hasUI = mode === "rpc";
			await t.run();
			assert.equal(t.customCount(), 0);
			assert.equal(t.chat.render, t.original);
			assert.equal(t.notices.length, mode === "rpc" ? 1 : 0);
			if (mode === "rpc") assert.match(t.notices[0].text, /interactive terminal/);
		});
	}

	for (const failure of ["regular", "missing layout", "empty"] as const) {
		it(`notifies and restores the original draft on ${failure} refusal`, async () => {
			const t = setup();
			if (failure === "regular") t.tui.mode = "regular";
			if (failure === "missing layout") t.tui.children = [];
			if (failure === "empty") t.chat.clear();
			await t.run();
			await settle();
			assert.equal(t.chat.render, t.original);
			assert.equal(t.editorText(), "DRAFT");
			assert.equal(t.notices.length, 1);
			assert.equal(t.notices[0].type, "warning");
			assert.match(t.notices[0].text, failure === "regular" ? /fullscreen/ : failure === "empty" ? /empty/ : /not supported/);
			assert.deepEqual(t.screen(), ["DRAFT"]);
		});
	}
});

describe("annotation-mode delivery", () => {
	for (const key of ["s", "S"]) {
		it(`waits for custom resolution before ${key} delivery even after the handler returns`, async () => {
			const resolution = deferred();
			const t = setup({ customResolution: resolution.promise });
			await t.begin();
			addNote(t);
			t.keys(key);
			await settle();
			assert.deepEqual(t.screen(), ["DRAFT"]);
			assert.equal(t.editorText(), "DRAFT");
			assert.deepEqual(t.messages, []);
			resolution.resolve();
			await settle();
			const text = "> alpha 中文 👨‍👩‍👧\n\nfix it\n\n";
			assert.equal(t.editorText(), key === "s" ? "DRAFT\n" + text : "DRAFT");
			assert.deepEqual(t.messages, key === "S" ? [{ text, options: { deliverAs: "followUp" } }] : []);
		});
	}

	it("appends only after custom restores the draft, with exactly quote.ts formatting", async () => {
		const t = setup();
		await t.begin();
		addNote(t);
		t.keys("s");
		assert.equal(t.editorText(), "DRAFT");
		assert.equal(t.chat.render, t.original);
		await settle();
		const text = annotationsText([{ quote: "alpha 中文 👨‍👩‍👧", note: "fix it" }], "DRAFT");
		assert.equal(t.editorText(), "DRAFT" + text);
		assert.equal(t.editorText(), "DRAFT\n> alpha 中文 👨‍👩‍👧\n\nfix it\n\n");
		assert.deepEqual(t.messages, []);
		assert.deepEqual(t.timeline, ["restore", "resolve", "dispose", "append"]);
		assert.match(t.notices.at(-1)!.text, /appended 1/);
		await t.begin();
		assert.match(t.screen()[0], /0 notes/);
		t.keys("q");
		assert.deepEqual(t.screen(), [t.editorText()]);
	});

	it("submits once as followUp after closing and never changes the editor draft", async () => {
		const t = setup();
		const { dock } = await t.begin();
		addNote(t);
		t.keys("\t", "S");
		dock.handleInput!("S");
		assert.deepEqual(t.messages, []);
		await settle();
		assert.deepEqual(t.messages, [{ text: "> alpha 中文 👨‍👩‍👧\n\nfix it\n\n", options: { deliverAs: "followUp" } }]);
		assert.equal(t.editorText(), "DRAFT");
		assert.deepEqual(t.timeline, ["restore", "resolve", "dispose", "submit"]);
		assert.equal(t.chat.render, t.original);
		await t.begin();
		assert.match(t.screen()[0], /0 notes/);
		t.keys("q");
		assert.deepEqual(t.screen(), ["DRAFT"]);
	});

	for (const key of ["s", "S"]) {
		it(`keeps notes after ${key} throws and permits an exact retry`, async () => {
			const t = setup();
			await t.begin();
			addNote(t);
			if (key === "s") t.failEditor(new Error("editor unavailable"));
			else t.failSend(new Error("submission failed"));
			t.keys(key);
			await settle();
			assert.equal(t.editorText(), "DRAFT");
			assert.deepEqual(t.messages, []);
			assert.match(t.notices.at(-1)!.text, /notes kept/);
			assert.equal(t.chat.render, t.original);
			await t.begin();
			assert.match(t.screen()[0], /1 note/);
			t.keys("\t");
			assert.ok(t.screen().some((line) => line.includes("fix it")));
			t.failSend();
			t.failEditor();
			t.keys("S");
			await settle();
			assert.deepEqual(t.messages, [{ text: "> alpha 中文 👨‍👩‍👧\n\nfix it\n\n", options: { deliverAs: "followUp" } }]);
		});
	}
});

describe("annotation-mode lifecycle", () => {
	it("requires q twice with unsent notes, keeps notes and underlines across re-entry, and resets on a new session", async () => {
		const t = setup();
		await t.begin();
		addNote(t);
		t.keys("q");
		assert.equal(t.doneCount(), 0);
		assert.match(t.screen()[0], /press again to quit/);
		await settle();
		assert.match(t.screen()[0], /press again to quit/);
		t.keys("q");
		assert.equal(t.chat.render, t.original);
		await t.begin();
		assert.match(t.screen()[0], /1 note/);
		assert.match(t.content()[2], /\x1b\[4m/);
		t.keys("q", "q");
		t.switchSession("session-b");
		await t.begin();
		assert.match(t.screen()[0], /0 notes/);
		assert.doesNotMatch(t.content()[2], /\x1b\[4m/);
		t.keys("q");
		assert.deepEqual(t.screen(), ["DRAFT"]);
	});

	it("cleans up if the custom factory or mounting fails", async () => {
		const t = setup();
		t.failCustom(new Error("mount failed"));
		await t.run();
		await settle();
		assert.equal(t.chat.render, t.original);
		assert.match(t.notices.at(-1)!.text, /mount failed/);
		const u = setup();
		Object.defineProperty(u.view, "viewportHeight", { get: () => { throw new Error("bind failed"); } });
		await u.run();
		await settle();
		assert.equal(u.chat.render, u.original);
		assert.match(u.notices.at(-1)!.text, /bind failed/);
	});

	it("does not deliver an already-closed run after shutdown or a replacement command abandons it", async () => {
		for (const replacement of ["shutdown", "command"]) {
			const resolution = deferred();
			const t = setup({ customResolution: resolution.promise });
			await t.begin();
			addNote(t);
			t.keys("S");
			if (replacement === "shutdown") t.shutdown();
			else await t.begin();
			resolution.resolve();
			await settle();
			assert.deepEqual(t.messages, []);
			assert.equal(t.editorText(), "DRAFT");
			if (replacement === "shutdown") await t.begin();
			assert.match(t.screen()[0], /1 note/);
			addNote(t, "new note");
			t.keys("S");
			await settle();
			assert.deepEqual(t.messages, [{ text: "> alpha 中文 👨‍👩‍👧\n\nfix it\n\n> alpha 中文 👨‍👩‍👧\n\nnew note\n\n", options: { deliverAs: "followUp" } }]);
			assert.equal(t.chat.render, t.original);
		}
	});

	it("ignores a late custom rejection after shutdown or replacement without disturbing a newer dock", async () => {
		for (const replacement of ["shutdown", "command"]) {
			const resolution = deferred();
			const t = setup({ customResolution: resolution.promise });
			await t.begin();
			addNote(t);
			t.keys("q", "q");
			await settle();
			if (replacement === "shutdown") t.shutdown();
			else await t.begin();
			resolution.reject(new Error("old custom failed"));
			await settle();
			assert.deepEqual(t.notices, []);
			assert.deepEqual(t.messages, []);
			if (replacement === "shutdown") await t.begin();
			assert.match(t.screen()[0], /1 note/);
			t.keys("\t");
			assert.ok(t.screen().some((line) => line.includes("fix it")));
		}
	});

	it("processes another user command and re-entry serially after external eviction", async () => {
		const t = setup();
		const evicted = deferred();
		t.pi.registerCommand("probe", { handler: async (_args, ctx) => { ctx.ui.notify("probe ran", "info"); } });
		const inputs = (async () => {
			await t.command("annotation-mode");
			await evicted.promise;
			await t.command("probe");
			await t.command("annotation-mode");
		})();
		await settle();
		t.draw();
		addNote(t);
		t.replaceDock();
		for (let frame = 0; frame < 4; frame++) t.draw();
		await settle();
		assert.deepEqual(t.screen(), ["OTHER DIALOG"]);
		assert.equal(t.doneCount(), 0);
		evicted.resolve();
		assert.equal(await Promise.race([inputs.then(() => "returned"), settle().then(() => "blocked")]), "returned");
		assert.ok(t.notices.some((notice) => notice.text === "probe ran"));
		assert.match(t.screen()[0], /^NORMAL.*1 note/);
		t.keys("S");
		await settle();
		assert.deepEqual(t.messages, [{ text: "> alpha 中文 👨‍👩‍👧\n\nfix it\n\n", options: { deliverAs: "followUp" } }]);
		assert.equal(t.doneCount(), 1);
		assert.deepEqual(t.screen(), ["DRAFT"]);
	});

	it("abandons an evicted dock without calling stale done or removing the replacement dialog", async () => {
		const t = setup();
		const first = await t.begin();
		addNote(t);
		t.replaceDock();
		for (let frame = 0; frame < 4; frame++) t.draw();
		await settle();
		assert.equal(t.chat.render, t.original);
		assert.equal(t.doneCount(), 0);
		assert.deepEqual(t.screen(), ["OTHER DIALOG"]);
		first.dock.handleInput!("q");
		first.dock.dispose!();
		assert.equal(t.doneCount(), 0);
		await t.begin();
		assert.match(t.screen()[0], /1 note/);
		t.keys("q", "q");
		assert.deepEqual(t.screen(), ["DRAFT"]);
	});

	it("does not let a queued empty-transcript update close a dialog that evicted the dock", async () => {
		const t = setup();
		await t.begin();
		t.replaceDock();
		t.chat.clear();
		for (let frame = 0; frame < 4; frame++) t.draw();
		await settle();
		assert.equal(t.doneCount(), 0);
		assert.equal(t.chat.render, t.original);
		assert.deepEqual(t.screen(), ["OTHER DIALOG"]);
	});

	it("shutdown and a new command abandon old runs without stale completion", async () => {
		const t = setup();
		const first = await t.begin();
		addNote(t);
		t.shutdown();
		t.shutdown();
		assert.equal(t.chat.render, t.original);
		first.dock.handleInput!("q");
		assert.equal(t.doneCount(), 0);
		const second = await t.begin();
		await t.begin();
		second.dock.handleInput!("q");
		assert.equal(t.doneCount(), 0);
		assert.match(t.screen()[0], /1 note/);
		t.keys("q", "q");
		assert.equal(t.chat.render, t.original);
	});

	for (const exit of ["render", "input"] as const) {
		it(`leaves fullscreen through ${exit} without leaking decorations or losing notes`, async () => {
			const t = setup();
			const first = await t.begin();
			addNote(t);
			t.tui.mode = "regular";
			if (exit === "render") {
				assert.doesNotMatch(t.content().join("\n"), /\x1b\[(?:7|4)m/);
				assert.equal(t.doneCount(), 0);
			} else first.dock.handleInput!("j");
			await settle();
			assert.equal(t.chat.render, t.original);
			assert.equal(t.editorText(), "DRAFT");
			assert.match(t.notices.at(-1)!.text, /left fullscreen/);
			t.tui.mode = "fullscreen";
			await t.begin();
			assert.match(t.screen()[0], /1 note/);
			t.keys("q", "q");
			assert.deepEqual(t.screen(), ["DRAFT"]);
		});
	}

	it("exits and restores the editor when the transcript becomes empty", async () => {
		const t = setup();
		await t.begin();
		t.chat.clear();
		t.draw();
		await settle();
		assert.equal(t.chat.render, t.original);
		assert.equal(t.editorText(), "DRAFT");
		assert.match(t.notices.at(-1)!.text, /empty/);
	});
});

describe("annotation dock", () => {
	it("keeps mode letters, paste and unknown sequences away from the main editor", async () => {
		const t = setup();
		await t.begin();
		t.keys("j", "k", "v", "l", "o", "\x1b", "g", "g", "G", "\x1b[200~sSqq\x1b[201~", "\x1b[999~");
		assert.equal(t.editorText(), "DRAFT");
		assert.equal(t.doneCount(), 0);
		t.keys("q");
		t.keys("x");
		assert.equal(t.editorText(), "DRAFTx");
		t.keys("\x03");
		assert.equal(t.editorText(), "");
	});

	it("forwards note input, CJK, multiline paste and command letters to the real Editor with IME focus", async () => {
		const t = setup();
		const { dock } = await t.begin();
		t.keys("a", "\x1b[200~中文 qsv\nsecond line\x1b[201~");
		assert.ok(dock.render(120).some((line) => line.includes(CURSOR_MARKER)));
		dock.focused = false;
		assert.ok(dock.render(120).every((line) => !line.includes(CURSOR_MARKER)));
		dock.focused = true;
		t.keys("\r", "S");
		await settle();
		assert.equal(t.messages[0].text, "> alpha 中文 👨‍👩‍👧\n\n中文 qsv\nsecond line\n\n");
		assert.equal(t.editorText(), "DRAFT");
	});

	it("cancels only the draft with Ctrl-C and quits from every other mode with confirmation", async () => {
		for (const enter of [[], ["v"], ["\t"], ["?"]] as string[][]) {
			const t = setup();
			await t.begin();
			addNote(t, "saved");
			t.keys("a");
			t.type("discard");
			t.keys("\x03");
			assert.match(t.screen()[0], /NORMAL.*1 note/);
			t.keys(...enter, "\x03");
			assert.equal(t.doneCount(), 0);
			assert.match(t.screen()[0], /press again to quit/);
			t.keys("\x03");
			assert.equal(t.chat.render, t.original);
		}
	});

	it("shows pending input, cell coordinates, note count, busy state and hints", async () => {
		const t = setup({ idle: false, columns: 180 });
		await t.begin();
		assert.match(t.screen()[0], /^NORMAL · 1:1 · 0 notes · working  v select/);
		t.keys("6", "l", "l");
		assert.match(t.screen()[0], /1:9/);
		t.keys("2", "g");
		assert.match(t.screen()[0], /^NORMAL 2g/);
		t.setIdle(true);
		assert.doesNotMatch(t.screen()[0], /working/);
	});

	it("uses the current selected background after theme invalidation", async () => {
		const t = setup();
		const { dock } = await t.begin();
		t.keys("v", "l");
		assert.match(t.content()[2], /\x1b\[48;5;24m/);
		t.setSelectionColor("\x1b[48;5;88m");
		dock.invalidate();
		assert.match(t.content()[2], /\x1b\[48;5;88m/);
		assert.doesNotMatch(t.content()[2], /\x1b\[48;5;24m/);
	});

	it("scrolls lists and help inside one third of the terminal", async () => {
		const t = setup({ rows: 15, columns: 80 });
		const { dock } = await t.begin();
		for (let i = 1; i <= 9; i++) addNote(t, `note-${i}`);
		t.keys("\t", ..."jjjjjjjj");
		assert.ok(t.screen().some((line) => line.includes("> 9.") && line.includes("note-9")));
		assert.ok(!t.screen().some((line) => line.includes("note-1")));
		t.keys("e");
		t.type("!");
		t.keys("\r");
		assert.ok(t.screen().some((line) => line.includes("note-9!")));
		t.keys("d");
		assert.ok(!t.screen().some((line) => line.includes("note-9")));
		t.keys("?");
		const first = t.screen();
		t.keys(..."jjjjj");
		assert.notDeepEqual(t.screen(), first);
		assert.ok(t.screen().some((line) => line.includes("transcript start")));
		for (const rows of [2, 3, 6, 12, 24]) {
			t.tui.terminal.rows = rows;
			for (const width of [1, 20, 80]) {
				const rendered = dock.render(width);
				assert.ok(rendered.length <= Math.floor(rows / 3));
				assert.ok(rendered.every((line) => visibleWidth(line) <= width));
			}
		}
	});

	it("reveals the caret again after the note panel changes the viewport height", async () => {
		const t = setup({ rows: 18, messages: [linesComponent(Array.from({ length: 40 }, (_, index) => `line ${index}`))] });
		await t.begin();
		t.keys("G");
		assert.equal(t.view.scrollTop, 27);
		t.keys("a");
		assert.equal(t.view.viewportHeight, 13);
		await settle();
		t.draw();
		assert.equal(t.view.scrollTop, 29);
		assert.ok(t.draw().lines.some((line) => stripTerminalSequences(line).includes("line 39")));
		assert.ok(t.requests.every((request) => !request.duringRender));
	});

	it("keeps the note cursor visible when its multiline editor exceeds the dock cap", async () => {
		const t = setup({ rows: 12 });
		const { dock } = await t.begin();
		t.keys("a", "\x1b[200~one\ntwo\nthree\nfour\nfive\nsix\x1b[201~");
		const lines = dock.render(120);
		assert.ok(lines.length <= 4);
		assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
	});

	it("keeps the caret through streaming and clears rebuilt selections without losing notes", async () => {
		const rows = ["alpha", "beta"];
		const t = setup({ messages: [linesComponent(rows)] });
		await t.begin();
		addNote(t, "saved");
		t.keys("j", "v", "l");
		rows.push("streamed");
		t.draw();
		await settle();
		assert.match(t.screen()[0], /^VISUAL · 2:2/);
		assert.match(t.content()[3], /\x1b\[7m/);
		t.chat.clear();
		t.chat.addChild(linesComponent(["new conversation"]));
		t.draw();
		await settle();
		assert.match(t.screen()[0], /^NORMAL.*1 note.*selection cleared/);
		t.keys("\t");
		assert.ok(t.screen().some((line) => line.includes("alpha") && line.includes("saved")));
	});

	it("clamps a reflowed visual caret before painting and settles without losing count or quit warnings", async () => {
		const rows = ["alpha beta", "gamma delta"];
		const t = setup({ messages: [linesComponent(rows)] });
		await t.begin();
		t.keys("G", "$", "v");
		rows.splice(0, 2, "x");
		assert.doesNotThrow(() => t.draw());
		await settle();
		assert.match(t.screen()[0], /^VISUAL · 1:1/);
		t.keys("\x1b", "2", "g");
		t.tui.terminal.rows = 12;
		t.draw();
		await settle();
		assert.match(t.screen()[0], /^NORMAL 2g/);
	});
});
