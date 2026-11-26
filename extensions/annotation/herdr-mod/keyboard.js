export const ROW_HEIGHT = 22;
export const GUTTER_WIDTH = 100;
const MIN_COLUMNS = 8;
const VIEWPORT_INSET = 32;
const ESTIMATED_CELL_WIDTH = 8;
const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
	? new Intl.Segmenter(undefined, { granularity: "grapheme" })
	: null;

function* graphemes(line) {
	if (segmenter) {
		for (const { segment } of segmenter.segment(line)) yield segment;
	} else {
		for (const [segment] of line.matchAll(/(?:\p{Regional_Indicator}{1,2}|.)[\p{M}\p{Emoji_Modifier}]*(?:\u200D.[\p{M}\p{Emoji_Modifier}]*)*/gsu)) yield segment;
	}
}

function displayWidth(glyph) {
	if (glyph === "\t") return 4;
	return glyph.codePointAt(0) < 128 ? 1 : 2;
}

function transcriptRows(items, expandedTools, columns) {
	const rows = [];
	for (const item of items) {
		if (!item.text.trim() || (item.kind === "tool" && !expandedTools.has(item.id))) continue;
		const first = rows.length;
		let start = 0;
		for (const line of item.text.split(/\r?\n/)) {
			let offsets = [start];
			let width = 0;
			for (const glyph of graphemes(line)) {
				const cells = displayWidth(glyph);
				if (width + cells > columns) {
					rows.push({ item, first, offsets });
					offsets = [start];
					width = 0;
				}
				start += glyph.length;
				offsets.push(start);
				width += cells;
			}
			rows.push({ item, first, offsets });
			start += item.text[start] === "\r" ? 2 : 1;
		}
		const last = rows.length - 1;
		for (let index = first; index <= last; index++) rows[index].last = last;
	}
	return rows;
}

function lastColumn(row) {
	return Math.max(0, row.offsets.length - 2);
}

function point(rows, { row, col }) {
	const { item, offsets } = rows[row];
	return { item, start: offsets[col], end: offsets[col + 1] ?? offsets[col] };
}

function locate(rows, itemId, offset) {
	const row = rows.findIndex(({ item, offsets }) => item.id === itemId && offset >= offsets[0]
		&& (offset < offsets.at(-1) || (offset === offsets[0] && offsets.length === 1)));
	if (row < 0) return null;
	const col = rows[row].offsets.findLastIndex((start) => start <= offset);
	return { row, col };
}

export class TranscriptKeyboard {
	constructor(items, expandedTools, selection) {
		this.columns = 80;
		this.rows = transcriptRows(items, expandedTools, this.columns);
		this.visual = null;
		this.cursor = selection && locate(this.rows, selection.itemId, selection.start);
		if (!this.cursor && this.rows.length) this.cursor = { row: this.rows.at(-1).first, col: 0 };
		this.goal = this.cursor?.col ?? 0;
	}

	resize(width, items, expandedTools) {
		const columns = Math.max(MIN_COLUMNS, Math.floor((width - GUTTER_WIDTH - VIEWPORT_INSET) / ESTIMATED_CELL_WIDTH));
		if (columns === this.columns) return true;
		this.columns = columns;
		return this.reflow(items, expandedTools);
	}

	reflow(items, expandedTools) {
		const cursor = this.current();
		const visual = this.visual && point(this.rows, this.visual);
		const rows = transcriptRows(items, expandedTools, this.columns);
		const next = locate(rows, cursor.item.id, cursor.start);
		if (!next || !rows[next.row].item.text.startsWith(cursor.item.text)) return false;
		const nextVisual = visual && locate(rows, visual.item.id, visual.start);
		if (visual && (!nextVisual || point(rows, nextVisual).end !== visual.end || point(rows, next).end !== cursor.end)) return false;
		this.rows = rows;
		this.cursor = next;
		this.visual = nextVisual;
		this.goal = next.col;
		return true;
	}

	current() {
		return point(this.rows, this.cursor);
	}

	toggleVisual() {
		this.visual = this.visual ? null : this.cursor;
	}

	rowBounds() {
		if (!this.visual) return { first: 0, last: this.rows.length - 1 };
		const line = this.rows[this.cursor.row];
		return { first: line.first, last: line.last };
	}

	jumpFirst() {
		this.cursor = { row: this.rowBounds().first, col: 0 };
		this.goal = 0;
	}

	jumpLast() {
		this.cursor = { row: this.rowBounds().last, col: 0 };
		this.goal = 0;
	}

	selection() {
		if (!this.visual) return null;
		const left = point(this.rows, this.visual);
		const right = this.current();
		const start = Math.min(left.start, right.start);
		const end = Math.max(left.end, right.end);
		const quote = left.item.text.slice(start, end);
		return quote.trim() ? { itemId: left.item.id, start, end, quote } : null;
	}

	move(key, pageRows) {
		const { row, col } = this.cursor;
		const line = this.rows[row];
		const half = Math.max(1, Math.floor(pageRows / 2));
		const step = { j: 1, k: -1, "ctrl-d": half, "ctrl-u": -half }[key];
		if (step) {
			const { first, last } = this.rowBounds();
			const next = Math.max(first, Math.min(last, row + step));
			this.cursor = { row: next, col: Math.min(this.goal, lastColumn(this.rows[next])) };
			return key.startsWith("ctrl-") ? next - row : 0;
		}
		if (key === "h") {
			const previous = this.rows[row - 1];
			this.cursor = col === 0 && row > line.first && previous.offsets.at(-1) === line.offsets[0]
				? { row: row - 1, col: lastColumn(previous) }
				: { row, col: Math.max(0, col - 1) };
		} else {
			const next = this.rows[row + 1];
			this.cursor = col === lastColumn(line) && row < line.last && line.offsets.at(-1) === next.offsets[0]
				? { row: row + 1, col: 0 }
				: { row, col: Math.min(lastColumn(line), col + 1) };
		}
		this.goal = this.cursor.col;
		return 0;
	}
}
