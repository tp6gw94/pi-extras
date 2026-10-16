import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "grok-mermaid";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SnapshotItem } from "../snapshot.ts";
import {
	type Doc,
	type Layout,
	type Motion,
	type Position,
	fenceKey,
	fenceLang,
	headerAt,
	layout,
	layoutCache,
	lineStartAt,
	lineRange,
	locate,
	normalizePosition,
	messageRange,
	mermaidBlockAt,
	move,
	positionAt,
	pruneSourceFences,
	quote,
	remap,
	search,
	selectionRange,
	spansOf,
} from "../tui/document.ts";

const user = (id: string, text: string): SnapshotItem => ({ id, kind: "user", label: "You", text });
const assistant = (id: string, text: string): SnapshotItem => ({ id, kind: "assistant", label: "Assistant", text });
const tool = (id: string, text: string): SnapshotItem => ({ id, kind: "tool", label: "Tool", text });

const doc = (items: readonly SnapshotItem[], expanded: string[] = [], sourceFences: string[] = []): Doc => ({
	items,
	expanded: new Set(expanded),
	sourceFences: new Set(sourceFences),
});
const laid = (items: readonly SnapshotItem[], width = 40, expanded: string[] = [], sourceFences: string[] = []): Layout =>
	layout(doc(items, expanded, sourceFences), width, visibleWidth);

type Row = Layout["rows"][number];
const rowText = (row: Row): string => {
	if (row.type === "header") return `<header:${row.itemId}>`;
	if (row.type === "diagram") return row.spans.map((span) => span.text).join("");
	if (row.type === "notice") return `<notice:${row.text}>`;
	return row.cells.map((cell) => cell.text).join("");
};
const rowTexts = (rows: Layout): string[] => rows.rows.map(rowText);

const at = (itemId: string, offset: number): Position => ({ itemId, offset });
const step = (items: readonly SnapshotItem[], pos: Position, motion: Motion, width = 40, goalX = 0, expanded: string[] = [], sourceFences: string[] = []) =>
	move(doc(items, expanded, sourceFences), laid(items, width, expanded, sourceFences), pos, goalX, motion);

const FLOW = "flowchart TD\n  A[Start] --> B[End]";
const FENCE = "```mermaid\n" + FLOW + "\n```";
const ART = render(FLOW)!;
const ALPHA = "alpha\n" + FENCE + "\nomega";
const OPEN = ALPHA.indexOf("```mermaid");
const END = OPEN + FENCE.length;
const alpha = (): SnapshotItem => assistant("a", ALPHA);
const WARN_BODY = "flowchart TD\n  A --> B\n  --> C\n  --> D";

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
		assert.equal(layoutOf({ items, expanded: folded.expanded, sourceFences: folded.sourceFences }, 40), first);
		assert.notEqual(layoutOf(folded, 20), first);
		assert.deepEqual(rowTexts(layoutOf(doc(items, ["t"]), 40)), ["<header:u>", "hi", "<header:t>", "line 1", "line 2"]);
	});

	it("keys the cache on sourceFences identity and width", () => {
		const layoutOf = layoutCache(visibleWidth);
		const items = [assistant("a", FENCE)];
		const expanded = new Set<string>();
		const fences = new Set([fenceKey("a", 0)]);
		const shown: Doc = { items, expanded, sourceFences: fences };
		const first = layoutOf(shown, 40);
		assert.equal(first.rows.some((row) => row.type === "diagram"), false);
		assert.equal(layoutOf({ items, expanded, sourceFences: fences }, 40), first);
		assert.notEqual(layoutOf({ items, expanded, sourceFences: new Set() }, 40), first);
		assert.equal(layoutOf({ items, expanded, sourceFences: new Set() }, 40).rows.some((row) => row.type === "diagram"), true);
		assert.notEqual(layoutOf(shown, 12), first);
	});
});

describe("mermaid layout", () => {
	it("renders user and assistant mermaid fences as rows equal to render(body).plain", () => {
		const rows = laid([user("u", FENCE), assistant("a", FENCE)]);
		const diagrams = rows.rows.filter((row) => row.type === "diagram");
		assert.deepEqual(diagrams.map((row) => row.spans.map((span) => span.text).join("")), [...ART.plain, ...ART.plain]);
		assert.deepEqual(diagrams.slice(0, ART.plain.length).map((row) => row.spans), ART.styled);
		assert.deepEqual(diagrams.map((row) => row.line), [...ART.plain.keys(), ...ART.plain.keys()]);
		assert.deepEqual(
			diagrams.map((row) => [row.itemId, row.open, row.end]),
			ART.plain.map(() => ["u", 0, FENCE.length]).concat(ART.plain.map(() => ["a", 0, FENCE.length])),
		);
	});

	it("keeps a mermaid fence in tool output as raw text", () => {
		assert.deepEqual(rowTexts(laid([tool("t", FENCE)], 40, ["t"])), ["<header:t>", "```mermaid", "flowchart TD", "  A[Start] --> B[End]", "```"]);
	});

	it("falls back to source rows when render returns null", () => {
		const text = "```mermaid\nnot a diagram\n```";
		assert.equal(render("not a diagram"), null);
		assert.deepEqual(rowTexts(laid([assistant("a", text)])), ["<header:a>", "```mermaid", "not a diagram", "```"]);
	});

	it("shows the source and one notice row when render warns", () => {
		const text = "```mermaid\n" + WARN_BODY + "\n```";
		assert.deepEqual(rowTexts(laid([assistant("a", text)])), [
			"<header:a>",
			"```mermaid",
			"flowchart TD",
			"  A --> B",
			"  --> C",
			"  --> D",
			"```",
			'<notice:Mermaid diagram not rendered: dropped, does not start with a node: "--> C" (+1 more)>',
		]);
	});

	it("omits the (+N more) suffix for a single warning", () => {
		const text = "```mermaid\nflowchart TD\n  A --> B\n  --> C\n```";
		assert.deepEqual(rowTexts(laid([assistant("a", text)])).at(-1), '<notice:Mermaid diagram not rendered: dropped, does not start with a node: "--> C">');
	});

	it("falls back below the art width and renders again once it fits", () => {
		assert.equal(ART.width, 10);
		const narrow = laid([assistant("a", FENCE)], 11);
		assert.equal(narrow.rows.some((row) => row.type === "diagram"), false);
		const source = narrow.rows.filter((row) => row.type === "text").map((row) => row.cells.map((cell) => cell.text).join("")).join("");
		assert.equal(source, FENCE.replace(/\n/g, ""));
		const wide = laid([assistant("a", FENCE)], 12);
		assert.equal(wide.rows.filter((row) => row.type === "diagram").length, ART.plain.length);
	});

	it("shows source rows when the block's key is in sourceFences", () => {
		const rows = laid([assistant("a", FENCE)], 40, [], [fenceKey("a", 0)]);
		assert.deepEqual(rowTexts(rows), ["<header:a>", "```mermaid", "flowchart TD", "  A[Start] --> B[End]", "```"]);
	});

	it("only renders closed mermaid fences and matches the info word case-insensitively", () => {
		const open = "```mermaid\n" + FLOW;
		assert.deepEqual(rowTexts(laid([assistant("a", open)])), ["<header:a>", "```mermaid", "flowchart TD", "  A[Start] --> B[End]"]);
		const upper = "```Mermaid\n" + FLOW + "\n```";
		assert.equal(laid([assistant("a", upper)]).rows.filter((row) => row.type === "diagram").length, ART.plain.length);
	});
});

describe("mermaid coordinates", () => {
	it("round-trips every diagram and notice row through positionAt and locate", () => {
		const items = [assistant("a", FENCE + "\ntail"), assistant("b", "```mermaid\n" + WARN_BODY + "\n```")];
		const rows = laid(items);
		rows.rows.forEach((_, row) => {
			const pos = positionAt(rows, row, 0)!;
			assert.deepEqual(locate(rows, pos), { row, col: 0 }, `row ${row}`);
		});
		assert.equal(rows.rows.at(-1)!.type, "notice");
	});

	it("locates a plain offset inside a rendered block on its first row", () => {
		const rows = laid([alpha()]);
		assert.deepEqual(locate(rows, at("a", OPEN + 10)), { row: 2, col: 0 });
		assert.deepEqual(positionAt(rows, 2, 0), { itemId: "a", offset: OPEN, diagram: 0 });
	});

	it("clamps a stale diagram line to the block's first row", () => {
		const rows = laid([alpha()]);
		assert.deepEqual(locate(rows, { itemId: "a", offset: OPEN, diagram: 99 }), { row: 2, col: 0 });
	});

	it("drops a stale slot onto the source line when the block is shown as source", () => {
		const rows = laid([alpha()], 40, [], [fenceKey("a", OPEN)]);
		const located = locate(rows, { itemId: "a", offset: OPEN, diagram: 3 })!;
		assert.deepEqual(located, { row: 2, col: 0 });
		assert.deepEqual(positionAt(rows, located.row, 0), at("a", OPEN));
	});

	it("round-trips a notice slot", () => {
		const text = "```mermaid\n" + WARN_BODY + "\n```";
		const rows = laid([assistant("a", text)]);
		const last = rows.rows.length - 1;
		assert.deepEqual(positionAt(rows, last, 0), { itemId: "a", offset: 0, notice: true });
		assert.deepEqual(locate(rows, { itemId: "a", offset: 0, notice: true }), { row: last, col: 0 });
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

describe("mermaid motions", () => {
	it("steps j and k through diagram rows and restores goalX on the line after the block", () => {
		const items = [alpha()];
		let result = move(doc(items), laid(items), at("a", 4), 4, "down");
		assert.deepEqual(result, { pos: { itemId: "a", offset: OPEN, diagram: 0 }, goalX: 4 });
		for (let line = 1; line < ART.plain.length; line++) {
			result = move(doc(items), laid(items), result.pos, result.goalX, "down");
			assert.deepEqual(result.pos, { itemId: "a", offset: OPEN, diagram: line });
		}
		result = move(doc(items), laid(items), result.pos, result.goalX, "down");
		assert.deepEqual(result, { pos: at("a", END + 5), goalX: 4 });
		assert.deepEqual(move(doc(items), laid(items), result.pos, result.goalX, "up"), { pos: { itemId: "a", offset: OPEN, diagram: ART.plain.length - 1 }, goalX: 4 });
	});

	it("pages through diagram rows", () => {
		const items = [alpha()];
		const page = move(doc(items), laid(items), { itemId: "a", offset: OPEN, diagram: 1 }, 4, "pageDown", 5);
		assert.deepEqual(page, { pos: { itemId: "a", offset: OPEN, diagram: 4 }, goalX: 4 });
		assert.deepEqual(move(doc(items), laid(items), page.pos, page.goalX, "halfPageUp", 5), { pos: { itemId: "a", offset: OPEN, diagram: 2 }, goalX: 4 });
	});

	it("moves h and l to the stops before and after the block", () => {
		const items = [alpha()];
		const rows = laid(items);
		const middle = { itemId: "a", offset: OPEN, diagram: 3 };
		assert.deepEqual(move(doc(items), rows, middle, 0, "left").pos, at("a", OPEN - 1));
		assert.deepEqual(move(doc(items), rows, middle, 0, "right").pos, at("a", END + 1));
	});

	it("treats the block as one word for w, b and e", () => {
		const items = [alpha()];
		assert.deepEqual(step(items, at("a", 4), "wordForward").pos, { itemId: "a", offset: OPEN, diagram: 0 });
		assert.deepEqual(step(items, { itemId: "a", offset: OPEN, diagram: 0 }, "wordForward").pos, at("a", END + 1));
		assert.deepEqual(step(items, at("a", END + 3), "wordBackward").pos, at("a", END + 1));
		assert.deepEqual(step(items, at("a", END + 1), "wordBackward").pos, { itemId: "a", offset: OPEN, diagram: 0 });
		assert.deepEqual(step(items, { itemId: "a", offset: OPEN, diagram: 0 }, "wordBackward").pos, at("a", 0));
		assert.deepEqual(step(items, at("a", 4), "wordEnd").pos, { itemId: "a", offset: OPEN, diagram: ART.plain.length - 1 });
		assert.deepEqual(step(items, { itemId: "a", offset: OPEN, diagram: ART.plain.length - 1 }, "wordEnd").pos, at("a", END + 5));
	});

	it("keeps 0, ^ and $ on diagram and notice rows", () => {
		const slot = { itemId: "a", offset: OPEN, diagram: 2 };
		assert.deepEqual(step([alpha()], slot, "lineStart").pos, slot);
		assert.deepEqual(step([alpha()], slot, "firstNonBlank").pos, slot);
		assert.deepEqual(step([alpha()], slot, "lineEnd").pos, slot);
		const text = "```mermaid\n" + WARN_BODY + "\n```";
		const notice = { itemId: "a", offset: 0, notice: true as const };
		assert.deepEqual(step([assistant("a", text)], notice, "lineStart").pos, notice);
		assert.deepEqual(step([assistant("a", text)], notice, "lineEnd").pos, notice);
	});

	it("lands G on a final diagram row", () => {
		assert.deepEqual(step([assistant("a", FENCE)], at("a", 0), "docEnd").pos, { itemId: "a", offset: 0, diagram: ART.plain.length - 1 });
	});
});

describe("selection and quotes", () => {
	it("quotes a character selection inclusive of the caret grapheme in both directions", () => {
		const items = [assistant("a", "The cache is LRU.")];
		const forward = selectionRange(doc(items), "char", at("a", 4), at("a", 8), laid(items));
		assert.deepEqual(forward, { start: at("a", 4), end: at("a", 9) });
		assert.equal(quote(doc(items), forward!), "cache");
		const backward = selectionRange(doc(items), "char", at("a", 8), at("a", 4), laid(items));
		assert.deepEqual(backward, { start: at("a", 4), end: at("a", 9) });
	});

	it("quotes whole source lines in line mode", () => {
		const items = [assistant("a", "first line\nsecond line\nthird")];
		const range = selectionRange(doc(items), "line", at("a", 2), at("a", 12), laid(items));
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
		const range = selectionRange(doc(items), "line", at("a", 16), at("a", 39), laid(items));
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

describe("mermaid ranges", () => {
	it("quotes the whole fence for a line range on a diagram row", () => {
		const range = lineRange(doc([alpha()]), { itemId: "a", offset: OPEN, diagram: 3 })!;
		assert.deepEqual(range, { start: at("a", OPEN), end: at("a", END) });
		assert.equal(quote(doc([alpha()]), range), FENCE);
	});

	it("snaps slot endpoints to the whole fence", () => {
		const d = doc([alpha()]);
		const inside = { itemId: "a", offset: OPEN, diagram: 1 };
		const range = selectionRange(d, "char", inside, { itemId: "a", offset: OPEN, diagram: 5 }, laid([alpha()]))!;
		assert.deepEqual(range, { start: at("a", OPEN), end: at("a", END) });
		assert.equal(quote(d, range), FENCE);
		const across = selectionRange(d, "char", at("a", 2), inside, laid([alpha()]))!;
		assert.deepEqual(across, { start: at("a", 2), end: at("a", END) });
		assert.equal(quote(d, across), "pha\n" + FENCE);
		const line = selectionRange(d, "line", { itemId: "a", offset: OPEN, diagram: 2 }, { itemId: "a", offset: OPEN, diagram: 6 }, laid([alpha()]))!;
		assert.deepEqual(line, { start: at("a", OPEN), end: at("a", END) });
		assert.equal(quote(d, line), FENCE);
	});

	it("spans the whole fence for a line range on a notice row", () => {
		const text = "```mermaid\n" + WARN_BODY + "\n```";
		const d = doc([assistant("a", text)]);
		const range = lineRange(d, { itemId: "a", offset: 0, notice: true })!;
		assert.deepEqual(range, { start: at("a", 0), end: at("a", text.length) });
		assert.equal(quote(d, range), text);
	});

	it("keeps ordinary character selection inside a source-shown fence", () => {
		const items = [alpha()];
		const range = selectionRange(doc(items), "char", at("a", OPEN), at("a", OPEN + 5), laid(items, 40, [], [fenceKey("a", OPEN)]))!;
		assert.deepEqual(range, { start: at("a", OPEN), end: at("a", OPEN + 6) });
		assert.equal(quote(doc(items), range), "```mer");
	});
});

describe("mermaid selection edges", () => {
	const warnText = "pre\n```mermaid\n" + WARN_BODY + "\n```\npost";
	const warnOpen = warnText.indexOf("```mermaid");
	const warnEnd = warnText.indexOf("\n```\npost") + 4;

	it("ends a selection on a diagram slot exactly at the fence end", () => {
		const items = [alpha()];
		const range = selectionRange(doc(items), "char", at("a", 2), { itemId: "a", offset: OPEN, diagram: 3 }, laid(items))!;
		assert.deepEqual(range, { start: at("a", 2), end: at("a", END) });
		assert.equal(quote(doc(items), range), "pha\n" + FENCE);
	});

	it("quotes exactly the selected text inside the visible source of a warnings fallback", () => {
		const items = [assistant("a", warnText)];
		const head = selectionRange(doc(items), "char", at("a", warnOpen), at("a", warnOpen + 5), laid(items))!;
		assert.deepEqual(head, { start: at("a", warnOpen), end: at("a", warnOpen + 6) });
		assert.equal(quote(doc(items), head), "```mer");
		const body = warnText.indexOf("flowchart");
		const inside = selectionRange(doc(items), "char", at("a", body), at("a", body + 8), laid(items))!;
		assert.deepEqual(inside, { start: at("a", body), end: at("a", body + 9) });
	});

	it("covers the whole fence when a selection ends on the notice slot", () => {
		const items = [assistant("a", warnText)];
		const notice = { itemId: "a", offset: warnOpen, notice: true as const };
		const range = selectionRange(doc(items), "char", at("a", 1), notice, laid(items))!;
		assert.deepEqual(range, { start: at("a", 1), end: at("a", warnEnd) });
		assert.equal(quote(doc(items), range), warnText.slice(1, warnEnd));
	});

	it("takes the union of both endpoint extents when a notice slot is the start", () => {
		const items = [assistant("a", warnText)];
		const notice = { itemId: "a", offset: warnOpen, notice: true as const };
		const body = warnText.indexOf("flowchart");
		const range = selectionRange(doc(items), "char", notice, at("a", body), laid(items))!;
		assert.deepEqual(range, { start: at("a", warnOpen), end: at("a", warnEnd) });
		const closing = warnText.lastIndexOf("```", warnEnd);
		const reversed = selectionRange(doc(items), "char", at("a", closing), notice, laid(items))!;
		assert.deepEqual(reversed, { start: at("a", warnOpen), end: at("a", warnEnd) });
	});

	it("widens an endpoint strictly inside a rendered fence to the whole fence", () => {
		const items = [alpha()];
		const header = selectionRange(doc([assistant("a", FENCE)]), "char", headerAt("a"), headerAt("a"), laid([assistant("a", FENCE)]))!;
		assert.deepEqual(header, { start: at("a", 0), end: at("a", FENCE.length) });
		const lines = selectionRange(doc([assistant("a", FENCE)]), "line", headerAt("a"), headerAt("a"), laid([assistant("a", FENCE)]))!;
		assert.deepEqual(lines, { start: at("a", 0), end: at("a", FENCE.length) });
		const before = selectionRange(doc(items), "char", at("a", 1), at("a", OPEN - 1), laid(items))!;
		assert.deepEqual(before, { start: at("a", 1), end: at("a", OPEN) });
	});

	it("does not report a block at a message header", () => {
		const items = [assistant("a", FENCE)];
		assert.equal(mermaidBlockAt(doc(items), headerAt("a"), laid(items)), undefined);
	});
});

describe("mermaid blocks", () => {
	it("owns the newline after the closing fence and leaves the next line alone", () => {
		const rows = laid([alpha()]);
		const slot = { itemId: "a", offset: OPEN, diagram: 0 };
		assert.deepEqual(normalizePosition(rows, at("a", END)), slot);
		assert.deepEqual(locate(rows, at("a", END)), locate(rows, slot));
		assert.deepEqual(normalizePosition(rows, at("a", END + 1)), at("a", END + 1));
		assert.deepEqual(normalizePosition(rows, at("a", OPEN - 1)), at("a", OPEN - 1));
	});

	it("owns the newline after the closing fence in source mode too", () => {
		const items = [alpha()];
		const shown = laid(items, 40, [], [fenceKey("a", OPEN)]);
		assert.deepEqual(mermaidBlockAt(doc(items), at("a", END), shown), { key: fenceKey("a", OPEN), open: OPEN, end: END, rendered: false });
		assert.equal(mermaidBlockAt(doc(items), at("a", END + 1), shown), undefined);
	});

	it("finds the rendered block key at a source offset or slot", () => {
		const items = [alpha()];
		const rows = laid(items);
		const expected = { key: fenceKey("a", OPEN), open: OPEN, end: END, rendered: true };
		assert.deepEqual(mermaidBlockAt(doc(items), at("a", OPEN + 5), rows), expected);
		assert.deepEqual(mermaidBlockAt(doc(items), { itemId: "a", offset: OPEN, diagram: 2 }, rows), expected);
		assert.equal(mermaidBlockAt(doc(items), at("a", OPEN - 1), rows), undefined);
		assert.equal(mermaidBlockAt(doc([tool("t", FENCE)]), at("t", 0), laid([tool("t", FENCE)])), undefined);
	});

	it("reports a toggled or fallback block as not rendered", () => {
		const items = [alpha()];
		const toggled = laid(items, 40, [], [fenceKey("a", OPEN)]);
		assert.deepEqual(mermaidBlockAt(doc(items), { itemId: "a", offset: OPEN, diagram: 0 }, toggled), { key: fenceKey("a", OPEN), open: OPEN, end: END, rendered: false });
		const items2 = [assistant("a", FENCE)];
		const wide = laid(items2, 11);
		assert.deepEqual(mermaidBlockAt(doc(items2), at("a", 3), wide), { key: fenceKey("a", 0), open: 0, end: FENCE.length, rendered: false });
	});

	it("prunes keys that no longer start a mermaid fence and keeps identity otherwise", () => {
		const items = [alpha()];
		const kept = new Set([fenceKey("a", OPEN)]);
		assert.equal(pruneSourceFences(items, kept), kept);
		const source = new Set([fenceKey("a", OPEN), fenceKey("a", 999), fenceKey("b", 0)]);
		const pruned = pruneSourceFences(items, source);
		assert.notEqual(pruned, source);
		assert.deepEqual([...pruned], [fenceKey("a", OPEN)]);
		assert.deepEqual([...pruneSourceFences([tool("t", FENCE)], new Set([fenceKey("t", 0)]))], []);
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
