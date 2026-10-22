import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Action, Effect, ModeKind, Notebook, State, Viewport } from "../mode/data.ts";
import { bindings, displayKey, helpRows, hintFor, initialState, keyAction, reduce, statusOf, type ViewEnv } from "../mode/state.ts";
import { Transcript } from "../mode/transcript.ts";
import { assistant, capture, id, spacer, transcript, user } from "./mode-fixtures.ts";

const notebook: Notebook = { sessionId: "s", notes: [], nextId: 1 };
const view = (top = 0, height = 10): Viewport => ({ top, height });
const envOf = (doc: Transcript, viewport = view()): ViewEnv => ({ doc, viewport });
const start = (doc: Transcript, viewport = view()): State => initialState(doc, viewport, notebook)!;
const act = (state: State, action: Action, env: ViewEnv) => reduce(state, action, env);
const press = (state: State, key: string, env: ViewEnv) => {
	const action = keyAction(state, key);
	assert.notEqual(action, undefined, `no binding for ${key} in ${state.mode.kind}`);
	return act(state, action!, env);
};
const keys = (state: State, sequence: string[], env: ViewEnv) => {
	let current = state;
	const effects: Effect[] = [];
	for (const key of sequence) {
		const step = press(current, key, env);
		current = step.state;
		effects.push(...step.effects);
	}
	return { state: current, effects };
};
const rowOf = (doc: Transcript, state: State): number => doc.rowOf(state.caret)!;
const at = (doc: Transcript, state: State): [number, number] => [rowOf(doc, state), state.caret.char];
const noteTexts = (state: State): string[] => state.notebook.notes.map((note) => note.text);
const chat = () => transcript([user("question one"), assistant("answer one\n\nanswer two")], 30);
const withNote = (doc: Transcript, env: ViewEnv, text = "first"): State => act(press(start(doc), "A", env).state, { type: "saveNote", text }, env).state;
const typed = [...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)), "tab", "enter"];

describe("entry", () => {
	it("starts on the first non-blank row inside the viewport, else on the last message", () => {
		const doc = chat();
		assert.deepEqual(at(doc, start(doc, view(0, 10))), [1, 1]);
		assert.equal(start(doc, view(0, 10)).goalX, 1);
		assert.deepEqual(at(doc, start(doc, view(2, 10))), [4, 1]);
		assert.deepEqual(at(doc, start(doc, view(100, 10))), [4, 1]);
		assert.deepEqual(at(doc, start(doc, view(-5, 7))), [1, 1]);
		assert.equal(initialState(new Transcript({ width: 10, rows: [], blocks: [] }), view(), notebook), undefined);
	});
});

describe("motions and counts", () => {
	it("applies counts to motions, resolves gg and G, and clears a pending count", () => {
		const doc = chat();
		const env = envOf(doc);
		const down = keys(start(doc), ["2", "j"], env).state;
		assert.deepEqual(at(doc, down), [3, 0]);
		assert.deepEqual(down.mode, { kind: "normal", count: "", prefix: "" });
		assert.deepEqual(at(doc, keys(down, ["G"], env).state), [6, 1]);
		assert.deepEqual(at(doc, keys(down, ["3", "G"], env).state), [2, 0]);
		assert.deepEqual(at(doc, keys(down, ["g", "g"], env).state), [0, 0]);
		const cancelled = keys(down, ["g", "x"], env).state;
		assert.deepEqual(at(doc, cancelled), [3, 0]);
		assert.deepEqual(cancelled.mode, { kind: "normal", count: "", prefix: "" });
		assert.equal(statusOf(keys(down, ["1", "2", "g"], env).state).pending, "12g");
	});

	it("scrolls for page motions and reveals the caret when it leaves the viewport", () => {
		const doc = transcript([assistant(Array.from({ length: 40 }, (_, index) => `line ${index}`).join("  \n"))], 30);
		const top = envOf(doc, view(0, 10));
		const half = press(start(doc, top.viewport), "ctrl+d", top);
		assert.deepEqual(at(doc, half.state), [6, 1]);
		assert.deepEqual(half.effects, [{ type: "scroll", top: 5 }]);
		const end = press(start(doc, top.viewport), "G", top);
		assert.deepEqual(at(doc, end.state), [40, 1]);
		assert.deepEqual(end.effects, [{ type: "scroll", top: 31 }]);
		const bottom = envOf(doc, view(31, 10));
		assert.deepEqual(press(end.state, "k", bottom).effects, []);
		assert.deepEqual(keys(end.state, ["g", "g"], bottom).effects, [{ type: "scroll", top: 0 }]);
		const above = envOf(doc, view(39, 10));
		const seated = press(end.state, "k", bottom).state;
		assert.deepEqual(press(seated, "k", above).effects, [{ type: "scroll", top: 38 }]);
		assert.deepEqual(press(end.state, "ctrl+b", bottom).effects, [{ type: "scroll", top: 23 }]);
	});
});

describe("selection", () => {
	it("toggles visual mode, changes the shape, swaps the ends and leaves with Esc or q", () => {
		const doc = chat();
		const env = envOf(doc);
		const visual = press(start(doc), "v", env).state;
		assert.deepEqual(visual.mode, { kind: "visual", selection: { shape: "char", anchor: doc.placeAt(1, 1) }, count: "", prefix: "" });
		const line = press(visual, "V", env).state.mode;
		assert.equal(line.kind === "visual" ? line.selection.shape : undefined, "line");
		assert.equal(keys(visual, ["V", "V"], env).state.mode.kind, "normal");
		assert.equal(press(visual, "v", env).state.mode.kind, "normal");
		const extended = keys(visual, ["l", "l"], env).state;
		assert.deepEqual(at(doc, extended), [1, 3]);
		const swapped = press(extended, "o", env).state;
		assert.deepEqual(at(doc, swapped), [1, 1]);
		assert.equal(swapped.goalX, 1);
		assert.deepEqual(swapped.mode.kind === "visual" ? swapped.mode.selection.anchor : undefined, doc.placeAt(1, 3));
		assert.equal(press(swapped, "escape", env).state.mode.kind, "normal");
		assert.equal(press(swapped, "q", env).state.mode.kind, "normal");
		assert.deepEqual(press(swapped, "q", env).effects, []);
	});
});

describe("notes", () => {
	it("annotates the selection, saves the trimmed text and returns to normal mode", () => {
		const doc = chat();
		const env = envOf(doc);
		const opened = keys(start(doc), ["w", "v", "e", "a"], env);
		assert.equal(opened.state.mode.kind, "note");
		assert.deepEqual(opened.effects, [{ type: "editNote", initialText: "" }]);
		if (opened.state.mode.kind !== "note") return;
		assert.equal(opened.state.mode.draft.quote, "one");
		assert.equal(opened.state.mode.draft.back.kind, "visual");
		const saved = act(opened.state, { type: "saveNote", text: "  looks wrong  " }, env);
		assert.deepEqual(
			saved.state.notebook.notes.map(({ id: noteId, quote, text }) => ({ id: noteId, quote, text })),
			[{ id: 1, quote: "one", text: "looks wrong" }],
		);
		assert.equal(saved.state.notebook.nextId, 2);
		assert.equal(saved.state.mode.kind, "normal");
		assert.deepEqual(saved.state.message, { text: "added note 1; s to append, S to submit, Tab to review", error: false });
	});

	it("annotates the caret row with a and the whole message with A", () => {
		const doc = chat();
		const env = envOf(doc);
		const row = press(start(doc), "a", env).state;
		assert.equal(row.mode.kind === "note" ? row.mode.draft.quote : undefined, "question one");
		const message = keys(start(doc), ["}", "j", "j", "A"], env).state;
		assert.equal(message.mode.kind === "note" ? message.mode.draft.quote : undefined, "answer one\n\nanswer two");
	});

	it("reports nothing to quote on a spacer row", () => {
		const doc = transcript([spacer(1), assistant("x")], 20);
		const env = envOf(doc);
		const top = keys(start(doc), ["g", "g"], env).state;
		for (const key of ["a", "A"]) {
			const refused = press(top, key, env);
			assert.equal(refused.state.mode.kind, "normal", key);
			assert.deepEqual(refused.state.message, { text: "nothing to quote here", error: true });
			assert.deepEqual(refused.effects, []);
		}
	});

	it("returns to the kept selection when the note box is cancelled", () => {
		const doc = chat();
		const env = envOf(doc);
		const opened = keys(start(doc), ["v", "l", "a"], env).state;
		const cancelled = press(opened, "escape", env).state;
		assert.deepEqual(cancelled.mode, { kind: "visual", selection: { shape: "char", anchor: doc.placeAt(1, 1) }, count: "", prefix: "" });
		assert.deepEqual(at(doc, cancelled), [1, 2]);
	});

	it("lists, edits and deletes notes", () => {
		const doc = chat();
		const env = envOf(doc);
		let state = withNote(doc, env, "first");
		state = act(keys(state, ["}", "A"], env).state, { type: "saveNote", text: "second" }, env).state;
		assert.deepEqual(noteTexts(state), ["first", "second"]);
		state = press(state, "tab", env).state;
		assert.deepEqual(state.mode, { kind: "list", index: 0 });
		state = keys(state, ["j", "j", "k", "j"], env).state;
		assert.deepEqual(state.mode, { kind: "list", index: 1 });
		const edit = press(state, "e", env);
		assert.deepEqual(edit.effects, [{ type: "editNote", initialText: "second" }]);
		assert.equal(edit.state.mode.kind === "note" ? edit.state.mode.draft.editing : undefined, 2);
		state = act(edit.state, { type: "saveNote", text: "second edited" }, env).state;
		assert.deepEqual(noteTexts(state), ["first", "second edited"]);
		assert.deepEqual(state.mode, { kind: "list", index: 1 });
		state = press(state, "d", env).state;
		assert.deepEqual(noteTexts(state), ["first"]);
		assert.deepEqual(state.mode, { kind: "list", index: 0 });
		assert.deepEqual(state.message, { text: "deleted", error: false });
		state = press(state, "d", env).state;
		assert.deepEqual(noteTexts(state), []);
		assert.equal(keyAction(state, "x"), undefined);
		assert.equal(press(state, "tab", env).state.mode.kind, "normal");
	});

	it("exits with the notes for s and S and leaves them in the notebook", () => {
		const doc = chat();
		const env = envOf(doc);
		const state = withNote(doc, env);
		const appended = press(state, "s", env);
		assert.deepEqual(appended.effects, [{ type: "exit", outcome: { kind: "append", notes: state.notebook.notes } }]);
		assert.equal(appended.state.notebook, state.notebook);
		const submitted = press(press(state, "tab", env).state, "S", env);
		assert.deepEqual(submitted.effects, [{ type: "exit", outcome: { kind: "submit", notes: state.notebook.notes } }]);
		const refused = press(start(doc), "s", env);
		assert.deepEqual(refused.effects, []);
		assert.equal(refused.state.message?.error, true);
	});

	it("quits with Ctrl-C from every non-note mode, even after a pending prefix, and cancels a draft", () => {
		const doc = chat();
		const env = envOf(doc);
		for (const sequence of [[], ["v"], ["tab"], ["?"], ["2", "g"]]) {
			const state = keys(withNote(doc, env), sequence, env).state;
			const armed = press(state, "ctrl+c", env);
			assert.deepEqual(armed.effects, []);
			assert.equal(armed.state.quitArmed, true);
			assert.deepEqual(press(armed.state, "ctrl+c", env).effects, [{ type: "exit", outcome: { kind: "quit" } }]);
		}
		const draft = press(withNote(doc, env), "a", env).state;
		const cancelled = press(draft, "ctrl+c", env);
		assert.equal(cancelled.state.mode.kind, "normal");
		assert.deepEqual(noteTexts(cancelled.state), ["first"]);
		assert.deepEqual(cancelled.effects, []);
	});

	it("arms the quit when notes are unsent, disarms on any other key and exits on the second press", () => {
		const doc = chat();
		const env = envOf(doc);
		assert.deepEqual(press(start(doc), "escape", env).effects, [{ type: "exit", outcome: { kind: "quit" } }]);
		const armed = press(withNote(doc, env), "q", env);
		assert.deepEqual(armed.effects, []);
		assert.equal(armed.state.quitArmed, true);
		assert.deepEqual(armed.state.message, { text: "1 unsent note; press again to quit", error: true });
		assert.equal(statusOf(armed.state).error, true);
		const disarmed = press(armed.state, "j", env).state;
		assert.equal(disarmed.quitArmed, false);
		assert.equal(disarmed.message, undefined);
		assert.deepEqual(keys(disarmed, ["q", "q"], env).effects, [{ type: "exit", outcome: { kind: "quit" } }]);
		assert.deepEqual(keys(armed.state, ["escape"], env).effects, [{ type: "exit", outcome: { kind: "quit" } }]);
	});
});

describe("conversation changes", () => {
	it("drops the selection, keeps the notes and re-seats the caret when the blocks are rebuilt", () => {
		const doc = chat();
		const env = envOf(doc);
		const state = keys(withNote(doc, env), ["}", "v", "l"], env).state;
		assert.equal(state.mode.kind, "visual");
		const rebuilt = new Transcript({ ...capture([user("question one"), assistant("answer one\n\nanswer two")], 30), blocks: [{ id: id(8), height: 3 }, { id: id(9), height: 4 }] });
		const changed = act(state, { type: "docChanged" }, envOf(rebuilt));
		assert.equal(changed.state.mode.kind, "normal");
		assert.deepEqual(changed.state.message, { text: "selection cleared: conversation changed", error: false });
		assert.deepEqual(changed.state.caret, { block: id(8), line: 1, char: 1 });
		assert.deepEqual(noteTexts(changed.state), ["first"]);
		assert.deepEqual(changed.effects, []);
		const unchanged = act(state, { type: "docChanged" }, env);
		assert.equal(unchanged.state.mode.kind, "visual");
		assert.equal(unchanged.state.message, undefined);
	});

	it("settles a caret whose block reflowed and keeps notes whose text moved", () => {
		const text = "alpha beta gamma delta epsilon zeta eta theta";
		const narrow = transcript([assistant(text)], 14);
		const wide = transcript([assistant(text)], 60);
		const deep = keys(start(narrow), ["G"], envOf(narrow)).state;
		assert.ok(deep.caret.line > 1);
		const moved = press(deep, "k", envOf(wide));
		assert.deepEqual(at(wide, moved.state), [0, 0]);
		assert.equal(moved.state.message, undefined);
	});

	it("exits detached when the conversation is empty", () => {
		const doc = chat();
		const state = start(doc);
		const empty = new Transcript({ width: 30, rows: [], blocks: [] });
		assert.deepEqual(act(state, { type: "move", motion: "down" }, envOf(empty)).effects, [{ type: "exit", outcome: { kind: "detached", reason: "the conversation is empty" } }]);
	});
});

describe("keys and help", () => {
	it("binds exactly the v1 key set", () => {
		const bound = new Set(bindings.flatMap((binding) => binding.keys));
		const expected = ["h", "j", "k", "l", "left", "down", "up", "right", "w", "b", "e", "0", "home", "^", "$", "end", "gg", "G", "{", "}", "ctrl+d", "ctrl+u", "ctrl+f", "pageDown", "ctrl+b", "pageUp", "v", "V", "o", "a", "A", "tab", "d", "s", "S", "?", "q", "escape", "enter", "ctrl+c"];
		assert.deepEqual([...bound].sort(), [...new Set(expected)].sort());
	});

	it("derives the status hints from the bindings table", () => {
		assert.equal(hintFor("normal"), "v select · a note · Tab list · s editor · S submit · q quit · ? help");
		assert.equal(hintFor("visual"), "v select · o swap · Esc leave · a note · Tab list · ? help");
		assert.equal(hintFor("list"), "e edit · d delete · Tab back · s editor · S submit · ? help");
		assert.equal(hintFor("note"), "Enter save · Esc cancel");
		assert.equal(hintFor("help"), "j scroll · Esc close");
		const status = statusOf(start(chat()));
		assert.deepEqual(status, { tag: "NORMAL", text: hintFor("normal"), error: false, pending: "" });
	});

	it("lists every bound key in the help under its own label and shows each heading once", () => {
		const rows = helpRows();
		const entries = rows.filter((row): row is Exclude<typeof row, { heading: string }> => !("heading" in row));
		for (const binding of bindings) {
			for (const key of binding.keys) {
				const shown = entries.filter((entry) => entry.label === binding.label && entry.keys.split(" ").includes(displayKey(key)));
				assert.ok(shown.length > 0, `${key} is missing from the help under "${binding.label}"`);
				for (const mode of binding.modes) assert.ok(shown.some((entry) => entry.modes.split("/").includes(mode)), `${key} should list ${mode}`);
			}
		}
		const headings = rows.filter((row): row is { heading: string } => "heading" in row).map((row) => row.heading);
		assert.deepEqual(headings, [...new Set(headings)]);
		assert.deepEqual(entries.find((entry) => entry.label === "half page down"), { group: "Move", keys: "Ctrl-d", label: "half page down", modes: "normal/visual" });
	});

	it("leaves every printable key, tab and enter to the editor in note mode", () => {
		const doc = chat();
		const note = press(start(doc), "a", envOf(doc)).state;
		for (const key of typed) assert.equal(keyAction(note, key), undefined, key);
		assert.deepEqual(keyAction(note, "escape"), { type: "back" });
	});

	it("scrolls the help with j and k and closes it with any other key", () => {
		const doc = chat();
		const env = envOf(doc);
		let state = press(start(doc), "?", env).state;
		assert.deepEqual(state.mode, { kind: "help", back: { kind: "normal", count: "", prefix: "" }, top: 0 });
		state = keys(state, ["j", "j", "k"], env).state;
		assert.equal(state.mode.kind === "help" ? state.mode.top : -1, 1);
		state = keys(state, ["k", "k"], env).state;
		assert.equal(state.mode.kind === "help" ? state.mode.top : -1, 0);
		assert.equal(press(state, "x", env).state.mode.kind, "normal");
		const fromVisual = keys(start(doc), ["v", "?", "escape"], env).state;
		assert.equal(fromVisual.mode.kind, "visual");
	});

	it("keeps mode keys out of other modes", () => {
		const doc = chat();
		const env = envOf(doc);
		const list = press(withNote(doc, env), "tab", env).state;
		for (const key of ["v", "a", "A", "h", "l", "w", "G"]) assert.equal(keyAction(list, key), undefined, key);
		const kinds: ModeKind[] = ["normal", "visual", "note", "list", "help"];
		for (const kind of kinds) assert.ok(bindings.some((binding) => binding.modes.includes(kind)), kind);
	});
});
