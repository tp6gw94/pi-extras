import type { GoalX, Motion, RowChar, Unit } from "./data.ts";
import type { Transcript } from "./transcript.ts";

export interface MoveResult {
	readonly row: number;
	readonly char: number;
	readonly goalX: GoalX;
}

const EMPTY = -1;

export function classOf(glyph: string): number {
	if (/^\s+$/u.test(glyph)) return 0;
	if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(glyph)) return 3;
	if (/[\p{L}\p{N}_]/u.test(glyph)) return 1;
	return 2;
}

export function pageDelta(motion: Motion, pageRows: number): number | undefined {
	switch (motion) {
		case "halfPageDown":
			return Math.max(1, Math.floor(pageRows / 2));
		case "halfPageUp":
			return -Math.max(1, Math.floor(pageRows / 2));
		case "pageDown":
			return Math.max(1, pageRows - 2);
		case "pageUp":
			return -Math.max(1, pageRows - 2);
		default:
			return undefined;
	}
}

export function unitStart(doc: Transcript, unit: Unit): RowChar {
	return { row: unit.firstRow, char: doc.text(unit.firstRow).firstNonBlank };
}

export function move(doc: Transcript, from: RowChar, goalX: GoalX, motion: Motion, count: number | undefined, pageRows: number): MoveResult {
	const times = count ?? 1;
	const lastRow = doc.rowCount - 1;
	const horizontal = (at: RowChar): MoveResult => ({ ...at, goalX: doc.text(at.row).x[at.char] });
	const vertical = (row: number): MoveResult => {
		const target = Math.max(0, Math.min(lastRow, row));
		const char = doc.charAtX(target, goalX === "eol" ? Infinity : goalX);
		return { row: target, char, goalX };
	};
	const toRow = (row: number): MoveResult => {
		const target = Math.max(0, Math.min(lastRow, row));
		return horizontal({ row: target, char: doc.text(target).firstNonBlank });
	};
	const repeat = (step: (at: RowChar) => RowChar): MoveResult => {
		let at = from;
		for (let i = 0; i < times; i++) at = step(at);
		return horizontal(at);
	};
	const page = pageDelta(motion, pageRows);
	if (page !== undefined) return vertical(from.row + page * times);
	switch (motion) {
		case "left":
			return repeat((at) => ({ row: at.row, char: Math.max(0, at.char - 1) }));
		case "right":
			return repeat((at) => ({ row: at.row, char: Math.min(Math.max(0, doc.text(at.row).glyphs.length - 1), at.char + 1) }));
		case "up":
			return vertical(from.row - times);
		case "down":
			return vertical(from.row + times);
		case "lineStart":
			return horizontal({ row: from.row, char: 0 });
		case "firstNonBlank":
			return horizontal({ row: from.row, char: doc.text(from.row).firstNonBlank });
		case "lineEnd":
			return { row: from.row, char: Math.max(0, doc.text(from.row).glyphs.length - 1), goalX: "eol" };
		case "wordForward":
			return repeat((at) => wordForward(doc, at));
		case "wordBackward":
			return repeat((at) => wordBackward(doc, at));
		case "wordEnd":
			return repeat((at) => wordEnd(doc, at));
		case "docStart":
			return toRow(count === undefined ? 0 : count - 1);
		case "docEnd":
			return toRow(count === undefined ? lastRow : count - 1);
		case "unitNext":
			return repeat((at) => unitNext(doc, at));
		case "unitPrevious":
			return repeat((at) => unitPrevious(doc, at));
		default:
			return horizontal(from);
	}
}

interface Step extends RowChar {
	readonly crossed: boolean;
}

function classAt(doc: Transcript, at: RowChar): number {
	const { glyphs } = doc.text(at.row);
	return glyphs.length === 0 ? EMPTY : classOf(glyphs[at.char]);
}

function next(doc: Transcript, at: RowChar): Step | undefined {
	if (at.char + 1 < doc.text(at.row).glyphs.length) return { row: at.row, char: at.char + 1, crossed: false };
	if (at.row + 1 < doc.rowCount) return { row: at.row + 1, char: 0, crossed: true };
	return undefined;
}

function previous(doc: Transcript, at: RowChar): Step | undefined {
	if (at.char > 0) return { row: at.row, char: at.char - 1, crossed: false };
	if (at.row === 0) return undefined;
	const row = at.row - 1;
	return { row, char: Math.max(0, doc.text(row).glyphs.length - 1), crossed: true };
}

function wordForward(doc: Transcript, from: RowChar): RowChar {
	const cls = classAt(doc, from);
	let at: Step = { ...from, crossed: false };
	if (cls > 0) {
		while (true) {
			const step = next(doc, at);
			if (!step) return at;
			at = step;
			if (step.crossed || classAt(doc, step) !== cls) break;
		}
	} else {
		const step = next(doc, at);
		if (!step) return at;
		at = step;
	}
	while (classAt(doc, at) === 0) {
		const step = next(doc, at);
		if (!step) return at;
		at = step;
	}
	return at;
}

function wordEnd(doc: Transcript, from: RowChar): RowChar {
	let at = next(doc, from);
	if (!at) return from;
	while (classAt(doc, at) <= 0) {
		const step = next(doc, at);
		if (!step) return at;
		at = step;
	}
	const cls = classAt(doc, at);
	while (true) {
		const step = next(doc, at);
		if (!step || step.crossed || classAt(doc, step) !== cls) return at;
		at = step;
	}
}

function wordBackward(doc: Transcript, from: RowChar): RowChar {
	let at = previous(doc, from);
	if (!at) return from;
	while (classAt(doc, at) === 0) {
		const step = previous(doc, at);
		if (!step) return from;
		at = step;
	}
	const cls = classAt(doc, at);
	if (cls === EMPTY) return at;
	while (true) {
		const step = previous(doc, at);
		if (!step || step.crossed || classAt(doc, step) !== cls) return at;
		at = step;
	}
}

function unitNext(doc: Transcript, at: RowChar): RowChar {
	const unit = doc.units.find((candidate) => candidate.firstRow > at.row);
	return unit ? unitStart(doc, unit) : at;
}

function unitPrevious(doc: Transcript, at: RowChar): RowChar {
	const current = doc.unitAt(at.row);
	if (current) {
		const start = unitStart(doc, current);
		if (at.row > start.row || (at.row === start.row && at.char > start.char)) return start;
	}
	const before = doc.units.findLast((candidate) => candidate.firstRow < at.row);
	return before ? unitStart(doc, before) : at;
}
