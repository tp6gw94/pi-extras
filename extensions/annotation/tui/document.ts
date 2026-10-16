import type { SnapshotItem } from "../snapshot.ts";

export type WidthOf = (text: string) => number;
export type Shape = "char" | "line";

export interface Doc {
	readonly items: readonly SnapshotItem[];
	readonly expanded: ReadonlySet<string>;
}

export interface Position {
	itemId: string;
	offset: number;
	header?: true;
}

export interface Span {
	itemId: string;
	start: number;
	end: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Cell {
	offset: number;
	end: number;
	text: string;
	width: number;
	cls: number;
}

export type Row =
	| { type: "header"; itemId: string }
	| { type: "text"; itemId: string; start: number; cells: readonly Cell[] };

export interface Layout {
	rows: readonly Row[];
	width: number;
}

export interface ScreenPos {
	row: number;
	col: number;
}

export interface MoveResult {
	pos: Position;
	goalX: number;
}

export type Motion =
	| "left"
	| "right"
	| "up"
	| "down"
	| "wordForward"
	| "wordBackward"
	| "wordEnd"
	| "lineStart"
	| "firstNonBlank"
	| "lineEnd"
	| "docStart"
	| "docEnd"
	| "itemNext"
	| "itemPrevious"
	| "halfPageDown"
	| "halfPageUp"
	| "pageDown"
	| "pageUp";

export const INDENT = 2;

export function headerAt(itemId: string): Position {
	return { itemId, offset: 0, header: true };
}
const EMPTY = -1;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function classOf(grapheme: string): number {
	if (/^\s+$/u.test(grapheme)) return 0;
	if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(grapheme)) return 3;
	if (/[\p{L}\p{N}_]/u.test(grapheme)) return 1;
	return 2;
}

function wrapCells(cells: readonly Cell[], width: number): Cell[][] {
	const rows: Cell[][] = [];
	let row: Cell[] = [];
	let used = 0;
	for (const cell of cells) {
		while (used + cell.width > width && row.length > 0) {
			let space = -1;
			for (let i = row.length - 1; i >= 0; i--) {
				if (row[i]!.cls === 0) {
					space = i;
					break;
				}
			}
			if (cell.cls !== 0 && space >= 0 && space < row.length - 1) {
				rows.push(row.slice(0, space + 1));
				row = row.slice(space + 1);
			} else {
				rows.push(row);
				row = [];
			}
			used = row.reduce((sum, entry) => sum + entry.width, 0);
		}
		row.push(cell);
		used += cell.width;
	}
	rows.push(row);
	return rows;
}

export function isFolded(doc: Doc, item: SnapshotItem): boolean {
	return item.kind === "tool" && !doc.expanded.has(item.id);
}

export function settle(doc: Doc, pos: Position): Position {
	const item = itemOf(doc, pos.itemId);
	return item && isFolded(doc, item) ? headerAt(item.id) : pos;
}

export function startOf(doc: Doc, item: SnapshotItem): Position {
	return settle(doc, { itemId: item.id, offset: 0 });
}

export function layout(doc: Doc, width: number, widthOf: WidthOf): Layout {
	const rows: Row[] = [];
	const textWidth = Math.max(1, width - INDENT);
	for (const item of doc.items) {
		rows.push({ type: "header", itemId: item.id });
		if (isFolded(doc, item)) continue;
		let lineStart = 0;
		for (const line of item.text.split("\n")) {
			const cells: Cell[] = [];
			for (const { segment, index: at } of segmenter.segment(line)) {
				const offset = lineStart + at;
				cells.push({ offset, end: offset + segment.length, text: segment, width: Math.min(textWidth, widthOf(segment)), cls: classOf(segment) });
			}
			for (const chunk of wrapCells(cells, textWidth)) rows.push({ type: "text", itemId: item.id, start: chunk[0]?.offset ?? lineStart, cells: chunk });
			lineStart += line.length + 1;
		}
	}
	return { rows, width };
}

export function layoutCache(widthOf: WidthOf): (doc: Doc, width: number) => Layout {
	let last: { items: readonly SnapshotItem[]; expanded: ReadonlySet<string>; width: number; layout: Layout } | undefined;
	return (doc, width) => {
		if (last && last.items === doc.items && last.expanded === doc.expanded && last.width === width) return last.layout;
		const next = layout(doc, width, widthOf);
		last = { items: doc.items, expanded: doc.expanded, width, layout: next };
		return next;
	};
}

export function itemOf(doc: Doc, itemId: string): SnapshotItem | undefined {
	return doc.items.find((item) => item.id === itemId);
}

export function lineStartAt(text: string, offset: number): number {
	return offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

export function lineEndAt(text: string, offset: number): number {
	const end = text.indexOf("\n", offset);
	return end < 0 ? text.length : end;
}

export function clampOffset(text: string, offset: number): number {
	if (offset <= 0) return 0;
	if (offset >= text.length) return text.length;
	let at = 0;
	for (const { index } of segmenter.segment(text)) {
		if (index > offset) break;
		at = index;
	}
	return at;
}

export function graphemeEnd(text: string, offset: number): number {
	for (const { segment, index } of segmenter.segment(text)) {
		if (index + segment.length > offset) return index + segment.length;
	}
	return text.length;
}

function graphemeStart(text: string, offset: number): number {
	let at = 0;
	for (const { segment, index } of segmenter.segment(text)) {
		if (index + segment.length >= offset) return index;
		at = index;
	}
	return at;
}

function lastGraphemeOffset(text: string): number {
	let at = 0;
	for (const { index } of segmenter.segment(text)) at = index;
	return at;
}

export function firstNonBlankOffset(text: string, offset: number): number {
	const start = lineStartAt(text, offset);
	const end = lineEndAt(text, start);
	for (const { segment, index } of segmenter.segment(text)) {
		if (index < start) continue;
		if (index >= end) break;
		if (classOf(segment) !== 0) return index;
	}
	return start;
}

export function fenceLang(text: string, start: number, end: number): string | undefined {
	let open: { char: string; size: number; lang: string; content: number } | undefined;
	let lineStart = 0;
	for (const line of text.split("\n")) {
		const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const lineEnd = lineStart + line.length;
		if (fence && !open) {
			if (!(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
				open = { char: fence[1]![0]!, size: fence[1]!.length, lang: fence[2]!.trim().split(/\s+/)[0] ?? "", content: lineEnd + 1 };
			}
		} else if (fence && open && fence[1]![0] === open.char && fence[1]!.length >= open.size && fence[2]!.trim() === "") {
			if (start >= open.content && end <= lineStart) return open.lang;
			open = undefined;
		}
		lineStart = lineEnd + 1;
	}
	if (open && start >= open.content && end <= text.length) return open.lang;
	return undefined;
}

export function locate(doc: Layout, pos: Position): ScreenPos | undefined {
	const headerRow = doc.rows.findIndex((row) => row.type === "header" && row.itemId === pos.itemId);
	if (headerRow < 0) return undefined;
	if (pos.header) return { row: headerRow, col: 0 };
	let found = headerRow;
	for (let i = headerRow + 1; i < doc.rows.length; i++) {
		const row = doc.rows[i]!;
		if (row.itemId !== pos.itemId || row.type !== "text") break;
		if (row.start <= pos.offset) found = i;
	}
	const row = doc.rows[found]!;
	if (row.type === "header") return { row: found, col: 0 };
	let col = 0;
	row.cells.forEach((cell, index) => {
		if (cell.offset <= pos.offset) col = index;
	});
	return { row: found, col };
}

export function positionAt(layout: Layout, row: number, x: number): Position | undefined {
	const found = layout.rows[row];
	if (!found) return undefined;
	if (found.type === "header") return headerAt(found.itemId);
	let used = 0;
	for (const cell of found.cells) {
		used += cell.width;
		if (used > x) return { itemId: found.itemId, offset: cell.offset };
	}
	const last = found.cells.at(-1);
	return { itemId: found.itemId, offset: last ? last.offset : found.start };
}

export function columnX(layout: Layout, pos: Position): number {
	const at = locate(layout, pos);
	if (!at) return 0;
	const row = layout.rows[at.row];
	if (row?.type !== "text") return 0;
	return row.cells.slice(0, at.col).reduce((sum, cell) => sum + cell.width, 0);
}

interface Stop {
	itemId: string;
	offset: number;
	cls: number;
	virtual: boolean;
	header: boolean;
}

function stops(layout: Layout): Stop[] {
	const out: Stop[] = [];
	let previous: Row | undefined;
	for (const row of layout.rows) {
		if (row.type === "header") {
			out.push({ itemId: row.itemId, offset: 0, cls: 0, virtual: false, header: true });
		} else {
			const continues = previous?.type === "text" && previous.itemId === row.itemId && previous.cells.length > 0 && previous.cells.at(-1)!.end === row.start;
			if (!continues) out.push({ itemId: row.itemId, offset: row.start, cls: 0, virtual: true, header: false });
			if (row.cells.length === 0) out.push({ itemId: row.itemId, offset: row.start, cls: EMPTY, virtual: false, header: false });
			for (const cell of row.cells) out.push({ itemId: row.itemId, offset: cell.offset, cls: cell.cls, virtual: false, header: false });
		}
		previous = row;
	}
	return out;
}

function stopIndex(stops: readonly Stop[], pos: Position): number {
	return Math.max(
		0,
		stops.findIndex((stop) => stop.itemId === pos.itemId && stop.offset === pos.offset && !stop.virtual && stop.header === (pos.header === true)),
	);
}

function land(stops: readonly Stop[], index: number): Position {
	let at = Math.max(0, Math.min(stops.length - 1, index));
	while (at > 0 && stops[at]!.virtual) at--;
	const stop = stops[at]!;
	return stop.header ? headerAt(stop.itemId) : { itemId: stop.itemId, offset: stop.offset };
}

function wordForward(layout: Layout, pos: Position): Position {
	const list = stops(layout);
	const index = stopIndex(list, pos);
	const cls = list[index]?.cls ?? 0;
	let at = index;
	if (cls > 0) {
		while (at < list.length && list[at]!.cls === cls) at++;
	} else if (cls === EMPTY) {
		at++;
	}
	while (at < list.length && list[at]!.cls === 0) at++;
	return land(list, at < list.length ? at : list.length - 1);
}

function wordEnd(layout: Layout, pos: Position): Position {
	const list = stops(layout);
	let at = stopIndex(list, pos) + 1;
	while (at < list.length && list[at]!.cls <= 0) at++;
	if (at >= list.length) return land(list, list.length - 1);
	const cls = list[at]!.cls;
	while (at + 1 < list.length && list[at + 1]!.cls === cls) at++;
	return land(list, at);
}

function wordBackward(layout: Layout, pos: Position): Position {
	const list = stops(layout);
	let at = stopIndex(list, pos) - 1;
	while (at >= 0 && list[at]!.cls === 0) at--;
	if (at < 0) return land(list, 0);
	const cls = list[at]!.cls;
	if (cls !== EMPTY) while (at > 0 && list[at - 1]!.cls === cls) at--;
	return land(list, at);
}

function stepPosition(doc: Doc, pos: Position, direction: 1 | -1): Position {
	const index = doc.items.findIndex((item) => item.id === pos.itemId);
	if (index < 0) return pos;
	const item = doc.items[index]!;
	if (direction > 0) {
		if (isFolded(doc, item)) {
			const after = doc.items[index + 1];
			return after ? { itemId: after.id, offset: 0 } : pos;
		}
		if (pos.header) return { itemId: item.id, offset: 0 };
		const next = graphemeEnd(item.text, pos.offset);
		if (next < item.text.length) return { itemId: item.id, offset: next };
		const after = doc.items[index + 1];
		return after ? { itemId: after.id, offset: 0 } : pos;
	}
	if (!isFolded(doc, item) && pos.offset > 0) return { itemId: item.id, offset: graphemeStart(item.text, pos.offset) };
	const before = doc.items[index - 1];
	if (!before) return pos;
	return { itemId: before.id, offset: isFolded(doc, before) ? 0 : lastGraphemeOffset(before.text) };
}

export function pageScroll(motion: Motion, pageRows: number): number | undefined {
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

function moveRows(layout: Layout, pos: Position, goalX: number, delta: number): MoveResult {
	const at = locate(layout, pos);
	if (!at || layout.rows.length === 0) return { pos, goalX };
	const row = Math.max(0, Math.min(layout.rows.length - 1, at.row + delta));
	return { pos: positionAt(layout, row, goalX) ?? pos, goalX };
}

export function move(doc: Doc, layout: Layout, pos: Position, goalX: number, motion: Motion, pageRows = 10): MoveResult {
	const item = itemOf(doc, pos.itemId);
	if (!item) return { pos, goalX };
	const horizontal = (next: Position): MoveResult => {
		const at = settle(doc, next);
		return { pos: at, goalX: columnX(layout, at) };
	};
	if (pos.header && (motion === "lineStart" || motion === "firstNonBlank" || motion === "lineEnd")) return horizontal(pos);
	switch (motion) {
		case "left":
			return horizontal(stepPosition(doc, pos, -1));
		case "right":
			return horizontal(stepPosition(doc, pos, 1));
		case "up":
			return moveRows(layout, pos, goalX, -1);
		case "down":
			return moveRows(layout, pos, goalX, 1);
		case "halfPageDown":
		case "halfPageUp":
		case "pageDown":
		case "pageUp":
			return moveRows(layout, pos, goalX, pageScroll(motion, pageRows)!);
		case "wordForward":
			return horizontal(wordForward(layout, pos));
		case "wordBackward":
			return horizontal(wordBackward(layout, pos));
		case "wordEnd":
			return horizontal(wordEnd(layout, pos));
		case "lineStart":
			return horizontal({ itemId: item.id, offset: lineStartAt(item.text, pos.offset) });
		case "firstNonBlank": {
			const start = firstNonBlankOffset(item.text, pos.offset);
			return horizontal({ itemId: item.id, offset: start });
		}
		case "lineEnd": {
			const end = lineEndAt(item.text, pos.offset);
			const start = lineStartAt(item.text, pos.offset);
			const offset = end <= start ? start : lastGraphemeOffset(item.text.slice(0, end));
			return horizontal({ itemId: item.id, offset });
		}
		case "docStart": {
			const first = doc.items[0];
			return first ? horizontal(headerAt(first.id)) : { pos, goalX };
		}
		case "docEnd": {
			const row = layout.rows.at(-1);
			if (!row) return { pos, goalX };
			if (row.type === "header") return horizontal(headerAt(row.itemId));
			const target = itemOf(doc, row.itemId);
			return horizontal(target ? { itemId: target.id, offset: firstNonBlankOffset(target.text, row.start) } : { itemId: row.itemId, offset: row.start });
		}
		case "itemNext":
		case "itemPrevious": {
			const index = doc.items.findIndex((candidate) => candidate.id === pos.itemId);
			const next = index + (motion === "itemNext" ? 1 : -1);
			const target = doc.items[next] ?? doc.items[motion === "itemNext" ? doc.items.length - 1 : 0];
			return target ? horizontal(headerAt(target.id)) : { pos, goalX };
		}
	}
}

export function comparePositions(doc: Doc, a: Position, b: Position): number {
	return (
		doc.items.findIndex((item) => item.id === a.itemId) - doc.items.findIndex((item) => item.id === b.itemId) ||
		a.offset - b.offset ||
		Number(!a.header) - Number(!b.header)
	);
}

export function selectionRange(doc: Doc, shape: Shape, anchor: Position, caret: Position): Range | undefined {
	const forward = comparePositions(doc, anchor, caret) <= 0;
	const start = forward ? anchor : caret;
	const end = forward ? caret : anchor;
	const startItem = itemOf(doc, start.itemId);
	const endItem = itemOf(doc, end.itemId);
	if (!startItem || !endItem) return undefined;
	if (shape === "line") {
		return { start: { itemId: start.itemId, offset: lineStartAt(startItem.text, start.offset) }, end: { itemId: end.itemId, offset: lineEndAt(endItem.text, end.offset) } };
	}
	return { start: { itemId: start.itemId, offset: clampOffset(startItem.text, start.offset) }, end: { itemId: end.itemId, offset: graphemeEnd(endItem.text, end.offset) } };
}

export function lineRange(doc: Doc, pos: Position): Range | undefined {
	const item = itemOf(doc, pos.itemId);
	if (!item) return undefined;
	return { start: { itemId: item.id, offset: lineStartAt(item.text, pos.offset) }, end: { itemId: item.id, offset: lineEndAt(item.text, pos.offset) } };
}

export function messageRange(doc: Doc, pos: Position): Range | undefined {
	const item = itemOf(doc, pos.itemId);
	if (!item) return undefined;
	return { start: { itemId: item.id, offset: 0 }, end: { itemId: item.id, offset: item.text.length } };
}

export function spansOf(doc: Doc, range: Range): Span[] {
	const from = doc.items.findIndex((item) => item.id === range.start.itemId);
	const to = doc.items.findIndex((item) => item.id === range.end.itemId);
	if (from < 0 || to < 0 || from > to) return [];
	const spans: Span[] = [];
	for (let i = from; i <= to; i++) {
		const item = doc.items[i]!;
		spans.push({ itemId: item.id, start: i === from ? range.start.offset : 0, end: i === to ? range.end.offset : item.text.length });
	}
	return spans;
}

export function quote(doc: Doc, range: Range, includeFolded = false): string | undefined {
	const from = doc.items.findIndex((item) => item.id === range.start.itemId);
	const to = doc.items.findIndex((item) => item.id === range.end.itemId);
	if (from < 0 || to < 0 || from > to) return undefined;
	const parts: string[] = [];
	for (let i = from; i <= to; i++) {
		const item = doc.items[i]!;
		if (!includeFolded && isFolded(doc, item)) continue;
		const start = i === from ? clampOffset(item.text, range.start.offset) : 0;
		const end = i === to ? clampOffset(item.text, range.end.offset) : item.text.length;
		const part = item.text.slice(start, end);
		if (part.trim() === "") continue;
		if (from === to) {
			const lang = fenceLang(item.text, start, end);
			if (lang !== undefined) return `\`\`\`${lang}\n${part.replace(/\n+$/, "")}\n\`\`\``;
		}
		parts.push(part);
	}
	return parts.length === 0 ? undefined : parts.join("\n\n");
}

export function search(doc: Doc, pos: Position, query: string, direction: 1 | -1): Position | undefined {
	if (query === "") return undefined;
	const sensitive = /\p{Lu}/u.test(query);
	const needle = sensitive ? query : query.toLowerCase();
	const hits: Position[] = [];
	for (const item of doc.items) {
		const text = sensitive ? item.text : item.text.toLowerCase();
		for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) hits.push({ itemId: item.id, offset: at });
	}
	if (hits.length === 0) return undefined;
	if (direction > 0) return hits.find((hit) => comparePositions(doc, hit, pos) > 0) ?? hits[0];
	return hits.findLast((hit) => comparePositions(doc, hit, pos) < 0) ?? hits.at(-1);
}

export function remap(doc: Doc, pos: Position): Position | undefined {
	const item = itemOf(doc, pos.itemId);
	if (!item) return undefined;
	return pos.header ? headerAt(item.id) : { itemId: item.id, offset: clampOffset(item.text, pos.offset) };
}
