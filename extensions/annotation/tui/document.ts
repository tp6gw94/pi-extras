import { render } from "grok-mermaid";
import type { SnapshotItem } from "../snapshot.ts";
import { fences, mermaidFences, type Fence, type FenceSpan } from "./fences.ts";
import { highlight, type MdStyle } from "./highlight.ts";

export type WidthOf = (text: string) => number;
export type Shape = "char" | "line";
export type DiagramCls = "border" | "text" | "edge" | "edgeLabel" | "title" | "none";

export interface Doc {
	readonly items: readonly SnapshotItem[];
	readonly expanded: ReadonlySet<string>;
	readonly sourceFences: ReadonlySet<string>;
}

export interface Position {
	itemId: string;
	offset: number;
	header?: true;
	diagram?: number;
	notice?: true;
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
	style: MdStyle;
}

export interface DiagramSpan {
	text: string;
	cls: DiagramCls;
}

export interface DiagramRow {
	type: "diagram";
	itemId: string;
	open: number;
	end: number;
	line: number;
	spans: readonly DiagramSpan[];
}

export type Row =
	| { type: "header"; itemId: string }
	| { type: "text"; itemId: string; start: number; cells: readonly Cell[] }
	| DiagramRow
	| { type: "notice"; itemId: string; open: number; end: number; text: string };

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

export function isSlot(pos: Position): boolean {
	return pos.diagram !== undefined || pos.notice === true;
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

function warningText(warnings: readonly string[]): string {
	const extra = warnings.length > 1 ? ` (+${warnings.length - 1} more)` : "";
	return `Mermaid diagram not rendered: ${warnings[0]}${extra}`;
}

export function layout(doc: Doc, width: number, widthOf: WidthOf): Layout {
	const rows: Row[] = [];
	const textWidth = Math.max(1, width - INDENT);
	const emitLine = (itemId: string, lineStart: number, line: string, styles: readonly MdStyle[] | undefined): void => {
		const cells: Cell[] = [];
		for (const { segment, index: at } of segmenter.segment(line)) {
			const offset = lineStart + at;
			const style = styles?.[offset] ?? "plain";
			cells.push({ offset, end: offset + segment.length, text: segment, width: Math.min(textWidth, widthOf(segment)), cls: classOf(segment), style });
		}
		for (const chunk of wrapCells(cells, textWidth)) rows.push({ type: "text", itemId, start: chunk[0]?.offset ?? lineStart, cells: chunk });
	};
	for (const item of doc.items) {
		rows.push({ type: "header", itemId: item.id });
		if (isFolded(doc, item)) continue;
		const lines = item.text.split("\n");
		const offsets: number[] = [];
		let at = 0;
		for (const line of lines) {
			offsets.push(at);
			at += line.length + 1;
		}
		const tool = item.kind === "tool";
		const styles = tool ? undefined : highlight(item.text);
		const blocks = tool ? [] : mermaidFences(item.text);
		const emitFence = (start: number, fence: Fence): number => {
			let end = start;
			while (end < lines.length && offsets[end]! < fence.end) end++;
			const art = render(item.text.slice(fence.contentStart, fence.contentEnd));
			const warning = art && art.warnings.length > 0 ? warningText(art.warnings) : undefined;
			const toggled = doc.sourceFences.has(fenceKey(item.id, fence.open));
			if (art && warning === undefined && !toggled && art.width <= textWidth) {
				art.styled.forEach((spans, line) => rows.push({ type: "diagram", itemId: item.id, open: fence.open, end: fence.end, line, spans }));
			} else {
				for (let i = start; i < end; i++) emitLine(item.id, offsets[i]!, lines[i]!, styles);
				if (warning !== undefined) rows.push({ type: "notice", itemId: item.id, open: fence.open, end: fence.end, text: warning });
			}
			return end;
		};
		let next = 0;
		let index = 0;
		while (index < lines.length) {
			const fence = blocks[next];
			const lineStart = offsets[index]!;
			if (fence && fence.open === lineStart) {
				index = emitFence(index, fence);
				next++;
				continue;
			}
			emitLine(item.id, lineStart, lines[index]!, styles);
			index++;
		}
	}
	return { rows, width };
}

export function layoutCache(widthOf: WidthOf): (doc: Doc, width: number) => Layout {
	let last: { items: readonly SnapshotItem[]; expanded: ReadonlySet<string>; sourceFences: ReadonlySet<string>; width: number; layout: Layout } | undefined;
	return (doc, width) => {
		if (last && last.items === doc.items && last.expanded === doc.expanded && last.sourceFences === doc.sourceFences && last.width === width) return last.layout;
		const next = layout(doc, width, widthOf);
		last = { items: doc.items, expanded: doc.expanded, sourceFences: doc.sourceFences, width, layout: next };
		return next;
	};
}

export function itemOf(doc: Doc, itemId: string): SnapshotItem | undefined {
	return doc.items.find((item) => item.id === itemId);
}

export interface MermaidBlock {
	key: string;
	open: number;
	end: number;
	rendered: boolean;
}

export function mermaidBlockAt(doc: Doc, pos: Position, layout: Layout): MermaidBlock | undefined {
	const item = itemOf(doc, pos.itemId);
	if (!item || item.kind === "tool" || pos.header) return undefined;
	const fence = mermaidFences(item.text).find((candidate) => inFence(candidate, pos.offset));
	if (!fence) return undefined;
	const key = fenceKey(item.id, fence.open);
	const rendered = layout.rows.some((row) => row.type === "diagram" && row.itemId === item.id && row.open === fence.open);
	return { key, open: fence.open, end: fence.end, rendered };
}

export function pruneSourceFences(items: readonly SnapshotItem[], sourceFences: ReadonlySet<string>): ReadonlySet<string> {
	const live = new Set<string>();
	for (const item of items) {
		if (item.kind === "tool") continue;
		for (const fence of mermaidFences(item.text)) live.add(fenceKey(item.id, fence.open));
	}
	const kept = [...sourceFences].filter((key) => live.has(key));
	return kept.length === sourceFences.size ? sourceFences : new Set(kept);
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

function inFence(fence: FenceSpan, offset: number): boolean {
	return fence.open <= offset && offset <= fence.end;
}

function slotFence(doc: Doc, pos: Position): FenceSpan | undefined {
	const item = isSlot(pos) ? itemOf(doc, pos.itemId) : undefined;
	return item && mermaidFences(item.text).find((fence) => fence.open === pos.offset);
}

export function fenceKey(itemId: string, open: number): string {
	return `${itemId}:${open}`;
}

export function fenceLang(text: string, start: number, end: number): string | undefined {
	return fences(text).find((fence) => start >= fence.contentStart && end <= fence.contentEnd)?.lang;
}

export function locate(layout: Layout, pos: Position): ScreenPos | undefined {
	const headerRow = layout.rows.findIndex((row) => row.type === "header" && row.itemId === pos.itemId);
	if (headerRow < 0) return undefined;
	if (pos.header) return { row: headerRow, col: 0 };
	if (pos.notice) {
		const notice = layout.rows.findIndex((row) => row.type === "notice" && row.itemId === pos.itemId && row.open === pos.offset);
		if (notice >= 0) return { row: notice, col: 0 };
	} else if (pos.diagram !== undefined) {
		const exact = layout.rows.findIndex((row) => row.type === "diagram" && row.itemId === pos.itemId && row.open === pos.offset && row.line === pos.diagram);
		const line = exact >= 0 ? exact : layout.rows.findIndex((row) => row.type === "diagram" && row.itemId === pos.itemId && row.open === pos.offset);
		if (line >= 0) return { row: line, col: 0 };
	}
	const block = layout.rows.findIndex((row) => row.type === "diagram" && row.itemId === pos.itemId && inFence(row, pos.offset));
	if (block >= 0) return { row: block, col: 0 };
	let found = headerRow;
	for (let i = headerRow + 1; i < layout.rows.length; i++) {
		const row = layout.rows[i]!;
		if (row.itemId !== pos.itemId) break;
		if (row.type === "text" && row.start <= pos.offset) found = i;
	}
	const row = layout.rows[found]!;
	if (row.type !== "text") return { row: found, col: 0 };
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
	if (found.type === "diagram") return { itemId: found.itemId, offset: found.open, diagram: found.line };
	if (found.type === "notice") return { itemId: found.itemId, offset: found.open, notice: true };
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
	diagram?: number;
	notice?: boolean;
	block?: string;
}

function stops(layout: Layout): Stop[] {
	const out: Stop[] = [];
	let previous: Row | undefined;
	for (const row of layout.rows) {
		const lineEnd = previous?.type === "text" && previous.itemId === row.itemId ? previous.cells.at(-1)?.end : undefined;
		const continues = row.type === "text" && lineEnd === row.start;
		if (lineEnd !== undefined && !continues) out.push({ itemId: row.itemId, offset: lineEnd, cls: 0, virtual: false, header: false });
		if (row.type === "header") {
			out.push({ itemId: row.itemId, offset: 0, cls: 0, virtual: false, header: true });
		} else if (row.type === "diagram") {
			out.push({ itemId: row.itemId, offset: row.open, cls: EMPTY, virtual: false, header: false, diagram: row.line, block: fenceKey(row.itemId, row.open) });
		} else if (row.type === "notice") {
			out.push({ itemId: row.itemId, offset: row.open, cls: EMPTY, virtual: false, header: false, notice: true, block: fenceKey(row.itemId, row.open) });
		} else {
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
		stops.findIndex(
			(stop) =>
				stop.itemId === pos.itemId &&
				stop.offset === pos.offset &&
				!stop.virtual &&
				stop.header === (pos.header === true) &&
				stop.diagram === pos.diagram &&
				(stop.notice === true) === (pos.notice === true),
		),
	);
}

function land(stops: readonly Stop[], index: number): Position {
	let at = Math.max(0, Math.min(stops.length - 1, index));
	while (at > 0 && stops[at]!.virtual) at--;
	const stop = stops[at]!;
	if (stop.header) return headerAt(stop.itemId);
	if (stop.diagram !== undefined) return { itemId: stop.itemId, offset: stop.offset, diagram: stop.diagram };
	if (stop.notice) return { itemId: stop.itemId, offset: stop.offset, notice: true };
	return { itemId: stop.itemId, offset: stop.offset };
}

function wordForward(layout: Layout, pos: Position): Position {
	const list = stops(layout);
	const index = stopIndex(list, pos);
	const stop = list[index];
	const cls = stop?.cls ?? 0;
	let at = index;
	if (cls > 0) {
		while (at < list.length && list[at]!.cls === cls) at++;
	} else if (cls === EMPTY) {
		at++;
		if (stop?.block !== undefined) while (at < list.length && list[at]!.block === stop.block) at++;
	}
	while (at < list.length && list[at]!.cls === 0) at++;
	return land(list, at < list.length ? at : list.length - 1);
}

function wordEnd(layout: Layout, pos: Position): Position {
	const list = stops(layout);
	let at = stopIndex(list, pos) + 1;
	while (at < list.length && list[at]!.cls <= 0) {
		const stop = list[at]!;
		if (stop.block !== undefined) {
			while (at + 1 < list.length && list[at + 1]!.block === stop.block) at++;
			break;
		}
		at++;
	}
	if (at >= list.length) return land(list, list.length - 1);
	const cls = list[at]!.cls;
	if (cls > 0) while (at + 1 < list.length && list[at + 1]!.cls === cls) at++;
	return land(list, at);
}

function wordBackward(layout: Layout, pos: Position): Position {
	const list = stops(layout);
	const index = stopIndex(list, pos);
	const current = list[index];
	let at = index - 1;
	if (current?.block !== undefined) while (at >= 0 && list[at]!.block === current.block) at--;
	while (at >= 0 && list[at]!.cls === 0) at--;
	if (at < 0) return land(list, 0);
	const stop = list[at]!;
	if (stop.block !== undefined) while (at > 0 && list[at - 1]!.block === stop.block) at--;
	const cls = list[at]!.cls;
	if (cls !== EMPTY) while (at > 0 && list[at - 1]!.cls === cls) at--;
	return land(list, at);
}

export function normalizePosition(layout: Layout, pos: Position): Position {
	if (pos.header) return pos;
	const at = locate(layout, pos);
	if (!at) return pos;
	if (!isSlot(pos) && layout.rows[at.row]!.type !== "diagram") return pos;
	return positionAt(layout, at.row, 0)!;
}

function stepPosition(doc: Doc, pos: Position, direction: 1 | -1): Position | undefined {
	const index = doc.items.findIndex((item) => item.id === pos.itemId);
	if (index < 0) return undefined;
	const item = doc.items[index]!;
	if (direction > 0) {
		if (isFolded(doc, item)) {
			const after = doc.items[index + 1];
			return after ? { itemId: after.id, offset: 0 } : undefined;
		}
		if (pos.header) return { itemId: item.id, offset: 0 };
		const next = graphemeEnd(item.text, pos.offset);
		if (next < item.text.length) return { itemId: item.id, offset: next };
		const after = doc.items[index + 1];
		return after ? { itemId: after.id, offset: 0 } : undefined;
	}
	if (!isFolded(doc, item) && pos.offset > 0) return { itemId: item.id, offset: graphemeStart(item.text, pos.offset) };
	const before = doc.items[index - 1];
	if (!before) return undefined;
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
	const step = (direction: 1 | -1): MoveResult => {
		const fence = slotFence(doc, pos);
		const from = fence ? { itemId: pos.itemId, offset: direction < 0 && !pos.notice ? fence.open : fence.end } : pos;
		const stepped = stepPosition(doc, from, direction);
		return horizontal(stepped ? normalizePosition(layout, stepped) : pos);
	};
	if ((pos.header || isSlot(pos)) && (motion === "lineStart" || motion === "firstNonBlank" || motion === "lineEnd")) return horizontal(pos);
	switch (motion) {
		case "left":
			return step(-1);
		case "right":
			return step(1);
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
			const last = layout.rows.length - 1;
			const row = layout.rows[last];
			if (!row) return { pos, goalX };
			if (row.type === "header") return horizontal(headerAt(row.itemId));
			if (row.type === "diagram" || row.type === "notice") {
				const target = positionAt(layout, last, 0);
				return target ? horizontal(target) : { pos, goalX };
			}
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

interface Extent {
	itemId: string;
	start: number;
	end: number;
}

function extentOf(doc: Doc, shape: Shape, pos: Position): Extent | undefined {
	const item = itemOf(doc, pos.itemId);
	if (!item) return undefined;
	const fence = slotFence(doc, pos);
	if (fence) return { itemId: item.id, start: fence.open, end: fence.end };
	if (shape === "line") return { itemId: item.id, start: lineStartAt(item.text, pos.offset), end: lineEndAt(item.text, pos.offset) };
	return { itemId: item.id, start: clampOffset(item.text, pos.offset), end: graphemeEnd(item.text, pos.offset) };
}

export function selectionRange(doc: Doc, shape: Shape, anchor: Position, caret: Position, canvas: Layout): Range | undefined {
	const a = extentOf(doc, shape, anchor);
	const b = extentOf(doc, shape, caret);
	if (!a || !b) return undefined;
	const itemIndex = (extent: Extent) => doc.items.findIndex((item) => item.id === extent.itemId);
	const [first, last] = (itemIndex(a) - itemIndex(b) || a.start - b.start) <= 0 ? [a, b] : [b, a];
	const start = first.start;
	const end = first.itemId === last.itemId ? Math.max(first.end, last.end) : last.end;
	const around = (itemId: string, offset: number) => canvas.rows.find((row): row is DiagramRow => row.type === "diagram" && row.itemId === itemId && row.open < offset && offset < row.end);
	return {
		start: { itemId: first.itemId, offset: around(first.itemId, start)?.open ?? start },
		end: { itemId: last.itemId, offset: around(last.itemId, end)?.end ?? end },
	};
}

export function lineRange(doc: Doc, pos: Position): Range | undefined {
	const item = itemOf(doc, pos.itemId);
	if (!item) return undefined;
	const fence = slotFence(doc, pos);
	if (fence) return { start: { itemId: item.id, offset: fence.open }, end: { itemId: item.id, offset: fence.end } };
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
