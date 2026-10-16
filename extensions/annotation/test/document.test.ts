import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SnapshotItem } from "../snapshot.ts";
import {
	type Doc,
	type Layout,
	type Motion,
	type Position,
	fenceLang,
	headerAt,
	layout,
	layoutCache,
	lineStartAt,
	lineRange,
	locate,
	messageRange,
	move,
	positionAt,
	quote,
	remap,
	search,
	selectionRange,
	spansOf,
} from "../tui/document.ts";

const user = (id: string, text: string): SnapshotItem => ({ id, kind: "user", label: "You", text });
const assistant = (id: string, text: string): SnapshotItem => ({ id, kind: "assistant", label: "Assistant", text });
const tool = (id: string, text: string): SnapshotItem => ({ id, kind: "tool", label: "Tool", text });

const doc = (items: readonly SnapshotItem[], expanded: string[] = []): Doc => ({ items, expanded: new Set(expanded) });
const laid = (items: readonly SnapshotItem[], width = 40, expanded: string[] = []): Layout => layout(doc(items, expanded), width, visibleWidth);

type Row = Layout["rows"][number];
const rowText = (row: Row): string => (row.type === "header" ? `<header:${row.itemId}>` : row.cells.map((cell) => cell.text).join(""));
const rowTexts = (rows: Layout): string[] => rows.rows.map(rowText);

const at = (itemId: string, offset: number): Position => ({ itemId, offset });
const step = (items: readonly SnapshotItem[], pos: Position, motion: Motion, width = 40, goalX = 0, expanded: string[] = []) =>
	move(doc(items, expanded), laid(items, width, expanded), pos, goalX, motion);

describe("layout", () => {
	it("puts one header per item and wraps lines at word boundaries inside width minus indent", () => {
		assert.deepEqual(rowTexts(laid([user("u", "one two three four"), assistant("a", "x\n\ny")], 12)), [
			"<header:u>",
			"one two ",
			"three four",
			"<header:a>",
			"x",
			"",
			"y",
		]);
	});

	it("counts wide graphemes as two columns and keeps source offsets on every cell", () => {
		const rows = laid([assistant("a", "a快b")], 8);
		assert.deepEqual(rowTexts(rows), ["<header:a>", "a快b"]);
		const row = rows.rows[1]!;
		assert.equal(row.type, "text");
		if (row.type !== "text") return;
		assert.deepEqual(
			row.cells.map((cell) => [cell.text, cell.offset, cell.end, cell.width]),
			[
				["a", 0, 1, 1],
				["快", 1, 2, 2],
				["b", 2, 3, 1],
			],
		);
		assert.deepEqual(rowTexts(laid([assistant("a", "快取使用最近最少使用策略")], 12)), ["<header:a>", "快取使用最", "近最少使用", "策略"]);
	});

	it("hides tool text until its id is in expanded", () => {
		const items = [user("u", "hi"), tool("t", "line 1\nline 2")];
		assert.deepEqual(rowTexts(laid(items)), ["<header:u>", "hi", "<header:t>"]);
		assert.deepEqual(rowTexts(laid(items, 40, ["t"])), ["<header:u>", "hi", "<header:t>", "line 1", "line 2"]);
	});

	it("locates a folded tool position on its header row", () => {
		const items = [user("u", "hi"), tool("t", "hidden")];
		const rows = laid(items);
		assert.deepEqual(locate(rows, at("t", 0)), { row: 2, col: 0 });
		assert.deepEqual(positionAt(rows, 2, 7), headerAt("t"));
	});

	it("round-trips every row through positionAt and locate, headers included", () => {
		const items = [user("u", "one\ntwo"), tool("t", "hidden"), assistant("a", "three")];
		const rows = laid(items);
		rows.rows.forEach((_, row) => {
			const pos = positionAt(rows, row, 0)!;
			assert.deepEqual(locate(rows, pos), { row, col: 0 }, `row ${row}`);
		});
		assert.deepEqual(positionAt(rows, 0, 0), headerAt("u"));
		assert.deepEqual(positionAt(rows, 1, 0), at("u", 0));
		assert.deepEqual(locate(rows, headerAt("a")), { row: 4, col: 0 });
		assert.deepEqual(locate(rows, at("a", 0)), { row: 5, col: 0 });
	});

	it("reuses the layout for the same items, expansion and width and lays out new state", () => {
		const layoutOf = layoutCache(visibleWidth);
		const items = [user("u", "hi"), tool("t", "line 1\nline 2")];
		const folded = doc(items);
		const first = layoutOf(folded, 40);
		assert.equal(layoutOf({ items, expanded: folded.expanded }, 40), first);
		assert.notEqual(layoutOf(folded, 20), first);
		assert.deepEqual(rowTexts(layoutOf(doc(items, ["t"]), 40)), ["<header:u>", "hi", "<header:t>", "line 1", "line 2"]);
	});
});

describe("motions", () => {
	it("moves w b e by word at literal offsets", () => {
		const items = [assistant("a", "alpha beta.gamma delta\n\nepsilon")];
		const first = step(items, at("a", 0), "wordForward");
		assert.deepEqual(first.pos, at("a", 6));
		const second = step(items, first.pos, "wordForward", 40, first.goalX);
		assert.deepEqual(second.pos, at("a", 10));
		const back = step(items, at("a", 6), "wordBackward");
		assert.deepEqual(back.pos, at("a", 0));
		const end = step(items, at("a", 0), "wordEnd");
		assert.deepEqual(end.pos, at("a", 4));
		const endNext = step(items, end.pos, "wordEnd", 40, end.goalX);
		assert.deepEqual(endNext.pos, at("a", 9));
	});

	it("keeps w b e independent of the wrap width", () => {
		const items = [assistant("a", "alpha beta.gamma delta\n\nepsilon")];
		const walk = (width: number, motion: Motion, count: number) => {
			const positions: Position[] = [at("a", 0)];
			let goalX = 0;
			for (let i = 0; i < count; i++) {
				const result = step(items, positions.at(-1)!, motion, width, goalX);
				positions.push(result.pos);
				goalX = result.goalX;
			}
			return positions.map((position) => position.offset);
		};
		assert.deepEqual(walk(12, "wordForward", 6), walk(80, "wordForward", 6));
		assert.deepEqual(walk(12, "wordEnd", 6), walk(80, "wordEnd", 6));
	});

	it("steps over empty lines and empty messages to the next word", () => {
		assert.deepEqual(step([assistant("a", "\nfoo bar")], at("a", 0), "wordForward").pos, at("a", 1));
		assert.deepEqual(step([assistant("a", ""), user("u", "hello")], at("a", 0), "wordForward").pos, at("u", 0));
	});

	it("keeps horizontal and line motions on a folded tool header", () => {
		const items = [user("u", "abc"), tool("t", "hidden text"), assistant("a", "def")];
		assert.deepEqual(step(items, at("u", 2), "right").pos, headerAt("t"));
		assert.deepEqual(step(items, headerAt("t"), "right").pos, at("a", 0));
		assert.deepEqual(step(items, headerAt("t"), "left").pos, at("u", 2));
		assert.deepEqual(step(items, headerAt("t"), "lineEnd").pos, headerAt("t"));
		assert.deepEqual(step(items, headerAt("t"), "docStart").pos, headerAt("u"));
	});

	it("keeps the display column across j and k", () => {
		const items = [assistant("a", "abcdef\nab\nabcdef")];
		const down = step(items, at("a", 5), "down", 80, 5);
		assert.deepEqual(down, { pos: at("a", 8), goalX: 5 });
		assert.deepEqual(step(items, down.pos, "down", 80, down.goalX), { pos: at("a", 15), goalX: 5 });
	});

	it("moves to line bounds, document bounds and across messages at offset zero", () => {
		assert.deepEqual(step([assistant("a", "  hello world")], at("a", 6), "lineStart").pos, at("a", 0));
		assert.deepEqual(step([assistant("a", "  hello world")], at("a", 6), "firstNonBlank").pos, at("a", 2));
		assert.deepEqual(step([assistant("a", "  hello world")], at("a", 0), "lineEnd").pos, at("a", 12));
		const items = [user("u", "one"), assistant("a", "two\nthree")];
		assert.deepEqual(step(items, at("a", 5), "docStart").pos, headerAt("u"));
		assert.deepEqual(step(items, at("u", 0), "docEnd").pos, at("a", 4));
		assert.deepEqual(step([user("u", "one"), tool("t", "hidden")], at("u", 0), "docEnd").pos, headerAt("t"));
		assert.deepEqual(step(items, at("u", 0), "itemNext").pos, headerAt("a"));
		assert.deepEqual(step(items, at("a", 4), "itemNext").pos, headerAt("a"));
		assert.deepEqual(step(items, at("a", 0), "itemPrevious").pos, headerAt("u"));
	});

	it("walks k and j through header rows between messages", () => {
		const items = [user("u", "question"), assistant("a", "answer one\nanswer two")];
		const up = (pos: Position) => step(items, pos, "up").pos;
		const down = (pos: Position) => step(items, pos, "down").pos;
		assert.deepEqual(up(at("a", 11)), at("a", 0));
		assert.deepEqual(up(at("a", 0)), headerAt("a"));
		assert.deepEqual(up(headerAt("a")), at("u", 0));
		assert.deepEqual(up(at("u", 0)), headerAt("u"));
		assert.deepEqual(up(headerAt("u")), headerAt("u"));
		assert.deepEqual(down(headerAt("u")), at("u", 0));
		assert.deepEqual(down(at("u", 0)), headerAt("a"));
		assert.deepEqual(down(headerAt("a")), at("a", 0));
	});

	it("moves right from a header onto the first character", () => {
		const items = [user("u", "abc")];
		assert.deepEqual(step(items, headerAt("u"), "right").pos, at("u", 0));
	});

	it("starts a line at offset zero even when the text begins with a newline", () => {
		assert.equal(lineStartAt("\nfoo", 0), 0);
		assert.equal(lineStartAt("\nfoo", 1), 1);
		assert.equal(lineStartAt("ab\ncd", 4), 3);
	});

	it("steps by grapheme across messages", () => {
		const items = [user("u", "a快"), assistant("a", "b")];
		assert.deepEqual(step(items, at("u", 0), "right").pos, at("u", 1));
		assert.deepEqual(step(items, at("u", 1), "right").pos, at("a", 0));
		assert.deepEqual(step(items, at("a", 0), "left").pos, at("u", 1));
	});
});

describe("selection and quotes", () => {
	it("quotes a character selection inclusive of the caret grapheme in both directions", () => {
		const items = [assistant("a", "The cache is LRU.")];
		const forward = selectionRange(doc(items), "char", at("a", 4), at("a", 8));
		assert.deepEqual(forward, { start: at("a", 4), end: at("a", 9) });
		assert.equal(quote(doc(items), forward!), "cache");
		const backward = selectionRange(doc(items), "char", at("a", 8), at("a", 4));
		assert.deepEqual(backward, { start: at("a", 4), end: at("a", 9) });
	});

	it("quotes whole source lines in line mode", () => {
		const items = [assistant("a", "first line\nsecond line\nthird")];
		const range = selectionRange(doc(items), "line", at("a", 2), at("a", 12));
		assert.deepEqual(range, { start: at("a", 0), end: at("a", 22) });
		assert.equal(quote(doc(items), range!), "first line\nsecond line");
	});

	it("joins a cross-message range with a blank line and skips folded tools unless included", () => {
		const items = [user("u", "question"), tool("t", "secret"), assistant("a", "answer")];
		const range = { start: at("u", 0), end: at("a", 6) };
		assert.equal(quote(doc(items), range), "question\n\nanswer");
		assert.equal(quote(doc(items), range, true), "question\n\nsecret\n\nanswer");
		assert.deepEqual(spansOf(doc(items), range), [
			{ itemId: "u", start: 0, end: 8 },
			{ itemId: "t", start: 0, end: 6 },
			{ itemId: "a", start: 0, end: 6 },
		]);
	});

	it("quotes a selection inside one fenced block as a fenced block with its language", () => {
		const text = "Use this:\n```ts\nconst a = 1;\nconst b = 2;\n```\nDone.";
		const items = [assistant("a", text)];
		const range = selectionRange(doc(items), "line", at("a", 16), at("a", 39));
		assert.equal(quote(doc(items), range!), "```ts\nconst a = 1;\nconst b = 2;\n```");
		assert.equal(fenceLang(text, 16, 39), "ts");
		assert.equal(fenceLang(text, 0, 5), undefined);
		assert.equal(fenceLang("~~~\nx\n", 4, 5), "");
	});

	it("quotes the current line and the whole message", () => {
		const items = [assistant("a", "one\ntwo"), tool("t", "out")];
		const line = lineRange(doc(items), at("a", 4));
		assert.deepEqual(line, { start: at("a", 4), end: at("a", 7) });
		assert.equal(quote(doc(items), line!), "two");
		const whole = messageRange(doc(items), at("a", 4));
		assert.deepEqual(whole, { start: at("a", 0), end: at("a", 7) });
		assert.equal(quote(doc(items), whole!), "one\ntwo");
		assert.equal(quote(doc(items), messageRange(doc(items), at("t", 0))!, true), "out");
	});
});

describe("search", () => {
	const items = [user("u", "Cache miss"), tool("t", "cache hit"), assistant("a", "the CACHE")];

	it("finds, wraps and respects smart case while reading folded tool text", () => {
		assert.deepEqual(search(doc(items), at("u", 0), "cache", 1), at("t", 0));
		assert.deepEqual(search(doc(items), at("t", 0), "cache", 1), at("a", 4));
		assert.deepEqual(search(doc(items), at("a", 4), "cache", 1), at("u", 0));
		assert.deepEqual(search(doc(items), at("a", 4), "cache", -1), at("t", 0));
		assert.deepEqual(search(doc(items), headerAt("u"), "cache", 1), at("u", 0));
		assert.deepEqual(search(doc(items), at("u", 0), "cache", 1), at("t", 0));
		assert.deepEqual(search(doc(items), at("u", 0), "CACHE", 1), at("a", 4));
		assert.equal(search(doc(items), at("u", 0), "nothing", 1), undefined);
	});
});

describe("remap", () => {
	it("clamps to a grapheme boundary and reports a vanished item", () => {
		const items = [assistant("a", "a😀b")];
		assert.deepEqual(remap(doc(items), at("a", 2)), at("a", 1));
		assert.deepEqual(remap(doc(items), at("a", 99)), at("a", 4));
		assert.equal(remap(doc(items), at("gone", 0)), undefined);
		assert.deepEqual(remap(doc(items), headerAt("a")), headerAt("a"));
	});
});
