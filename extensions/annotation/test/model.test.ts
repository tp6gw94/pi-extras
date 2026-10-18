import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { render } from "grok-mermaid";
import type { SnapshotItem } from "../snapshot.ts";
import { type Doc, fenceKey, layout, locate } from "../tui/document.ts";
import { type Action, type Effect, type Env, type Model, type ModeKind, bindings, displayKey, helpLines, helpRows, HINTS, hintFor, initialModel, keyAction, pendingText, reduce } from "../tui/model.ts";

const WIDTH = 80;
const HEIGHT = 10;

const user = (id: string, text: string): SnapshotItem => ({ id, kind: "user", label: "You", text });
const assistant = (id: string, text: string): SnapshotItem => ({ id, kind: "assistant", label: "Assistant", text });
const tool = (id: string, text: string): SnapshotItem => ({ id, kind: "tool", label: "Tool", text });

const layoutOf = (doc: Doc) => layout(doc, WIDTH, visibleWidth);

const env: Env = { height: HEIGHT, layoutOf };

const head = (itemId: string) => ({ itemId, offset: 0, header: true });

const onScreen = (model: Model): boolean => {
	const canvas = layoutOf(model);
	const top = locate(canvas, model.viewport!)!.row;
	const row = locate(canvas, model.caret!)!.row;
	return row >= top && row < top + HEIGHT;
};

const act = (model: Model, action: Action): { model: Model; effects: Effect[] } => reduce(model, action, env);

const atWidth = (width: number): Env => ({ height: HEIGHT, layoutOf: (doc) => layout(doc, width, visibleWidth) });

const press = (model: Model, key: string): { model: Model; effects: Effect[] } => {
	const action = keyAction(model, key);
	assert.notEqual(action, undefined, `no binding for ${key} in ${model.mode.kind}`);
	return act(model, action!);
};

const keys = (model: Model, sequence: string[]): { model: Model; effects: Effect[] } => {
	let current = model;
	const effects: Effect[] = [];
	for (const key of sequence) {
		const step = press(current, key);
		current = step.model;
		effects.push(...step.effects);
	}
	return { model: current, effects };
};

const start = (items: readonly SnapshotItem[], version = 1, seq = 0): Model => initialModel(items, version, seq);
const noteTexts = (model: Model): string[] => model.notes.map((note) => note.text);

describe("notes", () => {
	it("captures a whole message with A and saves the trimmed text", () => {
		const opened = press(start([user("u", "question"), assistant("a", "answer")]), "A");
		assert.equal(opened.model.mode.kind, "note");
		assert.deepEqual(opened.effects, [{ type: "editNote", initialText: "" }]);
		if (opened.model.mode.kind !== "note") return;
		assert.equal(opened.model.mode.draft.quote, "answer");
		const saved = act(opened.model, { type: "saveNote", text: "  needs work  " });
		assert.deepEqual(
			saved.model.notes.map(({ quote, text }) => ({ quote, text })),
			[{ quote: "answer", text: "needs work" }],
		);
		assert.equal(saved.model.mode.kind, "normal");
	});

	it("quotes the characters selected in visual mode, including Enter as a", () => {
		let model = keys(start([assistant("a", "The cache is LRU.")]), ["l", "l", "l", "l"]).model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 4 });
		model = keys(model, ["v", "w"]).model;
		assert.equal(model.mode.kind, "visual");
		const opened = press(model, "enter");
		assert.equal(opened.model.mode.kind, "note");
		if (opened.model.mode.kind !== "note") return;
		assert.equal(opened.model.mode.draft.quote, "cache i");
	});

	it("quotes whole lines selected with V", () => {
		let model = keys(start([assistant("a", "first\nsecond\nthird")]), ["l", "l", "V", "j"]).model;
		const opened = press(model, "a");
		if (opened.model.mode.kind !== "note") throw new Error("expected note mode");
		assert.equal(opened.model.mode.draft.quote, "first\nsecond");
	});

	it("quotes the whole message when a is pressed on a folded tool header", () => {
		const opened = press(start([user("u", "one"), tool("t", "line 1\nline 2")]), "a");
		if (opened.model.mode.kind !== "note") throw new Error("expected note mode");
		assert.equal(opened.model.mode.draft.quote, "line 1\nline 2");
	});

	it("returns to the kept visual selection when the note box is cancelled", () => {
		let model = keys(start([assistant("a", "The cache is LRU.")]), ["l", "l", "l", "l", "v", "w", "enter"]).model;
		model = press(model, "escape").model;
		assert.equal(model.mode.kind, "visual");
		if (model.mode.kind !== "visual") return;
		assert.deepEqual(model.mode.anchor, { itemId: "a", offset: 4 });
		assert.deepEqual(model.caret, { itemId: "a", offset: 10 });
	});
});

describe("folds", () => {
	it("folds and unfolds the tool under the caret with Enter and za", () => {
		let model = start([user("u", "one"), tool("t", "line 1\nline 2")]);
		model = press(model, "enter").model;
		assert.equal(model.expanded.has("t"), true);
		model = press(model, "enter").model;
		assert.equal(model.expanded.has("t"), false);
		model = keys(model, ["z", "a"]).model;
		assert.equal(model.expanded.has("t"), true);
	});

	it("includes folded tool text in an A note", () => {
		const opened = press(start([user("u", "one"), tool("t", "line 1\nline 2")]), "A");
		if (opened.model.mode.kind !== "note") throw new Error("expected note mode");
		assert.equal(opened.model.mode.draft.quote, "line 1\nline 2");
	});
});

const FLOW = "flowchart TD\n  A[Start] --> B[End]";
const FENCE = "```mermaid\n" + FLOW + "\n```";
const ART = render(FLOW)!;
const HIT = FENCE.indexOf("Start");
const WARN_FENCE = "```mermaid\nflowchart TD\n  A --> B\n  --> C\n```";

describe("mermaid diagrams", () => {
	it("toggles a rendered diagram to its source and back with Enter and za", () => {
		let model = start([assistant("a", FENCE)]);
		model = press(model, "enter").model;
		assert.deepEqual([...model.sourceFences], [fenceKey("a", 0)]);
		assert.deepEqual(model.caret, { itemId: "a", offset: 0 });
		model = keys(model, ["z", "a"]).model;
		assert.deepEqual([...model.sourceFences], []);
		assert.deepEqual(model.caret, { itemId: "a", offset: 0, diagram: 0 });
		model = press(model, "enter").model;
		assert.deepEqual([...model.sourceFences], [fenceKey("a", 0)]);
	});

	it("toggles with za from an art row and returns the caret to the art", () => {
		let model = keys(start([assistant("a", FENCE)]), ["j", "j"]).model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 0, diagram: 2 });
		model = keys(model, ["z", "a"]).model;
		assert.deepEqual([...model.sourceFences], [fenceKey("a", 0)]);
		assert.deepEqual(model.caret, { itemId: "a", offset: 0 });
		model = press(model, "enter").model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 0, diagram: 0 });
	});

	it("keeps zR and zM on tool output", () => {
		let model = start([assistant("a", FENCE), tool("t", "line 1\nline 2")]);
		model = keys(model, ["z", "R"]).model;
		assert.equal(model.expanded.has("t"), true);
		assert.deepEqual([...model.sourceFences], []);
		model = keys(model, ["z", "M"]).model;
		assert.equal(model.expanded.has("t"), false);
		assert.deepEqual([...model.sourceFences], []);
	});

	it("does not toggle a block that fell back to source", () => {
		const warn = press(start([assistant("a", WARN_FENCE)]), "enter").model;
		assert.deepEqual([...warn.sourceFences], []);
		const narrow = reduce(start([assistant("a", FENCE)]), { type: "fold" }, atWidth(11)).model;
		assert.deepEqual([...narrow.sourceFences], []);
	});

	it("switches rendered blocks to source when / and n find text inside them", () => {
		let model = start([assistant("a", FENCE), assistant("b", FENCE)]);
		model = act(press(model, "/").model, { type: "searchSubmit", query: "Start" }).model;
		assert.deepEqual([...model.sourceFences], [fenceKey("b", 0)]);
		assert.deepEqual(model.caret, { itemId: "b", offset: HIT });
		model = press(model, "n").model;
		assert.deepEqual([...model.sourceFences], [fenceKey("b", 0), fenceKey("a", 0)]);
		assert.deepEqual(model.caret, { itemId: "a", offset: HIT });
	});

	it("prunes toggled keys on reset and keeps the set object when nothing was pruned", () => {
		let model = press(start([assistant("a", FENCE)]), "enter").model;
		const toggled = model.sourceFences;
		assert.deepEqual([...toggled], [fenceKey("a", 0)]);
		model = act(model, { type: "update", version: 2, reset: true, items: [assistant("a", FENCE)] }).model;
		assert.equal(model.sourceFences, toggled);
		model = act(model, { type: "update", version: 3, reset: true, items: [assistant("a", "plain text")] }).model;
		assert.notEqual(model.sourceFences, toggled);
		assert.deepEqual([...model.sourceFences], []);
	});

	it("drops a caret on art to the source rows when the width falls below the diagram", () => {
		const model = keys(start([assistant("a", FENCE)]), ["j", "j"]).model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 0, diagram: 2 });
		const narrow = reduce(model, { type: "otherKey" }, atWidth(11)).model;
		assert.deepEqual(narrow.caret, { itemId: "a", offset: 0 });
		const wide = reduce(narrow, { type: "otherKey" }, env).model;
		assert.deepEqual(wide.caret, { itemId: "a", offset: 0, diagram: 0 });
	});

	it("quotes the whole fence when a is pressed on art", () => {
		const opened = press(keys(start([assistant("a", FENCE)]), ["j"]).model, "a");
		if (opened.model.mode.kind !== "note") throw new Error("expected note mode");
		assert.equal(opened.model.mode.draft.quote, FENCE);
	});
});

describe("plain text stepping", () => {
	const caretsOf = (model: Model, sequence: string[]): number[] => {
		const out: number[] = [];
		let current = model;
		for (const key of sequence) {
			current = press(current, key).model;
			out.push(current.caret!.offset);
		}
		return out;
	};

	it("visits every offset including the newline with l and h", () => {
		const model = start([assistant("a", "ab\ncd")]);
		assert.deepEqual(caretsOf(model, ["l", "l", "l", "l"]), [1, 2, 3, 4]);
		const end = keys(model, ["l", "l", "l", "l"]).model;
		assert.deepEqual(caretsOf(end, ["h", "h", "h", "h"]), [3, 2, 1, 0]);
	});

	it("stops on the newline when walking back from G", () => {
		const model = keys(start([assistant("a", "ab\ncd")]), ["G"]).model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 3 });
		assert.deepEqual(caretsOf(model, ["h", "h", "h"]), [2, 1, 0]);
	});
});

describe("counted moves over a diagram", () => {
	const tail = FENCE.length + 1;
	const withTail = () => start([assistant("a", FENCE + "\ntail")]);
	const atHeader = () => keys(withTail(), ["g", "g"]).model;

	it("treats the diagram as one unit so 2l equals l l", () => {
		const stepped = keys(atHeader(), ["l", "l"]).model.caret;
		assert.deepEqual(stepped, { itemId: "a", offset: tail });
		assert.deepEqual(keys(atHeader(), ["2", "l"]).model.caret, stepped);
	});

	it("enters the diagram from the header with one step", () => {
		assert.deepEqual(keys(atHeader(), ["l"]).model.caret, { itemId: "a", offset: 0, diagram: 0 });
	});

	it("reaches the diagram slot with a single h from the line after it and quotes the whole fence", () => {
		const from = keys(withTail(), ["G"]).model;
		assert.deepEqual(from.caret, { itemId: "a", offset: tail });
		const stepped = press(from, "h").model;
		assert.deepEqual(stepped.caret, { itemId: "a", offset: 0, diagram: 0 });
		assert.deepEqual(keys(from, ["2", "h"]).model.caret, stepped.caret);
		const opened = press(stepped, "a").model;
		if (opened.mode.kind !== "note") throw new Error("expected note mode");
		assert.equal(opened.mode.draft.quote, FENCE);
	});

	it("draws the caret on the art row after h from the line after the diagram", () => {
		const model = keys(withTail(), ["G", "h"]).model;
		const canvas = layoutOf(model);
		assert.equal(canvas.rows[locate(canvas, model.caret!)!.row]!.type, "diagram");
	});

	it("moves monotonically up through a diagram between two lines", () => {
		const model = keys(start([assistant("a", "pre\n" + FENCE + "\npost")]), ["G", "0"]).model;
		const canvas = layoutOf(model);
		const rows = [model.caret!];
		let current = model;
		for (let i = 0; i < 3; i++) {
			current = press(current, "h").model;
			rows.push(current.caret!);
		}
		const at = rows.map((pos) => locate(canvas, pos)!.row);
		assert.equal(canvas.rows[at[1]!]!.type, "diagram");
		assert.equal(canvas.rows[at[2]!]!.type, "text");
		assert.ok(at[0]! > at[1]! && at[1]! > at[2]! && at[2]! >= at[3]!, JSON.stringify(at));
	});
});

describe("stepping around a diagram", () => {
	const items = () => [assistant("a", "x\n" + FENCE), user("b", "yy")];

	it("goes from a trailing diagram to the next item's first character, not its header", () => {
		const model = keys(start(items()), ["g", "g", "l", "l", "l"]).model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 2, diagram: 0 });
		assert.deepEqual(press(model, "l").model.caret, { itemId: "b", offset: 0 });
	});

	it("visits on h the same stops that l visited", () => {
		const forward = ["l", "l", "l", "l", "l"];
		let model = keys(start(items()), ["g", "g"]).model;
		const seen = [model.caret];
		for (const key of forward) {
			model = press(model, key).model;
			seen.push(model.caret);
		}
		const back = [model.caret];
		for (let i = 0; i < forward.length - 1; i++) {
			model = press(model, "h").model;
			back.push(model.caret);
		}
		assert.deepEqual(back, seen.slice(1).reverse());
	});
});

describe("slot endpoints cover whole fences", () => {
	const GRAPH = "```mermaid\ngraph LR\nA-->B\n```";
	const BROKEN = "```mermaid\nflowchart TD\n  A-->\n```";
	const broken = () => start([assistant("a", "x\n" + BROKEN + "\ny")]);
	const quoted = (model: Model, sequence: string[]): string | undefined => {
		const opened = keys(model, [...sequence, "enter"]).model;
		return opened.mode.kind === "note" ? opened.mode.draft.quote : undefined;
	};

	for (const sequence of [
		["G", "k", "v", "k", "k"],
		["G", "k", "k", "v", "j"],
		["G", "k", "V", "k", "k"],
	]) {
		it(`quotes the whole warnings fence for ${sequence.join(" ")}`, () => {
			assert.equal(quoted(broken(), sequence), BROKEN);
		});
	}

	for (const sequence of [["g", "g", "v"], ["g", "g", "V"], ["g", "g", "v", "j", "k"], ["g", "g", "v", "l", "h"]]) {
		it(`quotes the whole diagram for ${sequence.join(" ")} from a header over a leading diagram`, () => {
			assert.equal(quoted(start([assistant("a", GRAPH + "\ntail")]), sequence), GRAPH);
		});
	}

	it("widens a selection from a previous item to the whole diagram that starts the next", () => {
		assert.equal(quoted(start([user("u", "one"), assistant("a", GRAPH)]), ["g", "g", "j", "v", "}"]), "one\n\n" + GRAPH);
	});

	it("steps h from a notice to the closing fence line", () => {
		const model = keys(broken(), ["G", "k", "h"]).model;
		const text = "x\n" + BROKEN + "\ny";
		assert.deepEqual(model.caret, { itemId: "a", offset: text.lastIndexOf("```") + 2 });
	});

	it("keeps the slot when l cannot move past the document end", () => {
		const model = keys(start([assistant("a", GRAPH)]), ["G"]).model;
		assert.equal(model.caret?.diagram, render("graph LR\nA-->B")!.plain.length - 1);
		assert.deepEqual(press(model, "l").model.caret, model.caret);
	});

	it("keeps the slot when h cannot move before the document start", () => {
		const model = keys(start([assistant("a", GRAPH + "\ntail")]), ["g", "g", "l", "j"]).model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 0, diagram: 1 });
		assert.deepEqual(press(model, "h").model.caret, model.caret);
	});

	it("toggles a source-shown fence back with h from the next line then Enter", () => {
		const toggled = keys(start([assistant("a", GRAPH + "\ny")]), ["g", "g", "l", "enter"]).model;
		assert.deepEqual([...toggled.sourceFences], [fenceKey("a", 0)]);
		const back = keys(toggled, ["G", "h", "enter"]).model;
		assert.deepEqual([...back.sourceFences], []);
	});

	it("never lets l move up or h move down across random documents with diagrams", () => {
		let seed = 7;
		const random = () => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return seed / 0x100000000;
		};
		const pick = <T,>(options: readonly T[]): T => options[Math.floor(random() * options.length)]!;
		const pieces = [GRAPH, BROKEN, FENCE, "", "foo bar", "x", "```ts", "```"];
		const sequence = ["h", "l", "h", "l", "j", "k", "w", "b", "e", "0", "$", "g", "G", "{", "}", "v", "V", "o", "escape", "z", "a", "enter"];
		for (let run = 0; run < 300; run++) {
			const items = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) =>
				assistant(`i${i}`, Array.from({ length: Math.floor(random() * 5) }, () => pick(pieces)).join("\n")),
			);
			let model = start(items);
			for (let step = 0; step < 40; step++) {
				const key = pick(sequence);
				const action = keyAction(model, key);
				if (!action || action.type === "quit") continue;
				const before = model;
				const rowBefore = before.caret ? locate(layoutOf(before), before.caret)?.row : undefined;
				model = act(model, action).model;
				if (rowBefore === undefined || !model.caret || action.type !== "move" || before.mode.kind === "note") continue;
				if (before.sourceFences !== model.sourceFences || before.mode.kind !== "normal" && before.mode.kind !== "visual" || before.mode.count !== "") continue;
				const row = locate(layoutOf(model), model.caret)?.row;
				if (action.motion === "right") assert.ok(row! >= rowBefore, `l moved up in run ${run}`);
				if (action.motion === "left") assert.ok(row! <= rowBefore, `h moved down in run ${run}`);
			}
		}
	});
});

describe("prefix and count reset", () => {
	const lines = () => start([assistant("a", "l1\nl2\nl3\nl4\nl5")]);

	for (const second of ["a", "z", "R", "M"]) {
		it(`moves one row for 3 z ${second} j`, () => {
			const model = keys(lines(), ["3", "z", second, "j"]).model;
			assert.deepEqual(model.caret, { itemId: "a", offset: 3 });
			assert.deepEqual(model.mode, { kind: "normal", count: "", prefix: "" });
		});
	}

	for (const second of ["a", "R", "M"]) {
		it(`clears count and prefix for 3 z ${second} without a caret`, () => {
			const model = keys(start([]), ["3", "z", second]).model;
			assert.deepEqual(model.mode, { kind: "normal", count: "", prefix: "" });
		});
	}

	it("clears count and prefix for 3 z z without a caret", () => {
		const model = keys(start([]), ["3", "z", "z"]).model;
		assert.deepEqual(model.mode, { kind: "normal", count: "", prefix: "" });
	});

	it("toggles twice for za then Enter", () => {
		let model = start([assistant("a", FENCE)]);
		model = keys(model, ["z", "a"]).model;
		assert.deepEqual([...model.sourceFences], [fenceKey("a", 0)]);
		model = press(model, "enter").model;
		assert.deepEqual([...model.sourceFences], []);
	});
});

describe("diagram toggle from the header", () => {
	it("leaves a diagram that starts the message alone on Enter and za at the header", () => {
		const header = keys(start([assistant("a", FENCE)]), ["g", "g"]).model;
		assert.deepEqual(header.caret, head("a"));
		assert.deepEqual([...press(header, "enter").model.sourceFences], []);
		assert.deepEqual([...keys(header, ["z", "a"]).model.sourceFences], []);
	});
});

describe("live updates", () => {
	it("seeds the caret when an empty document receives its first append", () => {
		const appended = act(start([]), { type: "update", version: 2, reset: false, items: [user("u", "hi")] });
		assert.deepEqual(appended.model.caret, { itemId: "u", offset: 0 });
		assert.deepEqual(appended.model.viewport, head("u"));
	});

	it("keeps the caret, selection, viewport and notes on append", () => {
		let model = start([user("u", "one two"), assistant("a", "three four")]);
		model = act(press(model, "A").model, { type: "saveNote", text: "keep" }).model;
		model = keys(model, ["v", "l", "l"]).model;
		const before = { caret: model.caret, viewport: model.viewport, anchor: model.mode.kind === "visual" ? model.mode.anchor : undefined };
		const appended = act(model, { type: "update", version: 2, reset: false, items: [tool("t", "out")] });
		assert.deepEqual(appended.model.caret, before.caret);
		assert.deepEqual(appended.model.viewport, before.viewport);
		assert.deepEqual(appended.model.items.map((item) => item.id), ["u", "a", "t"]);
		assert.equal(appended.model.mode.kind, "visual");
		if (appended.model.mode.kind === "visual") assert.deepEqual(appended.model.mode.anchor, before.anchor);
		assert.deepEqual(noteTexts(appended.model), ["keep"]);
	});

	it("remaps the caret by item id and clamps inside a grapheme", () => {
		let model = keys(start([assistant("a", "aXb")]), ["l", "l"]).model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 2 });
		const clamped = act(model, { type: "update", version: 2, reset: true, items: [assistant("a", "a😀b")] });
		assert.deepEqual(clamped.model.caret, { itemId: "a", offset: 1 });
	});

	it("moves a vanished caret to the nearest remaining item", () => {
		let model = keys(start([user("u", "one"), assistant("a", "two"), tool("t", "three")]), ["{", "l", "l"]).model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 1 });
		const backward = act(model, { type: "update", version: 2, reset: true, items: [user("u", "one")] });
		assert.deepEqual(backward.model.caret, head("u"));
		const forward = act(model, { type: "update", version: 2, reset: true, items: [tool("t", "three")] });
		assert.deepEqual(forward.model.caret, head("t"));
	});

	it("drops a visual selection whose endpoint vanished and keeps the notes", () => {
		let model = start([user("u", "one two"), assistant("a", "three four")]);
		model = act(press(model, "A").model, { type: "saveNote", text: "keep me" }).model;
		model = keys(model, ["v", "l", "l"]).model;
		const dropped = act(model, { type: "update", version: 2, reset: true, items: [user("u", "one two")] });
		assert.equal(dropped.model.mode.kind, "normal");
		assert.equal(dropped.model.message?.text, "selection cleared: conversation changed");
		assert.equal(dropped.model.message?.error, false);
		assert.deepEqual(dropped.model.caret, head("u"));
		assert.deepEqual(noteTexts(dropped.model), ["keep me"]);
	});

	it("drops a visual selection whose endpoint text changed", () => {
		let model = keys(start([assistant("a", "hello world")]), ["v", "l", "l", "l"]).model;
		const dropped = act(model, { type: "update", version: 2, reset: true, items: [assistant("a", "HELLO world")] });
		assert.equal(dropped.model.mode.kind, "normal");
		assert.equal(dropped.model.message?.text, "selection cleared: conversation changed");
		assert.deepEqual(dropped.model.caret, { itemId: "a", offset: 3 });
	});

	it("keeps a visual selection when its endpoints are unchanged", () => {
		let model = keys(start([user("u", "one"), assistant("a", "hello world")]), ["v", "l", "l", "l"]).model;
		const kept = act(model, { type: "update", version: 2, reset: true, items: [user("u", "one"), assistant("a", "hello world"), tool("t", "x")] });
		assert.equal(kept.model.mode.kind, "visual");
		if (kept.model.mode.kind !== "visual") return;
		assert.deepEqual(kept.model.mode.anchor, { itemId: "a", offset: 0 });
		assert.deepEqual(kept.model.caret, { itemId: "a", offset: 3 });
	});

	it("moves to the snapshot while keeping notes, next note id, and note mode", () => {
		let model = start([assistant("a", "hello world")], 1, 4);
		model = act(press(model, "A").model, { type: "saveNote", text: "saved note" }).model;
		model = act(model, { type: "send", delivery: "editor" }).model;
		assert.deepEqual(model.sending, ["note-1"]);
		model = press(model, "A").model;
		const mode = model.mode;
		const moved = act(model, { type: "moved", snapshot: { version: 9, nextSeq: 16, items: [assistant("a", "hello world"), user("u", "replacement")] } });
		assert.deepEqual(moved.model.items.map((item) => item.id), ["a", "u"]);
		assert.equal(moved.model.version, 9);
		assert.equal(moved.model.seq, 16);
		assert.deepEqual(moved.model.sending, ["note-1"]);
		assert.deepEqual(noteTexts(moved.model), ["saved note"]);
		assert.equal(moved.model.nextNote, 2);
		assert.deepEqual(moved.model.mode, mode);
		assert.deepEqual(moved.model.connection, { status: "live" });
		assert.deepEqual(moved.model.message, { text: "pi moved to a new session; notes kept", error: false });
		const resend = act(moved.model, { type: "resend" });
		assert.deepEqual(resend.model.mode, mode);
		assert.deepEqual(noteTexts(resend.model), ["saved note"]);
		assert.equal(resend.model.seq, 16);
		assert.equal(resend.model.sending, undefined);
		assert.deepEqual(resend.model.message, { text: "pi moved to a new session; notes kept; choose s or S again", error: false });
	});
});

describe("send", () => {
	const oneNote = () => {
		const opened = press(start([assistant("a", "hello world")], 1, 4), "A");
		return act(opened.model, { type: "saveNote", text: "first line" }).model;
	};

	it("emits the literal annotations and keeps the notes on a conflict", () => {
		const model = oneNote();
		const sent = act(model, { type: "send", delivery: "editor" });
		assert.deepEqual(sent.effects, [{ type: "send", delivery: "editor", notes: [{ quote: "hello world", note: "first line" }] }]);
		assert.equal(sent.model.sending?.length, 1);
		const conflict = act(sent.model, { type: "conflict", expectedSeq: 9 });
		assert.equal(conflict.model.seq, 9);
		assert.deepEqual(noteTexts(conflict.model), ["first line"]);
		assert.equal(conflict.model.sending, undefined);
		assert.equal(conflict.model.message?.text, "another client sent first; your notes are kept; choose s or S again");
		assert.deepEqual(conflict.effects, []);
	});

	it("blocks another send after a poll move until the pending send reports its move", () => {
		const sending = act(oneNote(), { type: "send", delivery: "editor" }).model;
		const snapshot = { version: 7, nextSeq: 16, items: [assistant("a", "hello world")] };
		const moved = act(sending, { type: "moved", snapshot }).model;
		const blocked = act(moved, { type: "send", delivery: "editor" });
		assert.deepEqual(blocked.effects, []);
		assert.deepEqual(blocked.model.sending, ["note-1"]);
		assert.deepEqual(noteTexts(blocked.model), ["first line"]);
		const updated = act(blocked.model, { type: "update", version: 8, reset: false, items: [assistant("b", "Version eight reply")] }).model;
		const resolved = act(updated, { type: "resend" }).model;
		assert.equal(resolved.version, 8);
		assert.deepEqual(resolved.items.map(({ id, text }) => ({ id, text })), [{ id: "a", text: "hello world" }, { id: "b", text: "Version eight reply" }]);
		assert.equal(resolved.sending, undefined);
		assert.deepEqual(resolved.message, { text: "pi moved to a new session; notes kept; choose s or S again", error: false });
		const resent = act(resolved, { type: "send", delivery: "editor" });
		assert.equal(resent.model.seq, 16);
		assert.deepEqual(resent.effects, [{ type: "send", delivery: "editor", notes: [{ quote: "hello world", note: "first line" }] }]);
	});

	it("clears only the sent notes and reports the count", () => {
		let model = oneNote();
		model = keys(model, ["{", "A"]).model;
		model = act(model, { type: "saveNote", text: "second line" }).model;
		assert.equal(model.notes.length, 2);
		const sent = act(model, { type: "send", delivery: "editor" });
		const first = model.notes[0]!.id;
		const partial = act(sent.model, { type: "sent", delivery: "editor", ids: [first], inserted: 1, nextSeq: 10 });
		assert.deepEqual(noteTexts(partial.model), ["second line"]);
		assert.equal(partial.model.seq, 10);
		assert.equal(partial.model.message?.text, "sent 1 to the pi editor");
	});

	it("refuses further sends after the connection closed", () => {
		const model = oneNote();
		const closed = act(model, { type: "failed", reason: "annotate server closed; run /annotate in pi and attach again" });
		assert.deepEqual(closed.model.connection, { status: "closed", reason: "annotate server closed; run /annotate in pi and attach again" });
		const refused = act(closed.model, { type: "send", delivery: "editor" });
		assert.deepEqual(refused.effects, []);
		assert.equal(refused.model.message?.text, "annotate server closed; run /annotate in pi and attach again");
		assert.deepEqual(noteTexts(refused.model), ["first line"]);
	});
});

describe("quit", () => {
	it("exits immediately without unsent notes and arms once with them", () => {
		const empty = act(start([assistant("a", "answer")]), { type: "quit" });
		assert.deepEqual(empty.effects, [{ type: "exit" }]);
		const model = act(press(start([user("u", "question"), assistant("a", "answer")]), "A").model, { type: "saveNote", text: "note" }).model;
		const armed = act(model, { type: "quit" });
		assert.deepEqual(armed.effects, []);
		assert.equal(armed.model.quitArmed, true);
		assert.equal(armed.model.message, undefined);
		const disarmed = act(armed.model, { type: "move", motion: "down" });
		assert.equal(disarmed.model.quitArmed, false);
		const armedAgain = act(disarmed.model, { type: "quit" });
		assert.equal(armedAgain.model.quitArmed, true);
		const exit = act(armedAgain.model, { type: "quit" });
		assert.deepEqual(exit.effects, [{ type: "exit" }]);
	});

	for (const prefix of ["g", "z"]) {
		it(`quits on Ctrl-C right after a ${prefix} prefix`, () => {
			const exited = keys(start([assistant("a", "answer")]), [prefix, "ctrl+c"]);
			assert.deepEqual(exited.effects, [{ type: "exit" }]);
		});
	}

	it("arms the quit warning on Ctrl-C right after a z prefix with unsent notes", () => {
		const noted = act(press(start([user("u", "question"), assistant("a", "answer")]), "A").model, { type: "saveNote", text: "note" }).model;
		const armed = keys(noted, ["z", "ctrl+c"]);
		assert.deepEqual(armed.effects, []);
		assert.equal(armed.model.quitArmed, true);
		assert.equal(pendingText(armed.model), "");
	});

	it("leaves search mode for its prior mode when Ctrl-C arms the quit", () => {
		const noted = act(press(start([user("u", "question"), assistant("a", "answer")]), "A").model, { type: "saveNote", text: "note" }).model;
		const armed = keys(noted, ["/", "ctrl+c"]);
		assert.equal(armed.model.mode.kind, "normal");
		assert.equal(armed.model.quitArmed, true);
		assert.deepEqual(armed.effects, [{ type: "openSearch" }]);
	});

	it("keeps asynchronous messages while typing in the note editor and only disarms the quit", () => {
		const saved = act(press(start([user("u", "question"), assistant("a", "answer")]), "A").model, { type: "saveNote", text: "note" }).model;
		const opened = press(saved, "A").model;
		const rejected = act(opened, { type: "rejected", reason: "body too large" }).model;
		const typed = act(rejected, { type: "otherKey" });
		assert.deepEqual(typed.model.message, { text: "body too large", error: true });
		const armed = act(typed.model, { type: "quit" }).model;
		assert.equal(armed.quitArmed, true);
		const disarmed = act(armed, { type: "otherKey" });
		assert.equal(disarmed.model.quitArmed, false);
		assert.deepEqual(disarmed.effects, []);
	});
});

describe("search", () => {
	const items = [user("u", "nothing here"), tool("t", "secret needle"), assistant("a", "needle here")];

	it("opens search, jumps to a hit inside folded text and repeats with n and N", () => {
		let model = start(items);
		const opened = press(model, "/");
		assert.equal(opened.model.mode.kind, "search");
		assert.deepEqual(opened.effects, [{ type: "openSearch" }]);
		const submitted = act(opened.model, { type: "searchSubmit", query: "needle" });
		assert.equal(submitted.model.mode.kind, "normal");
		assert.deepEqual(submitted.model.caret, { itemId: "t", offset: 7 });
		assert.equal(submitted.model.expanded.has("t"), true);
		assert.deepEqual(submitted.model.lastSearch, { query: "needle", direction: 1 });
		model = press(submitted.model, "n").model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 0 });
		model = press(model, "N").model;
		assert.deepEqual(model.caret, { itemId: "t", offset: 7 });
	});

	it("returns to the previous mode without moving on an empty query", () => {
		const opened = press(start(items), "/");
		const submitted = act(opened.model, { type: "searchSubmit", query: "   " });
		assert.equal(submitted.model.mode.kind, "normal");
		assert.deepEqual(submitted.model.caret, { itemId: "a", offset: 0 });
	});
});

describe("list", () => {
	it("moves, jumps, edits and deletes notes", () => {
		let model = start([assistant("a", "alpha beta"), user("u", "gamma delta")]);
		model = act(press(model, "A").model, { type: "saveNote", text: "u note" }).model;
		model = act(press(press(model, "{").model, "A").model, { type: "saveNote", text: "a note" }).model;
		assert.deepEqual(noteTexts(model), ["u note", "a note"]);
		model = press(model, "tab").model;
		assert.deepEqual(model.mode, { kind: "list", index: 0 });
		model = press(model, "j").model;
		assert.deepEqual(model.mode, { kind: "list", index: 1 });
		model = act(model, { type: "listJump" }).model;
		assert.equal(model.mode.kind, "normal");
		assert.deepEqual(model.caret, { itemId: "a", offset: 0 });
		model = press(model, "tab").model;
		const edit = act(model, { type: "listEdit" });
		assert.equal(edit.model.mode.kind, "note");
		assert.deepEqual(edit.effects, [{ type: "editNote", initialText: "u note" }]);
		model = act(edit.model, { type: "saveNote", text: "u note edited" }).model;
		assert.deepEqual(noteTexts(model), ["u note edited", "a note"]);
		assert.deepEqual(model.mode, { kind: "list", index: 0 });
		model = act(model, { type: "listDelete" }).model;
		assert.deepEqual(noteTexts(model), ["a note"]);
	});

	it("refuses to jump when the note source is gone", () => {
		let model = start([assistant("a", "answer"), user("u", "question")]);
		model = act(press(model, "A").model, { type: "saveNote", text: "note" }).model;
		model = act(model, { type: "update", version: 2, reset: true, items: [assistant("a", "answer")] }).model;
		model = press(model, "tab").model;
		const jump = act(model, { type: "listJump" });
		assert.equal(jump.model.mode.kind, "list");
		assert.equal(jump.model.message?.text, "the note's source is gone");
	});
});

describe("keys", () => {
	it("lists every bound key next to the label of its own binding", () => {
		const lines = helpLines();
		for (const binding of bindings) {
			for (const key of binding.keys) {
				const shown = lines.filter((entry) => entry.label === binding.label && entry.keys.split(" ").includes(displayKey(key)));
				assert.ok(shown.length > 0, `${key} is missing from the help under "${binding.label}"`);
				for (const mode of binding.modes) assert.ok(shown.some((line) => line.modes.split("/").includes(mode)), `${key} should list ${mode}`);
			}
		}
	});

	it("shows the modes a help row applies to", () => {
		const lines = helpLines();
		assert.deepEqual(lines.find((entry) => entry.label === "swap ends"), { group: "Select", keys: "o", label: "swap ends", modes: "visual" });
		assert.deepEqual(lines.find((entry) => entry.label === "leave visual"), { group: "Select", keys: "Esc q", label: "leave visual", modes: "visual" });
	});

	it("derives each hint from the per-mode table", () => {
		assert.equal(hintFor("normal"), "v select · a note · Tab list · s editor · S submit · q quit · ? help");
		assert.equal(hintFor("visual"), "a note · o swap · Esc leave · Tab list · ? help");
		assert.equal(hintFor("list"), "Enter jump · e edit · d delete · Tab back · s editor · S submit · ? help");
		assert.equal(hintFor("note"), "Enter save · Ctrl-J new line · Esc cancel · Ctrl-C quit");
		assert.equal(hintFor("search"), "");
	});

	it("only hints keys that are bound in that mode", () => {
		for (const [kind, hints] of Object.entries(HINTS)) {
			assert.ok(hints.length <= 7, kind);
			for (const [key] of hints) assert.ok(bindings.some((binding) => binding.keys.includes(key) && binding.modes.includes(kind as ModeKind)), `${key} is not bound in ${kind}`);
		}
	});

	it("shows each help group heading exactly once and a single quit and visual toggle row", () => {
		const rows = helpRows();
		const headings = rows.filter((row): row is { heading: string } => "heading" in row).map((row) => row.heading);
		assert.deepEqual(headings, [...new Set(headings)]);
		const entries = helpLines();
		assert.equal(entries.filter((entry) => entry.keys.split(" ").includes("Ctrl-C")).length, 1);
		assert.equal(entries.filter((entry) => entry.keys.split(" ").includes("v")).length, 1);
	});

	it("lists the note editor keys in the help", () => {
		const lines = helpLines();
		assert.ok(lines.some((entry) => entry.keys === "Enter" && entry.label === "save note" && entry.modes === "note"));
		assert.ok(lines.some((entry) => entry.keys === "Ctrl-J Shift+Enter" && entry.label === "new line" && entry.modes === "note"));
		assert.ok(lines.some((entry) => entry.keys.split(" ").includes("Esc") && entry.modes.split("/").includes("search")));
	});

	it("takes Escape in note and search mode from the bindings", () => {
		const note = keys(start([assistant("a", "answer")]), ["a"]).model;
		assert.deepEqual(keyAction(note, "escape"), { type: "cancelNote" });
		assert.equal(keyAction(note, "enter"), undefined);
		const search = press(start([assistant("a", "answer")]), "/").model;
		assert.deepEqual(keyAction(search, "escape"), { type: "escape" });
	});

	it("leaves every printable character, tab and enter to the editor in note and search mode", () => {
		const note = keys(start([assistant("a", "answer")]), ["a"]).model;
		const search = press(start([assistant("a", "answer")]), "/").model;
		const typed = [...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)), "tab", "enter"];
		for (const model of [note, search]) {
			for (const key of typed) assert.equal(keyAction(model, key), undefined, `${key} in ${model.mode.kind}`);
		}
	});

	it("labels v and V as toggles", () => {
		const lines = helpLines();
		assert.ok(lines.some((entry) => entry.keys === "v" && entry.label === "toggle select"));
		assert.ok(lines.some((entry) => entry.keys === "V" && entry.label === "toggle line select"));
	});

	it("scrolls the help screen with j and k and closes it with any other key", () => {
		let model = press(start([assistant("a", "answer")]), "?").model;
		assert.equal(model.mode.kind, "help");
		model = keys(model, ["j", "j", "k"]).model;
		assert.equal(model.mode.kind === "help" ? model.mode.top : -1, 1);
		model = press(model, "k").model;
		model = press(model, "k").model;
		assert.equal(model.mode.kind === "help" ? model.mode.top : -1, 0);
		assert.equal(press(model, "x").model.mode.kind, "normal");
	});

	it("applies a count prefix to a motion", () => {
		let model = start([assistant("a", "a\nb\nc\nd")]);
		model = press(model, "3").model;
		assert.equal(model.mode.kind, "normal");
		if (model.mode.kind === "normal") assert.equal(model.mode.count, "3");
		model = press(model, "j").model;
		assert.deepEqual(model.caret, { itemId: "a", offset: 6 });
	});

	it("resolves and cancels the g and z prefixes", () => {
		let model = start([user("u", "one"), assistant("a", "two\nthree")]);
		model = press(model, "g").model;
		assert.equal(model.mode.kind, "normal");
		if (model.mode.kind === "normal") assert.equal(model.mode.prefix, "g");
		model = press(model, "g").model;
		assert.deepEqual(model.caret, head("u"));
		model = keys(model, ["G", "z", "q"]).model;
		assert.equal(model.mode.kind, "normal");
		if (model.mode.kind === "normal") assert.equal(model.mode.prefix, "");
	});
});

describe("header rows", () => {
	const twoMessages = () => start([user("u1", "question one\nquestion two"), assistant("a1", "answer one\nanswer two")]);

	it("walks k from a message first line through the previous message to its header", () => {
		let model = twoMessages();
		const seen: unknown[] = [];
		for (let i = 0; i < 5; i++) {
			model = press(model, "k").model;
			seen.push(model.caret);
		}
		assert.deepEqual(seen, [head("a1"), { itemId: "u1", offset: 13 }, { itemId: "u1", offset: 0 }, head("u1"), head("u1")]);
	});

	it("walks j from a header down to its first line", () => {
		const model = keys(twoMessages(), ["k", "j"]).model;
		assert.deepEqual(model.caret, { itemId: "a1", offset: 0 });
	});

	it("shows the first header after gg", () => {
		const model = keys(twoMessages(), ["g", "g"]).model;
		assert.deepEqual(model.caret, head("u1"));
		assert.deepEqual(model.viewport, head("u1"));
	});

	it("moves { and } between message headers", () => {
		let model = twoMessages();
		model = press(model, "{").model;
		assert.deepEqual(model.caret, head("u1"));
		model = press(model, "}").model;
		assert.deepEqual(model.caret, head("a1"));
	});

	it("quotes the whole message when a is pressed on a user message header", () => {
		const opened = keys(twoMessages(), ["{", "a"]);
		if (opened.model.mode.kind !== "note") throw new Error("expected note mode");
		assert.equal(opened.model.mode.draft.quote, "question one\nquestion two");
		const fromAssistant = keys(twoMessages(), ["k", "a"]);
		if (fromAssistant.model.mode.kind !== "note") throw new Error("expected note mode");
		assert.equal(fromAssistant.model.mode.draft.quote, "answer one\nanswer two");
	});

	it("quotes only the current line when a is pressed on a text row", () => {
		const opened = press(twoMessages(), "a");
		if (opened.model.mode.kind !== "note") throw new Error("expected note mode");
		assert.equal(opened.model.mode.draft.quote, "answer one");
	});

	it("anchors the initial viewport on the last message header", () => {
		const model = start([user("u1", "question"), assistant("a1", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"))]);
		assert.deepEqual(model.viewport, head("a1"));
		assert.deepEqual(model.caret, { itemId: "a1", offset: 0 });
	});

	it("moves w from a header to the first word of the message", () => {
		const model = keys(start([user("u1", "question"), assistant("a1", "Hello world again")]), ["{", "}", "w"]).model;
		assert.deepEqual(model.caret, { itemId: "a1", offset: 0 });
		const fromAssistant = keys(start([user("u1", "question"), assistant("a1", "Hello world again")]), ["k", "w"]).model;
		assert.deepEqual(fromAssistant.caret, { itemId: "a1", offset: 0 });
	});

	it("moves e from a header to the end of the first word", () => {
		const model = keys(start([user("u1", "question"), assistant("a1", "Hello world again")]), ["k", "e"]).model;
		assert.deepEqual(model.caret, { itemId: "a1", offset: 4 });
	});

	it("moves b from a header to the last word of the previous message", () => {
		const model = keys(start([user("u1", "the question"), assistant("a1", "Hello world again")]), ["k", "b"]).model;
		assert.deepEqual(model.caret, { itemId: "u1", offset: 4 });
	});

	it("keeps 0, ^ and $ on the header", () => {
		for (const key of ["0", "^", "$"]) {
			const model = keys(start([user("u1", "question"), assistant("a1", "Hello world again")]), ["k", key]).model;
			assert.deepEqual(model.caret, head("a1"), key);
		}
	});

	it("moves the caret to a folded tool header and keeps it there when the tool unfolds", () => {
		let model = start([tool("t", "line 1\nline 2"), assistant("a", "answer")]);
		model = press(model, "k").model;
		model = press(model, "k").model;
		assert.deepEqual(model.caret, head("t"));
		model = press(model, "enter").model;
		assert.deepEqual(model.caret, head("t"));
		assert.equal(model.expanded.has("t"), true);
	});
});

describe("caret stays on screen after layout changes", () => {
	const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

	it("follows a search hit inside a folded tool far down", () => {
		const items = [user("u", "start"), assistant("a", lines(30)), tool("t", `${lines(25)}\nneedle`)];
		const model = keys(start(items), ["g", "g"]).model;
		const submitted = act(press(model, "/").model, { type: "searchSubmit", query: "needle" });
		assert.equal(submitted.model.expanded.has("t"), true);
		assert.deepEqual(submitted.model.caret, { itemId: "t", offset: items[2]!.text.indexOf("needle") });
		assert.equal(onScreen(submitted.model), true);
	});

	it("follows n into a folded tool far down", () => {
		const items = [user("u", "needle one"), assistant("a", lines(30)), tool("t", `${lines(25)}\nneedle`)];
		let model = keys(start(items), ["g", "g"]).model;
		model = act(press(model, "/").model, { type: "searchSubmit", query: "needle" }).model;
		model = press(model, "n").model;
		assert.equal(model.caret?.itemId, "t");
		assert.equal(onScreen(model), true);
	});

	it("keeps the caret visible after zR expands a tool above it", () => {
		const items = [user("u", "one"), tool("t", lines(30)), assistant("a", "answer")];
		let model = keys(start(items), ["g", "g", "}", "}"]).model;
		assert.deepEqual(model.caret, head("a"));
		model = keys(model, ["z", "R"]).model;
		assert.equal(model.expanded.has("t"), true);
		assert.equal(onScreen(model), true);
	});

	it("keeps the caret visible after jumping from the list into a folded tool", () => {
		const items = [user("u", "one"), assistant("a", lines(30)), tool("t", `${lines(25)}\nneedle`)];
		let model = start(items);
		model = act(press(model, "A").model, { type: "saveNote", text: "tool note" }).model;
		model = keys(model, ["g", "g", "tab"]).model;
		model = act(model, { type: "listJump" }).model;
		assert.equal(model.expanded.has("t"), true);
		assert.equal(onScreen(model), true);
	});

	it("keeps the caret visible after zM folds the tool it was inside", () => {
		const items = [user("u", "one"), tool("t", lines(30)), assistant("a", "answer")];
		let model = keys(start(items), ["g", "g", "z", "R", "G"]).model;
		model = keys(model, ["z", "M"]).model;
		assert.equal(onScreen(model), true);
	});
});

describe("send failures", () => {
	const withNote = () => {
		const opened = press(start([assistant("a", "hello world")], 1, 4), "A");
		return act(opened.model, { type: "saveNote", text: "first line" }).model;
	};

	it("keeps the notes and the live connection when the server rejects the request", () => {
		const sending = act(withNote(), { type: "send", delivery: "editor" }).model;
		const rejected = act(sending, { type: "rejected", reason: "body too large" });
		assert.equal(rejected.model.sending, undefined);
		assert.deepEqual(rejected.model.connection, { status: "live" });
		assert.deepEqual(noteTexts(rejected.model), ["first line"]);
		assert.deepEqual(rejected.model.message, { text: "body too large", error: true });
		assert.equal(act(rejected.model, { type: "send", delivery: "editor" }).effects.length, 1);
	});
});

describe("stashed visual selections on reset", () => {
	const items = [user("u", "one"), assistant("a", "hello world")];
	const changed = [user("u", "one"), assistant("a", "HELLO world")];
	const reset = (model: Model, next: readonly SnapshotItem[]) => act(model, { type: "update", version: 2, reset: true, items: next }).model;
	const cleared = "selection cleared: conversation changed";

	it("returns to normal from a note box whose stored selection changed, keeping the captured note", () => {
		const opened = keys(start(items), ["v", "l", "l", "a"]).model;
		const model = reset(opened, changed);
		assert.equal(model.mode.kind, "note");
		assert.equal(model.message?.text, cleared);
		if (model.mode.kind !== "note") return;
		assert.equal(model.mode.draft.quote, "hel");
		assert.deepEqual(model.mode.draft.from, { kind: "normal", count: "", prefix: "" });
		const cancelled = act(model, { type: "cancelNote" }).model;
		assert.equal(cancelled.mode.kind, "normal");
		const saved = act(model, { type: "saveNote", text: "kept" }).model;
		assert.deepEqual(saved.notes.map(({ quote, text }) => ({ quote, text })), [{ quote: "hel", text: "kept" }]);
	});

	it("returns to normal from help when the stored selection vanished", () => {
		const model = reset(keys(start(items), ["v", "l", "?"]).model, [user("u", "one")]);
		assert.equal(model.mode.kind, "help");
		assert.equal(model.message?.text, cleared);
		assert.equal(act(model, { type: "escape" }).model.mode.kind, "normal");
	});

	it("returns to normal from search when the stored selection changed", () => {
		const model = reset(act(keys(start(items), ["v", "l"]).model, { type: "openSearch" }).model, changed);
		assert.equal(model.mode.kind, "search");
		assert.equal(act(model, { type: "escape" }).model.mode.kind, "normal");
	});

	it("keeps a stored selection whose endpoints are unchanged", () => {
		const model = reset(keys(start(items), ["v", "l", "?"]).model, [...items, tool("t", "x")]);
		assert.equal(model.message, undefined);
		assert.equal(act(model, { type: "escape" }).model.mode.kind, "visual");
	});
});
