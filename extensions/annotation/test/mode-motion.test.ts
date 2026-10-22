import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GoalX, Motion, RowChar } from "../mode/data.ts";
import { move, pageDelta } from "../mode/motion.ts";
import type { Transcript } from "../mode/transcript.ts";
import { assistant, markdown, spacer, transcript, user } from "./mode-fixtures.ts";

const at = (row: number, char: number): RowChar => ({ row, char });
const step = (doc: Transcript, from: RowChar, motion: Motion, goalX: GoalX = 0, count?: number, pageRows = 10) => move(doc, from, goalX, motion, count, pageRows);
const walk = (doc: Transcript, from: RowChar, motion: Motion, times: number): RowChar[] => {
	const seen: RowChar[] = [];
	let current = from;
	let goalX: GoalX = doc.text(from.row).x[from.char];
	for (let i = 0; i < times; i++) {
		const result = step(doc, current, motion, goalX);
		current = at(result.row, result.char);
		goalX = result.goalX;
		seen.push(current);
	}
	return seen;
};
const rowOf = (doc: Transcript, needle: string): number => [...doc.rows.keys()].find((row) => doc.text(row).text.includes(needle))!;

describe("character and line motions", () => {
	it("steps by grapheme inside the row and stops at both ends", () => {
		const doc = transcript([markdown("日本x")], 20);
		assert.deepEqual(walk(doc, at(0, 0), "right", 4), [at(0, 1), at(0, 2), at(0, 3), at(0, 3)]);
		assert.deepEqual(walk(doc, at(0, 3), "left", 4), [at(0, 2), at(0, 1), at(0, 0), at(0, 0)]);
		assert.deepEqual(step(doc, at(0, 1), "right"), { row: 0, char: 2, goalX: 3 });
	});

	it("keeps the display column through j and k and lands on the glyph that covers it", () => {
		const doc = transcript([markdown("日本語 text"), markdown("abcdefgh")], 20);
		const up = step(doc, at(1, 4), "up", 4);
		assert.deepEqual(up, { row: 0, char: 2, goalX: 4 });
		assert.deepEqual(step(doc, at(up.row, up.char), "down", up.goalX), { row: 1, char: 4, goalX: 4 });
		assert.deepEqual(step(doc, at(1, 7), "up", 7), { row: 0, char: 4, goalX: 7 });
		assert.deepEqual(step(doc, at(0, 0), "up", 0), { row: 0, char: 0, goalX: 0 });
		assert.deepEqual(step(doc, at(1, 0), "down", 0), { row: 1, char: 0, goalX: 0 });
	});

	it("goes to the padding with 0, the first glyph with ^ and sets an end-of-line goal with $", () => {
		const doc = transcript([markdown("alpha beta"), markdown("gamma delta epsilon")], 30);
		assert.deepEqual(step(doc, at(0, 5), "lineStart"), { row: 0, char: 0, goalX: 0 });
		assert.deepEqual(step(doc, at(0, 5), "firstNonBlank"), { row: 0, char: 1, goalX: 1 });
		const end = step(doc, at(0, 5), "lineEnd");
		assert.deepEqual(end, { row: 0, char: 10, goalX: "eol" });
		assert.deepEqual(step(doc, at(end.row, end.char), "down", end.goalX), { row: 1, char: 19, goalX: "eol" });
	});

	it("rests on a blank row at char 0 and keeps the goal column across it", () => {
		const doc = transcript([markdown("abcdef"), spacer(1), markdown("abcdef")], 20);
		assert.deepEqual(walk(doc, at(0, 4), "down", 2).map((position) => position.char), [0, 4]);
		assert.deepEqual(step(doc, at(1, 0), "lineEnd"), { row: 1, char: 0, goalX: "eol" });
		assert.deepEqual(step(doc, at(1, 0), "right"), { row: 1, char: 0, goalX: 0 });
	});
});

describe("word motions", () => {
	const words = () => transcript([markdown("alpha beta.gamma\n\ndelta")], 30);

	it("moves w through word and punctuation classes, stops on blank rows and crosses row padding", () => {
		const doc = words();
		assert.deepEqual(walk(doc, at(0, 1), "wordForward", 6), [at(0, 7), at(0, 11), at(0, 12), at(1, 0), at(2, 1), at(2, 5)]);
	});

	it("moves e to word ends and skips blank rows", () => {
		const doc = words();
		assert.deepEqual(walk(doc, at(0, 1), "wordEnd", 5), [at(0, 5), at(0, 10), at(0, 11), at(0, 16), at(2, 5)]);
	});

	it("moves b to word starts, stops on blank rows and stays at the first word", () => {
		const doc = words();
		assert.deepEqual(walk(doc, at(2, 3), "wordBackward", 6), [at(2, 1), at(1, 0), at(0, 12), at(0, 11), at(0, 7), at(0, 1)]);
		assert.deepEqual(step(doc, at(0, 1), "wordBackward"), { row: 0, char: 1, goalX: 1 });
	});

	it("treats CJK runs as their own word class and ZWJ emoji as single glyphs", () => {
		const doc = transcript([markdown("中文abc 日本 👨‍👩‍👧x")], 30);
		assert.deepEqual(walk(doc, at(0, 1), "wordForward", 4), [at(0, 3), at(0, 7), at(0, 10), at(0, 11)]);
		assert.deepEqual(step(doc, at(0, 10), "wordForward").goalX, doc.text(0).x[11]);
	});

	it("repeats a counted motion", () => {
		const doc = words();
		const thrice = step(doc, at(0, 1), "wordForward", 0, 3);
		assert.deepEqual(at(thrice.row, thrice.char), walk(doc, at(0, 1), "wordForward", 3)[2]);
	});
});

describe("document and unit motions", () => {
	const chat = () => transcript([spacer(1), user("question"), assistant("answer\n\nmore text"), spacer(1)], 24);

	it("lands gg and G on the first non-blank glyph of the first and last rows, and N G on row N", () => {
		const doc = chat();
		assert.deepEqual(step(doc, at(5, 3), "docStart"), { row: 0, char: 0, goalX: 0 });
		assert.deepEqual(step(doc, at(1, 0), "docEnd"), { row: doc.rowCount - 1, char: 0, goalX: 0 });
		const answer = rowOf(doc, "answer");
		assert.deepEqual(step(doc, at(0, 0), "docEnd", 0, answer + 1), { row: answer, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(0, 0), "docStart", 0, answer + 1), { row: answer, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(0, 0), "docEnd", 0, 999).row, doc.rowCount - 1);
	});

	it("jumps } to the next unit start and { back to the current or previous unit start", () => {
		const doc = chat();
		const question = rowOf(doc, "question");
		const answer = rowOf(doc, "answer");
		assert.deepEqual(step(doc, at(0, 0), "unitNext"), { row: question, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(question, 1), "unitNext"), { row: answer, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(answer, 1), "unitNext"), { row: answer, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(answer + 2, 3), "unitPrevious"), { row: answer, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(answer, 1), "unitPrevious"), { row: question, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(question, 1), "unitPrevious"), { row: question, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(doc.rowCount - 1, 0), "unitPrevious"), { row: answer, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(question, 1), "unitNext", 0, 5).row, answer);
	});

	it("moves by half and full pages derived from the viewport height and clamps at the edges", () => {
		const rows = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("  \n");
		const doc = transcript([markdown(rows)], 30);
		assert.equal(pageDelta("halfPageDown", 10), 5);
		assert.equal(pageDelta("pageUp", 10), -8);
		assert.equal(pageDelta("halfPageUp", 1), -1);
		assert.equal(pageDelta("down", 10), undefined);
		assert.deepEqual(step(doc, at(3, 1), "halfPageDown", 1, undefined, 10), { row: 8, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(3, 1), "pageUp", 1, undefined, 10), { row: 0, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(3, 1), "pageDown", 1, 2, 10), { row: 19, char: 1, goalX: 1 });
		assert.deepEqual(step(doc, at(doc.rowCount - 2, 1), "pageDown", 1, undefined, 10).row, doc.rowCount - 1);
	});
});
