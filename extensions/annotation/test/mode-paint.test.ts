import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Decorations, Mark, Mode, Note, State } from "../mode/data.ts";
import { decorationsOf, type Palette, paintRows } from "../mode/paint.ts";
import { Transcript } from "../mode/transcript.ts";
import { assistant, id, markdown, spacer, transcript, user } from "./mode-fixtures.ts";

const palette: Palette = { caret: "\x1b[7m", selected: "\x1b[48;5;24m", noted: "\x1b[4m" };
const CARET_CLOSE = "\x1b[27m";
const SELECTED_CLOSE = "\x1b[49m";
const NOTED_CLOSE = "\x1b[24m";
const none: Decorations = { caret: undefined, selected: [], noted: [] };
const rowOf = (doc: Transcript, needle: string): number => [...doc.rows.keys()].find((row) => doc.text(row).text.includes(needle))!;

const unchanged = (before: readonly string[], after: readonly string[]): void => {
	assert.equal(after.length, before.length);
	before.forEach((raw, row) => {
		assert.equal(stripTerminalSequences(after[row]), stripTerminalSequences(raw), `row ${row} text`);
		assert.equal(visibleWidth(after[row]), visibleWidth(raw), `row ${row} width`);
	});
};

const reinjected = (painted: string, open: string, close: string): string => {
	const start = painted.indexOf(open) + open.length;
	const piece = painted.slice(start, painted.indexOf(close, start));
	let resets = 0;
	for (const match of piece.matchAll(/\x1b\[[0-9;:]*m/g)) {
		if (match[0] === open) continue;
		resets++;
		assert.equal(piece.slice(match.index + match[0].length, match.index + match[0].length + open.length), open, `style re-opened after ${JSON.stringify(match[0])}`);
	}
	assert.ok(resets > 0, "the run contains a reset to survive");
	return piece;
};

const stateWith = (doc: Transcript, mode: Mode, caret: { row: number; char: number }, notes: Note[] = []): State => ({
	caret: doc.placeAt(caret.row, caret.char),
	goalX: 0,
	mode,
	notebook: { sessionId: "s", notes, nextId: notes.length + 1 },
	quitArmed: false,
	message: undefined,
});

describe("paintRows", () => {
	it("keeps the OSC 133 prefix first and the visible text and width intact on user rows", () => {
		const doc = transcript([user("hello world"), spacer(1)], 20);
		const text = rowOf(doc, "hello");
		const selected = doc.spansBetween("line", doc.placeAt(0, 0), doc.placeAt(2, 0));
		const painted = paintRows(doc.rows, doc, { caret: { row: text, char: 1 }, selected, noted: [] }, palette);
		unchanged(doc.rows, painted);
		assert.ok(painted[0].startsWith("\x1b]133;A\x07"));
		assert.ok(painted[2].startsWith("\x1b]133;B\x07\x1b]133;C\x07"));
		assert.ok(!painted[0].slice("\x1b]133;A\x07".length).includes("\x1b]133"));
		assert.ok(painted[text].includes(palette.caret + "h" + CARET_CLOSE));
		assert.equal(painted[3], doc.rows[3]);
	});

	it("re-opens the selection after every SGR inside the run so table resets cannot cancel it", () => {
		const doc = transcript([assistant("| key | value |\n|---|---|\n| **alpha beta gamma delta** | x |")], 20);
		const row = rowOf(doc, "alph");
		assert.ok(doc.rows[row].includes("\x1b[22;23;24;25;27;28;29;39m"));
		const painted = paintRows(doc.rows, doc, { caret: undefined, selected: doc.spansBetween("line", doc.placeAt(row, 0), doc.placeAt(row, 0)), noted: [] }, palette);
		unchanged(doc.rows, painted);
		const piece = reinjected(painted[row], palette.selected, SELECTED_CLOSE);
		assert.equal(stripTerminalSequences(piece), doc.text(row).text);
	});

	it("re-opens the caret after syntax highlight resets inside a code row and underlines a noted span beside it", () => {
		const doc = transcript([assistant("```ts\nlet a = 1\n```")], 20);
		const row = rowOf(doc, "let a");
		assert.ok(doc.rows[row].includes("\x1b[39m"));
		const marks = doc.marksFor([{ row, from: 7, to: 12 }]);
		const painted = paintRows(doc.rows, doc, { caret: { row, char: 3 }, selected: [], noted: doc.liveMarks(marks) }, palette);
		unchanged(doc.rows, painted);
		assert.equal(stripTerminalSequences(reinjected(painted[row], palette.caret, CARET_CLOSE)), "l");
		assert.equal(stripTerminalSequences(reinjected(painted[row], palette.noted, NOTED_CLOSE)), "a = 1");
	});

	it("wraps whole wide glyphs: CJK, ZWJ emoji and VS16", () => {
		const doc = transcript([markdown("日本 👨‍👩‍👧 ❤️ x")], 20);
		for (const [char, glyph] of [
			[2, "本"],
			[4, "👨‍👩‍👧"],
			[6, "❤️"],
		] as const) {
			const painted = paintRows(doc.rows, doc, { caret: { row: 0, char }, selected: [], noted: [] }, palette);
			unchanged(doc.rows, painted);
			assert.ok(painted[0].includes(palette.caret + glyph + CARET_CLOSE), glyph);
		}
	});

	it("paints one cell for a caret or selection on a blank row without growing a padded row", () => {
		const doc = transcript([spacer(1), user("hi")], 12);
		const empty = paintRows(doc.rows, doc, { caret: { row: 0, char: 0 }, selected: [], noted: [] }, palette);
		assert.equal(empty[0], palette.caret + " " + CARET_CLOSE);
		const padded = paintRows(doc.rows, doc, { caret: { row: 1, char: 0 }, selected: [{ row: 1, from: 0, to: 0 }], noted: [] }, palette);
		assert.equal(visibleWidth(padded[1]), 12);
		assert.ok(padded[1].startsWith("\x1b]133;A\x07"));
		assert.ok(padded[1].includes(palette.selected + palette.caret));
	});

	it("layers selection, note and caret in one run and closes them in reverse order", () => {
		const doc = new Transcript({ width: 20, rows: [" alpha beta"], blocks: [{ id: id(1), height: 1 }] });
		const painted = paintRows(doc.rows, doc, { caret: { row: 0, char: 3 }, selected: [{ row: 0, from: 1, to: 5 }], noted: [{ row: 0, from: 3, to: 7 }] }, palette);
		const S = palette.selected;
		const N = palette.noted;
		const C = palette.caret;
		assert.equal(
			painted[0],
			` ${S}al${SELECTED_CLOSE}${S}${N}${C}p${CARET_CLOSE}${NOTED_CLOSE}${SELECTED_CLOSE}${S}${N}h${NOTED_CLOSE}${SELECTED_CLOSE}${N}a ${NOTED_CLOSE}beta`,
		);
	});

	it("returns the input array when nothing is decorated and never mutates it", () => {
		const doc = transcript([assistant("alpha")], 20);
		const before = [...doc.rows];
		assert.equal(paintRows(doc.rows, doc, none, palette), doc.rows);
		const painted = paintRows(doc.rows, doc, { caret: { row: 1, char: 1 }, selected: [], noted: [] }, palette);
		assert.notEqual(painted, doc.rows);
		assert.deepEqual(doc.rows, before);
	});

	it("leaves image rows untouched even when the caret rests on them", () => {
		const image = "\x1b_Gf=100,a=T;AAAA\x1b\\";
		const doc = new Transcript({ width: 10, rows: [image, "x"], blocks: [{ id: id(1), height: 2 }] });
		const painted = paintRows(doc.rows, doc, { caret: { row: 0, char: 0 }, selected: [{ row: 0, from: 0, to: 0 }], noted: [] }, palette);
		assert.equal(painted[0], image);
	});

	it("keeps OSC 8 links clickable around a caret inside the link text", () => {
		const doc = transcript([assistant("see [docs here](https://example.com) now")], 30);
		const row = rowOf(doc, "docs");
		const painted = paintRows(doc.rows, doc, { caret: { row, char: 6 }, selected: [], noted: [] }, palette);
		unchanged(doc.rows, painted);
		assert.ok(painted[row].includes("\x1b]8;;https://example.com\x1b\\"));
		assert.ok(painted[row].includes("\x1b]8;;\x1b\\"));
		assert.equal(stripTerminalSequences(reinjected(painted[row], palette.caret, CARET_CLOSE)), "o");
	});
});

describe("decorationsOf", () => {
	const doc = transcript([user("question"), assistant("answer text")], 24);
	const answer = rowOf(doc, "answer");
	const browse: Mode = { kind: "normal", count: "", prefix: "" };

	it("shows the caret while browsing and hides it in note, list and help modes", () => {
		const shown = decorationsOf(doc, stateWith(doc, browse, { row: answer, char: 2 }));
		assert.deepEqual(shown, { caret: { row: answer, char: 2 }, selected: [], noted: [] });
		const draft = { quote: "answer", marks: doc.marksFor([{ row: answer, from: 1, to: 7 }]), editing: undefined, back: browse };
		assert.equal(decorationsOf(doc, stateWith(doc, { kind: "note", draft }, { row: answer, char: 2 })).caret, undefined);
		assert.equal(decorationsOf(doc, stateWith(doc, { kind: "list", index: 0 }, { row: answer, char: 2 })).caret, undefined);
		assert.equal(decorationsOf(doc, stateWith(doc, { kind: "help", back: browse, top: 0 }, { row: answer, char: 2 })).caret, undefined);
	});

	it("selects between the anchor and the caret in visual mode and shows the draft marks while writing a note", () => {
		const anchor = doc.placeAt(answer, 1);
		const visual: Mode = { kind: "visual", selection: { shape: "char", anchor }, count: "", prefix: "" };
		assert.deepEqual(decorationsOf(doc, stateWith(doc, visual, { row: answer, char: 4 })).selected, [{ row: answer, from: 1, to: 5 }]);
		const marks: Mark[] = doc.marksFor([{ row: answer, from: 1, to: 7 }]);
		const draft = { quote: "answer", marks, editing: undefined, back: browse };
		assert.deepEqual(decorationsOf(doc, stateWith(doc, { kind: "note", draft }, { row: answer, char: 4 })).selected, [{ row: answer, from: 1, to: 7 }]);
	});

	it("underlines every note whose text is still visible and drops the caret when its block is gone", () => {
		const note: Note = { id: 1, quote: "answer", text: "n", marks: doc.marksFor([{ row: answer, from: 1, to: 7 }]) };
		const stale: Note = { id: 2, quote: "x", text: "n", marks: [{ block: id(9), line: 0, from: 0, to: 1, text: "x" }] };
		const deco = decorationsOf(doc, stateWith(doc, browse, { row: answer, char: 0 }, [note, stale]));
		assert.deepEqual(deco.noted, [{ row: answer, from: 1, to: 7 }]);
		const gone: State = { ...stateWith(doc, browse, { row: answer, char: 0 }), caret: { block: id(9), line: 0, char: 0 } };
		assert.equal(decorationsOf(doc, gone).caret, undefined);
	});
});
