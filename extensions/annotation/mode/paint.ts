import { sliceByColumn } from "@earendil-works/pi-tui";
import type { Decorations, RowSpan, RowText, State } from "./data.ts";
import { isImageRow, type Transcript } from "./transcript.ts";

export interface Palette {
	readonly caret: string;
	readonly selected: string;
	readonly noted: string;
}

export interface Run {
	readonly from: number;
	readonly to: number;
	readonly caret: boolean;
	readonly selected: boolean;
	readonly noted: boolean;
}

export interface RowDecorations {
	caret: number | undefined;
	selected: [number, number][];
	noted: [number, number][];
}

type Layer = keyof Palette;

const LAYERS: readonly Layer[] = ["selected", "noted", "caret"];
const CLOSE: Palette = { caret: "\x1b[27m", selected: "\x1b[49m", noted: "\x1b[24m" };
const ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const SGR = /\x1b\[[0-9;:]*m/g;

export function decorationsOf(doc: Transcript, state: State): Decorations {
	const mode = state.mode;
	const row = doc.rowOf(state.caret);
	const browsing = mode.kind === "normal" || mode.kind === "visual";
	let selected: readonly RowSpan[] = [];
	if (mode.kind === "visual") selected = doc.spansBetween(mode.selection.shape, mode.selection.anchor, state.caret);
	else if (mode.kind === "note") selected = doc.liveMarks(mode.draft.marks);
	return {
		caret: browsing && row !== undefined ? { row, char: state.caret.char } : undefined,
		selected,
		noted: doc.liveMarks(state.notebook.notes.flatMap((note) => note.marks)),
	};
}

export function paintRows(rows: readonly string[], doc: Transcript, deco: Decorations, palette: Palette): readonly string[] {
	const byRow = new Map<number, RowDecorations>();
	const entry = (row: number): RowDecorations => {
		let found = byRow.get(row);
		if (!found) {
			found = { caret: undefined, selected: [], noted: [] };
			byRow.set(row, found);
		}
		return found;
	};
	if (deco.caret) entry(deco.caret.row).caret = deco.caret.char;
	for (const span of deco.selected) entry(span.row).selected.push([span.from, span.to]);
	for (const span of deco.noted) entry(span.row).noted.push([span.from, span.to]);
	if (byRow.size === 0) return rows;
	const out = rows.slice();
	for (const [row, rowDeco] of byRow) {
		if (isImageRow(rows[row])) continue;
		const text = doc.text(row);
		out[row] = paintRow(rows[row], text, runsOf(text.glyphs.length, rowDeco), palette);
	}
	return out;
}

export function runsOf(glyphCount: number, deco: RowDecorations): Run[] {
	if (glyphCount === 0) {
		const run = { from: 0, to: 0, caret: deco.caret !== undefined, selected: deco.selected.length > 0, noted: deco.noted.length > 0 };
		return run.caret || run.selected || run.noted ? [run] : [];
	}
	const edges = new Set<number>();
	if (deco.caret !== undefined) edges.add(deco.caret).add(deco.caret + 1);
	for (const [from, to] of [...deco.selected, ...deco.noted]) edges.add(from).add(to);
	const sorted = [...edges].sort((a, b) => a - b);
	const runs: Run[] = [];
	for (let i = 0; i + 1 < sorted.length; i++) {
		const from = sorted[i];
		const to = sorted[i + 1];
		const covers = (spans: [number, number][]) => spans.some(([a, b]) => a <= from && to <= b);
		const run = { from, to, caret: deco.caret === from, selected: covers(deco.selected), noted: covers(deco.noted) };
		if (run.caret || run.selected || run.noted) runs.push(run);
	}
	return runs;
}

export function paintRow(raw: string, text: RowText, runs: readonly Run[], palette: Palette): string {
	const prefix = ZONE_PREFIX.exec(raw)?.[0] ?? "";
	const body = raw.slice(prefix.length);
	let cursor = 0;
	let out = prefix;
	for (const run of runs) {
		const x0 = text.x[run.from];
		const width = Math.max(1, text.x[run.to] - x0);
		const layers = LAYERS.filter((layer) => run[layer]);
		const open = layers.map((layer) => palette[layer]).join("");
		const close = layers.map((layer) => CLOSE[layer]).reverse().join("");
		const piece = sliceByColumn(body, x0, width, true) || " ";
		out += sliceByColumn(body, cursor, x0 - cursor, true) + open + piece.replace(SGR, (code) => code + open) + close;
		cursor = x0 + width;
	}
	return out + sliceByColumn(body, cursor, Number.MAX_SAFE_INTEGER, true);
}
