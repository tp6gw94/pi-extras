import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { BlockId, Capture } from "../mode/data.ts";
import { Transcript } from "../mode/transcript.ts";
import { assistant, capture, id, markdown, plain, spacer, transcript, user } from "./mode-fixtures.ts";

const CODE = "Use this:\n\n```ts\nlet a = 1\nlet b = 2\n```\n\nDone.";

const rowsOf = (doc: Transcript, test: (text: string) => boolean): number[] => [...doc.rows.keys()].filter((row) => test(doc.text(row).text));
const rowNamed = (doc: Transcript, needle: string): number => rowsOf(doc, (text) => text.includes(needle))[0];

describe("row text", () => {
	it("measures glyph columns the way sliceByColumn slices the raw row", () => {
		const samples = ["日本語テキスト 👨‍👩‍👧 ❤️ é́ ok", "**bold 中文** and `code`", "a 🇯🇵 b 👍🏽 c", "[link 連結](https://example.com) tail"];
		const doc = transcript([user(samples[0]), assistant(samples.slice(1).join("\n\n"))], 32);
		let glyphsChecked = 0;
		for (let row = 0; row < doc.rowCount; row++) {
			const raw = doc.rows[row];
			const { glyphs, x, text } = doc.text(row);
			assert.equal(x[glyphs.length], visibleWidth(text), `row ${row} width`);
			glyphs.forEach((glyph, index) => {
				assert.equal(stripTerminalSequences(sliceByColumn(raw, x[index], x[index + 1] - x[index], true)), glyph, `row ${row} glyph ${index}`);
				glyphsChecked++;
			});
		}
		assert.ok(glyphsChecked > 40);
	});

	it("drops the padding hidden under a trailing background reset and keeps the leading padding", () => {
		const doc = transcript([user("hello world")], 30);
		const row = rowNamed(doc, "hello");
		assert.equal(doc.text(row).text, " hello world");
		assert.deepEqual(doc.text(row).glyphs.slice(0, 2), [" ", "h"]);
		assert.equal(doc.text(row).firstNonBlank, 1);
	});

	it("treats padding rows, spacer rows and image rows as blank", () => {
		const image: Capture = { width: 10, rows: ["\x1b_Gf=100;AAAA\x1b\\", "x"], blocks: [{ id: id(1), height: 2 }] };
		const doc = new Transcript(image);
		assert.deepEqual(doc.text(0), { text: "", glyphs: [], x: [0], firstNonBlank: 0 });
		const padded = transcript([spacer(1), user("hi")], 20);
		assert.equal(doc.text(1).glyphs.length, 1);
		assert.equal(padded.text(0).glyphs.length, 0);
		assert.equal(padded.text(1).glyphs.length, 0);
	});
});

describe("places", () => {
	it("maps every row to a block-relative place and back", () => {
		const doc = transcript([spacer(2), user("one\n\ntwo"), assistant("three")], 20);
		assert.deepEqual(
			doc.blocks.map((block) => [block.id, block.start, block.height]),
			[
				[id(1), 0, 2],
				[id(2), 2, 5],
				[id(3), 7, 2],
			],
		);
		for (let row = 0; row < doc.rowCount; row++) assert.equal(doc.rowOf(doc.placeAt(row, 0)), row);
		assert.deepEqual(doc.placeAt(3, 99), { block: id(2), line: 1, char: 3 });
		assert.equal(doc.rowOf({ block: id(2), line: 5, char: 0 }), undefined);
		assert.equal(doc.rowOf({ block: id(9), line: 0, char: 0 }), undefined);
	});

	it("settles a place into a block that shrank or reflowed and reports a vanished block", () => {
		const wide = transcript([assistant("alpha beta gamma delta epsilon")], 40);
		const narrow = transcript([assistant("alpha beta gamma delta epsilon")], 14);
		const place = narrow.placeAt(narrow.rowCount - 1, 4);
		assert.ok(place.line > 1);
		const settled = wide.settle(place);
		assert.ok(settled !== undefined);
		assert.equal(settled.line, wide.blocks[0].height - 1);
		assert.equal(wide.settle({ block: id(5), line: 0, char: 0 }), undefined);
		const empty = new Transcript({ width: 10, rows: [], blocks: [{ id: id(1), height: 0 }] });
		assert.equal(empty.settle({ block: id(1), line: 0, char: 0 }), undefined);
	});

	it("snaps a column to the grapheme that covers it and clamps past the end", () => {
		const doc = transcript([spacer(1), markdown("日本x")], 20);
		const row = rowNamed(doc, "日本");
		assert.deepEqual(doc.text(row).x, [0, 1, 3, 5, 6]);
		assert.equal(doc.charAtX(row, 0), 0);
		assert.equal(doc.charAtX(row, 2), 1);
		assert.equal(doc.charAtX(row, 4), 2);
		assert.equal(doc.charAtX(row, 5), 3);
		assert.equal(doc.charAtX(row, Infinity), 3);
		assert.equal(doc.charAtX(rowsOf(doc, (text) => text === "")[0], 3), 0);
	});
});

describe("units", () => {
	it("counts only children with visible text and bounds them by their non-blank rows", () => {
		const doc = transcript([spacer(1), user("question"), assistant("answer\n\nmore"), spacer(2)], 24);
		const [userBlock, assistantBlock] = [doc.blocks[1], doc.blocks[2]];
		assert.deepEqual(doc.units, [
			{ block: userBlock.id, firstRow: userBlock.start + 1, lastRow: userBlock.start + 1 },
			{ block: assistantBlock.id, firstRow: assistantBlock.start + 1, lastRow: assistantBlock.start + 3 },
		]);
		assert.deepEqual(doc.unitAt(userBlock.start), doc.units[0]);
		assert.equal(doc.unitAt(0), undefined);
		assert.equal(doc.unitAt(doc.rowCount - 1), undefined);
	});
});

describe("code regions", () => {
	it("recovers fences with the default indent, an empty indent, inside a list and inside a blockquote", () => {
		const doc = transcript([assistant(CODE), markdown("```\nraw\n```", { codeBlockIndent: "" }), markdown("- item\n\n  ```py\n  x = 1\n  ```\n\n> ```sh\n> ls\n> ```")], 30);
		const region = doc.codeAt(rowNamed(doc, "let a"));
		assert.deepEqual(region, { lang: "ts", openRow: rowNamed(doc, "```ts"), closeRow: rowNamed(doc, "let b") + 1, prefix: " " });
		assert.equal(doc.codeAt(rowNamed(doc, "let b")), region);
		assert.equal(doc.codeAt(rowNamed(doc, "```ts")), undefined);
		assert.equal(doc.codeAt(rowNamed(doc, "Done")), undefined);
		assert.equal(doc.codeAt(rowNamed(doc, "raw"))?.lang, "");
		assert.equal(doc.codeAt(rowNamed(doc, "x = 1"))?.prefix, "   ");
		assert.equal(doc.codeAt(rowNamed(doc, "x = 1"))?.lang, "py");
		assert.equal(doc.codeAt(rowNamed(doc, "ls"))?.prefix, " │ ");
		assert.equal(doc.codeAt(rowNamed(doc, "ls"))?.lang, "sh");
	});

	it("keeps an indented fence-looking line inside the code and leaves an unterminated fence open to the block end", () => {
		const doc = transcript([assistant("````md\n```\nstill code\n````\n\ntail")], 30);
		assert.equal(doc.codeAt(rowNamed(doc, "still"))?.lang, "md");
		assert.equal(doc.codeAt(rowNamed(doc, "still") - 1)?.lang, "md");
		assert.equal(doc.codeAt(rowNamed(doc, "tail")), undefined);
		const raw = new Transcript({ width: 10, rows: [" ```js", "   open", "   more"], blocks: [{ id: id(1), height: 3 }] });
		assert.deepEqual(raw.codeAt(2), { lang: "js", openRow: 0, closeRow: undefined, prefix: " " });
	});
});

describe("selection spans", () => {
	it("orders the endpoints, includes the caret glyph and covers whole rows in line shape", () => {
		const doc = transcript([assistant("alpha beta\n\ngamma")], 30);
		const first = rowNamed(doc, "alpha");
		const last = rowNamed(doc, "gamma");
		const a = doc.placeAt(first, 3);
		const b = doc.placeAt(last, 2);
		assert.deepEqual(doc.spansBetween("char", b, a), [
			{ row: first, from: 3, to: doc.text(first).glyphs.length },
			{ row: first + 1, from: 0, to: 0 },
			{ row: last, from: 0, to: 3 },
		]);
		assert.deepEqual(doc.spansBetween("char", a, a), [{ row: first, from: 3, to: 4 }]);
		assert.deepEqual(doc.spansBetween("line", b, a), [
			{ row: first, from: 0, to: doc.text(first).glyphs.length },
			{ row: first + 1, from: 0, to: 0 },
			{ row: last, from: 0, to: doc.text(last).glyphs.length },
		]);
		assert.deepEqual(doc.spansBetween("char", a, { block: id(7), line: 0, char: 0 }), []);
	});
});

describe("quote", () => {
	it("quotes the visible text with common indentation removed and blank edge rows dropped", () => {
		const doc = transcript([user("question"), assistant("Intro\n\n- item one\n- item two")], 30);
		const block = doc.blocks[1];
		const all = doc.spansBetween("line", doc.placeAt(block.start, 0), doc.placeAt(block.start + block.height - 1, 0));
		assert.equal(doc.quote(all), "Intro\n\n- item one\n- item two");
		const userBlock = doc.blocks[0];
		const whole = doc.spansBetween("line", doc.placeAt(userBlock.start, 0), doc.placeAt(userBlock.start + userBlock.height - 1, 0));
		assert.equal(doc.quote(whole), "question");
		assert.equal(doc.quote([{ row: 0, from: 0, to: 0 }]), undefined);
	});

	it("keeps a mid-row start as is and dedents only rows selected from their first glyph", () => {
		const doc = transcript([assistant("alpha beta\n\ngamma delta")], 30);
		const first = rowNamed(doc, "alpha");
		const spans = doc.spansBetween("char", doc.placeAt(first, 7), doc.placeAt(first + 2, 5));
		assert.equal(doc.quote(spans), "beta\n\ngamma");
	});

	it("wraps a selection inside one code region in a fence longer than any backtick run, with the language", () => {
		const doc = transcript([assistant(CODE), assistant("```\nuse ``` here\n```")], 30);
		const a = rowNamed(doc, "let a");
		const inside = doc.spansBetween("line", doc.placeAt(a, 0), doc.placeAt(a + 1, 0));
		assert.equal(doc.quote(inside), "```ts\nlet a = 1\nlet b = 2\n```");
		const partial = doc.spansBetween("char", doc.placeAt(a, 9), doc.placeAt(a, 11));
		assert.equal(doc.quote(partial), "```ts\n= 1\n```");
		const tricky = rowNamed(doc, "use ```");
		assert.equal(doc.quote(doc.spansBetween("line", doc.placeAt(tricky, 0), doc.placeAt(tricky, 0))), "````\nuse ``` here\n````");
	});

	it("quotes fence rows as visible text without wrapping when the selection reaches them", () => {
		const doc = transcript([assistant(CODE)], 30);
		const open = rowNamed(doc, "```ts");
		const spans = doc.spansBetween("line", doc.placeAt(open, 0), doc.placeAt(open + 3, 0));
		assert.equal(doc.quote(spans), "```ts\n  let a = 1\n  let b = 2\n```");
		const across = doc.spansBetween("line", doc.placeAt(open - 2, 0), doc.placeAt(open + 1, 0));
		assert.equal(doc.quote(across), "Use this:\n\n```ts\n  let a = 1");
	});

	it("skips image rows inside a selection", () => {
		const doc = new Transcript({ width: 10, rows: ["first", "\x1b_Gf=100;AAAA\x1b\\", "last"], blocks: [{ id: id(1), height: 3 }] });
		assert.equal(doc.quote(doc.spansBetween("line", doc.placeAt(0, 0), doc.placeAt(2, 0))), "first\nlast");
	});
});

describe("marks", () => {
	it("snapshots the selected text per row and only draws it while the row still shows that text", () => {
		const text = "alpha beta gamma delta epsilon zeta";
		const wide = transcript([user("q"), assistant(text)], 40);
		const row = rowNamed(wide, "alpha");
		const spans = wide.spansBetween("char", wide.placeAt(row, 7), wide.placeAt(row, 10));
		const marks = wide.marksFor(spans);
		assert.deepEqual(marks, [{ block: wide.blocks[1].id, line: row - wide.blocks[1].start, from: 7, to: 11, text: "beta" }]);
		assert.deepEqual(wide.liveMarks(marks), [{ row, from: 7, to: 11 }]);
		const narrow = transcript([user("q"), assistant(text)], 10);
		assert.deepEqual(narrow.liveMarks(marks), []);
		const again = transcript([user("q"), assistant(text)], 40);
		assert.deepEqual(again.liveMarks(marks), [{ row, from: 7, to: 11 }]);
		const rebuilt = new Transcript({ ...capture([user("q"), assistant(text)], 40), blocks: [{ id: id(8), height: 3 }, { id: id(9), height: 2 }] });
		assert.deepEqual(rebuilt.liveMarks(marks), []);
	});

	it("produces no mark for a blank row", () => {
		const doc = transcript([assistant("one\n\ntwo")], 20);
		const blank = rowsOf(doc, (text) => text === "")[1];
		assert.deepEqual(doc.marksFor([{ row: blank, from: 0, to: 0 }]), []);
	});
});

describe("plain rows", () => {
	it("renders the fixtures through the real components", () => {
		const rows = plain(capture([user("hi"), spacer(1)], 12).rows);
		assert.deepEqual(rows, ["            ", " hi         ", "            ", ""]);
		const unknown: BlockId = id(1);
		assert.equal(typeof unknown, "number");
	});
});
