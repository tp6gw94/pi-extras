import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Block, BlockId, Capture, CodeRegion, Mark, Place, RowSpan, RowText, Shape, Unit } from "./data.ts";

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const EMPTY_TEXT: RowText = { text: "", glyphs: [], x: [0], firstNonBlank: 0 };
const FENCE_OPEN = /^(\s*(?:│ )*\s*)```([^`]*)$/;

export function isImageRow(raw: string): boolean {
	return raw.includes("\x1b_G") || raw.includes("\x1b]1337;File=");
}

function rowTextOf(raw: string): RowText {
	if (isImageRow(raw)) return EMPTY_TEXT;
	const text = stripTerminalSequences(raw).trimEnd();
	if (text === "") return EMPTY_TEXT;
	const glyphs = [...graphemes.segment(text)].map((segment) => segment.segment);
	const x = [0];
	let column = 0;
	for (const glyph of glyphs) {
		column += visibleWidth(glyph);
		x.push(column);
	}
	return { text, glyphs, x, firstNonBlank: glyphs.findIndex((glyph) => /\S/u.test(glyph)) };
}

export class Transcript {
	readonly width: number;
	readonly rows: readonly string[];
	readonly blocks: readonly Block[];
	private readonly byId = new Map<BlockId, Block>();
	private readonly laid: Block[] = [];
	private readonly texts: (RowText | undefined)[];
	private readonly regions = new Map<BlockId, CodeRegion[]>();
	private unitList: Unit[] | undefined;

	constructor(capture: Capture) {
		this.width = capture.width;
		this.rows = capture.rows;
		let start = 0;
		this.blocks = capture.blocks.map(({ id, height }) => {
			const block = { id, start, height };
			start += height;
			return block;
		});
		for (const block of this.blocks) {
			this.byId.set(block.id, block);
			if (block.height > 0) this.laid.push(block);
		}
		this.texts = new Array(capture.rows.length);
	}

	get rowCount(): number {
		return this.rows.length;
	}

	get units(): readonly Unit[] {
		return (this.unitList ??= this.laid.flatMap((block) => {
			let first = -1;
			let last = -1;
			for (let row = block.start; row < block.start + block.height; row++) {
				if (this.text(row).glyphs.length === 0) continue;
				if (first < 0) first = row;
				last = row;
			}
			return first < 0 ? [] : [{ block: block.id, firstRow: first, lastRow: last }];
		}));
	}

	text(row: number): RowText {
		return (this.texts[row] ??= rowTextOf(this.rows[row]));
	}

	rowOf(place: Place): number | undefined {
		const block = this.byId.get(place.block);
		if (!block || place.line >= block.height) return undefined;
		return block.start + place.line;
	}

	placeAt(row: number, char: number): Place {
		const block = this.blockAt(row);
		const last = Math.max(0, this.text(row).glyphs.length - 1);
		return { block: block.id, line: row - block.start, char: Math.max(0, Math.min(last, char)) };
	}

	settle(place: Place): Place | undefined {
		const block = this.byId.get(place.block);
		if (!block || block.height === 0) return undefined;
		return this.placeAt(block.start + Math.min(place.line, block.height - 1), place.char);
	}

	charAtX(row: number, x: number): number {
		const { x: columns, glyphs } = this.text(row);
		let char = 0;
		while (char + 1 < glyphs.length && columns[char + 1] <= x) char++;
		return char;
	}

	unitAt(row: number): Unit | undefined {
		const id = this.blockAt(row).id;
		return this.units.find((unit) => unit.block === id);
	}

	codeAt(row: number): CodeRegion | undefined {
		const block = this.blockAt(row);
		const regions = this.regions.get(block.id) ?? this.scanFences(block);
		return regions.find((region) => region.openRow < row && row < (region.closeRow ?? block.start + block.height));
	}

	spansBetween(shape: Shape, a: Place, b: Place): RowSpan[] {
		const rowA = this.rowOf(a);
		const rowB = this.rowOf(b);
		if (rowA === undefined || rowB === undefined) return [];
		const forward = rowA < rowB || (rowA === rowB && a.char <= b.char);
		const first = forward ? { row: rowA, char: a.char } : { row: rowB, char: b.char };
		const last = forward ? { row: rowB, char: b.char } : { row: rowA, char: a.char };
		const spans: RowSpan[] = [];
		for (let row = first.row; row <= last.row; row++) {
			const count = this.text(row).glyphs.length;
			const startsHere = shape === "char" && row === first.row;
			const endsHere = shape === "char" && row === last.row;
			const from = startsHere ? first.char : 0;
			const to = endsHere ? Math.min(count, last.char + 1) : count;
			spans.push({ row, from, to });
		}
		return spans;
	}

	marksFor(spans: readonly RowSpan[]): Mark[] {
		return spans.flatMap((span) => {
			if (span.from === span.to) return [];
			const block = this.blockAt(span.row);
			const text = this.text(span.row).glyphs.slice(span.from, span.to).join("");
			return [{ block: block.id, line: span.row - block.start, from: span.from, to: span.to, text }];
		});
	}

	liveMarks(marks: readonly Mark[]): RowSpan[] {
		return marks.flatMap((mark) => {
			const row = this.rowOf({ block: mark.block, line: mark.line, char: 0 });
			if (row === undefined) return [];
			const visible = this.text(row).glyphs.slice(mark.from, mark.to).join("");
			if (visible !== mark.text) return [];
			return [{ row, from: mark.from, to: mark.to }];
		});
	}

	quote(spans: readonly RowSpan[]): string | undefined {
		const lines = spans
			.filter((span) => !isImageRow(this.rows[span.row]))
			.map((span) => ({ ...span, text: this.text(span.row).glyphs.slice(span.from, span.to).join("").trimEnd() }));
		let start = 0;
		let end = lines.length;
		while (start < end && lines[start].text === "") start++;
		while (end > start && lines[end - 1].text === "") end--;
		const kept = lines.slice(start, end);
		if (kept.length === 0) return undefined;
		const indents = kept.filter((line) => line.from === 0 && line.text !== "").map((line) => line.text.length - line.text.trimStart().length);
		const indent = indents.length > 0 ? Math.min(...indents) : 0;
		const body = kept.map((line) => (line.from === 0 ? line.text.slice(indent) : line.text)).join("\n");
		const region = this.codeAt(kept[0].row);
		if (region === undefined || !kept.every((line) => this.codeAt(line.row) === region)) return body;
		const fence = "`".repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((run) => run.length + 1)));
		return `${fence}${region.lang}\n${body}\n${fence}`;
	}

	private blockAt(row: number): Block {
		let low = 0;
		let high = this.laid.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if (this.laid[middle].start <= row) low = middle;
			else high = middle - 1;
		}
		return this.laid[low];
	}

	private scanFences(block: Block): CodeRegion[] {
		const regions: CodeRegion[] = [];
		let open: CodeRegion | undefined;
		for (let row = block.start; row < block.start + block.height; row++) {
			const text = this.text(row).text;
			if (open) {
				if (text === `${open.prefix}\`\`\``) {
					regions.push({ ...open, closeRow: row });
					open = undefined;
				}
				continue;
			}
			const match = FENCE_OPEN.exec(text);
			if (match) open = { lang: match[2].trim().split(/\s+/)[0], openRow: row, closeRow: undefined, prefix: match[1] };
		}
		if (open) regions.push(open);
		this.regions.set(block.id, regions);
		return regions;
	}
}
