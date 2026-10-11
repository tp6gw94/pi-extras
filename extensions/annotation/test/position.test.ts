import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boxHeight } from "../box.ts";
import { overlayOptionsFor } from "../index.ts";
import { BOX_MAX_WIDTH, boxPlacement, boxWidth } from "../position.ts";

const screen = { columns: 100, rows: 30 };
const box = { width: 40, height: 7 };

describe("box placement", () => {
	it("goes on the row below the selection, at the release column", () => {
		assert.deepEqual(boxPlacement({ x: 12, y: 5, pressY: 3 }, box, screen), { row: 6, col: 12 });
		assert.deepEqual(boxPlacement({ x: 12, y: 5 }, box, screen), { row: 6, col: 12 });
	});

	it("uses the lower of the press and release rows when the drag went upward", () => {
		assert.deepEqual(boxPlacement({ x: 3, y: 4, pressY: 9 }, box, screen), { row: 10, col: 3 });
	});

	it("fits exactly on the last rows without moving up", () => {
		assert.deepEqual(boxPlacement({ x: 0, y: 22 }, box, screen), { row: 23, col: 0 });
	});

	it("goes above the selection near the bottom", () => {
		assert.deepEqual(boxPlacement({ x: 10, y: 23 }, box, screen), { row: 16, col: 10 });
		assert.deepEqual(boxPlacement({ x: 10, y: 28, pressY: 25 }, box, screen), { row: 18, col: 10 });
		assert.deepEqual(boxPlacement({ x: 10, y: 29 }, box, screen), { row: 22, col: 10 });
	});

	it("clamps to the top when neither below nor above fits", () => {
		assert.deepEqual(boxPlacement({ x: 0, y: 8, pressY: 2 }, { width: 40, height: 25 }, screen), { row: 0, col: 0 });
		assert.deepEqual(boxPlacement({ x: 0, y: 3 }, { width: 40, height: 40 }, screen), { row: 0, col: 0 });
	});

	it("shifts left at the right edge so the whole box stays on screen", () => {
		assert.deepEqual(boxPlacement({ x: 99, y: 5 }, box, screen), { row: 6, col: 60 });
		assert.deepEqual(boxPlacement({ x: 61, y: 5 }, box, screen), { row: 6, col: 60 });
		assert.deepEqual(boxPlacement({ x: 60, y: 5 }, box, screen), { row: 6, col: 60 });
	});

	it("stays at column 0 at the left edge and when the box is as wide as the screen", () => {
		assert.deepEqual(boxPlacement({ x: 0, y: 5 }, box, screen), { row: 6, col: 0 });
		assert.deepEqual(boxPlacement({ x: -3, y: 5 }, box, screen), { row: 6, col: 0 });
		assert.deepEqual(boxPlacement({ x: 30, y: 5 }, { width: 100, height: 7 }, screen), { row: 6, col: 0 });
		assert.deepEqual(boxPlacement({ x: 30, y: 5 }, { width: 120, height: 7 }, screen), { row: 6, col: 0 });
	});

	it("caps the width at 60 columns and never exceeds the screen", () => {
		assert.equal(boxWidth(200), BOX_MAX_WIDTH);
		assert.equal(boxWidth(45), 45);
		assert.equal(boxWidth(0), 1);
	});
});

describe("overlay options", () => {
	it("passes absolute row and col from the release point", () => {
		const text = "one\ntwo";
		assert.deepEqual(overlayOptionsFor({ text, point: { x: 70, y: 3, pressY: 2 } }, { columns: 100, rows: 30 }), {
			width: 60,
			row: 4,
			col: 40,
		});
		assert.equal(boxHeight(text), 7);
		assert.deepEqual(overlayOptionsFor({ text, point: { x: 5, y: 27 } }, { columns: 100, rows: 30 }), { width: 60, row: 20, col: 5 });
	});

	it("falls back to bottom-center without a release point or a screen size", () => {
		assert.deepEqual(overlayOptionsFor({ text: "x" }, { columns: 100, rows: 30 }), { width: 60, anchor: "bottom-center" });
		assert.deepEqual(overlayOptionsFor({ text: "x", point: { x: 1, y: 1 } }, undefined), { width: 60, anchor: "bottom-center" });
	});
});
