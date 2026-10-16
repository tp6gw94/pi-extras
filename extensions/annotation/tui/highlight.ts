import { fences } from "./fences.ts";

export type MdStyle = "plain" | "marker" | "heading1" | "heading2" | "heading3" | "strong" | "emphasis" | "strike" | "code" | "link" | "url" | "quote" | "bullet";

const BREAK = /^ {0,3}([-*_])( *\1){2,} *$/;
const HEADING = /^ {0,3}(#{1,6})(?=\s|$)/;
const HEADING_CLOSE = /( +#+ *)$/;
const HEADING_LEVELS: readonly MdStyle[] = ["heading1", "heading2", "heading3"];
const QUOTE = /^(?: *>)+ */;
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?=\s)/;
const TASK = /^ *\[[ xX]\](?=\s|$)/;
const TABLE_DELIM = /^[\s|:\-]+$/;
const LINK = /^!?\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/;
const AUTOLINK = /^<(https?:\/\/[^\s>]+)>/;
const WORD = /[\p{L}\p{N}_]/u;
const SPACE = /\s/;
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

const fill = (styles: MdStyle[], from: number, to: number, style: MdStyle): void => {
	for (let at = from; at < to; at++) styles[at] = style;
};

const wordAt = (line: string, at: number): boolean => {
	const ch = line[at];
	return ch !== undefined && WORD.test(ch);
};

const runLength = (line: string, from: number, ch: string): number => {
	let at = from;
	while (line[at] === ch) at++;
	return at - from;
};

const codeClose = (line: string, from: number, size: number): number => {
	let at = from;
	while (at < line.length) {
		if (line[at] !== "`") {
			at++;
			continue;
		}
		const run = runLength(line, at, "`");
		if (run === size) return at;
		at += run;
	}
	return -1;
};

const codeSpan = (line: string, at: number): { size: number; close: number; end: number } => {
	const size = runLength(line, at, "`");
	const close = codeClose(line, at + size, size);
	return { size, close, end: close < 0 ? at + size : close + size };
};

const delimOpens = (line: string, ch: string, size: number, at: number): boolean => {
	const after = line[at + size];
	return after !== undefined && !SPACE.test(after) && (ch !== "_" || !wordAt(line, at - 1));
};

const delimCloses = (line: string, ch: string, size: number, at: number): boolean => {
	const before = line[at - 1];
	return before !== undefined && !SPACE.test(before) && (ch !== "_" || !wordAt(line, at + size));
};

const nextDelim = (line: string, from: number, ch: string, size: number): number => {
	let at = from;
	while (at < line.length) {
		const cur = line[at]!;
		if (cur === "\\") {
			at += 2;
			continue;
		}
		if (cur === "`") {
			at = codeSpan(line, at).end;
			continue;
		}
		if (cur !== ch) {
			at++;
			continue;
		}
		const run = runLength(line, at, ch);
		if (run === size && delimCloses(line, ch, size, at)) return at;
		at += run;
	}
	return -1;
};

const scanInline = (text: string, styles: MdStyle[], from: number, to: number, base: MdStyle): void => {
	const line = text.slice(from, to);
	const mark = (start: number, end: number, style: MdStyle): void => fill(styles, from + start, from + end, style);
	const scan = (start: number, end: number, style: MdStyle): void => scanInline(text, styles, from + start, from + end, style);
	fill(styles, from, to, base);
	let at = 0;
	while (at < line.length) {
		const ch = line[at]!;
		if (ch === "\\") {
			const escaped = line[at + 1];
			if (escaped !== undefined && PUNCT.test(escaped)) {
				styles[from + at] = "marker";
				at += 2;
				continue;
			}
			at++;
			continue;
		}
		if (ch === "`") {
			const span = codeSpan(line, at);
			if (span.close >= 0) {
				mark(at, at + span.size, "marker");
				mark(at + span.size, span.close, "code");
				mark(span.close, span.end, "marker");
			}
			at = span.end;
			continue;
		}
		if (ch === "[" || (ch === "!" && line[at + 1] === "[")) {
			const link = LINK.exec(line.slice(at));
			if (link) {
				const textStart = at + (ch === "!" ? 2 : 1);
				const textEnd = textStart + link[1]!.length;
				const urlEnd = textEnd + 2 + link[2]!.length;
				mark(at, textStart, "marker");
				scan(textStart, textEnd, "link");
				mark(textEnd, textEnd + 2, "marker");
				mark(textEnd + 2, urlEnd, "url");
				mark(urlEnd, urlEnd + 1, "marker");
				at = urlEnd + 1;
				continue;
			}
		}
		if (ch === "<") {
			const auto = AUTOLINK.exec(line.slice(at));
			if (auto) {
				const end = at + auto[0].length;
				mark(at, at + 1, "marker");
				mark(at + 1, end - 1, "url");
				mark(end - 1, end, "marker");
				at = end;
				continue;
			}
		}
		if (ch === "*" || ch === "_" || (ch === "~" && line[at + 1] === "~")) {
			const strike = ch === "~";
			const paired = strike || line[at + 1] === ch;
			const delim = paired ? ch + ch : ch;
			let style: MdStyle = "emphasis";
			if (strike) style = "strike";
			else if (paired) style = "strong";
			const opening = delimOpens(line, ch, delim.length, at);
			const closing = opening ? nextDelim(line, at + delim.length, ch, delim.length) : -1;
			if (closing >= 0) {
				mark(at, at + delim.length, "marker");
				scan(at + delim.length, closing, style);
				mark(closing, closing + delim.length, "marker");
				at = closing + delim.length;
				continue;
			}
			at += delim.length;
			continue;
		}
		at++;
	}
};

const scanHeading = (text: string, styles: MdStyle[], from: number, to: number, line: string, heading: RegExpExecArray): void => {
	const hashes = heading[1]!;
	const level = HEADING_LEVELS[Math.min(hashes.length, HEADING_LEVELS.length) - 1]!;
	const contentStart = heading[0].length;
	fill(styles, from + contentStart - hashes.length, from + contentStart, "marker");
	const closing = HEADING_CLOSE.exec(line.slice(contentStart));
	const contentEnd = closing ? from + contentStart + closing.index : to;
	if (closing) fill(styles, contentEnd, to, "marker");
	scanInline(text, styles, from + contentStart, contentEnd, level);
};

const scanList = (text: string, styles: MdStyle[], from: number, to: number, line: string, list: RegExpExecArray): void => {
	const token = list[2]!;
	const start = list[1]!.length;
	const tokenEnd = start + token.length;
	fill(styles, from + start, from + tokenEnd, "bullet");
	const task = TASK.exec(line.slice(tokenEnd));
	const contentStart = task ? tokenEnd + task[0].length : tokenEnd;
	if (task) fill(styles, from + tokenEnd, from + contentStart, "bullet");
	scanInline(text, styles, from + contentStart, to, "plain");
};

const nextPipe = (line: string, from: number): number => {
	let at = from;
	while (at < line.length) {
		if (line[at] === "|") return at;
		at += line[at] === "\\" ? 2 : 1;
	}
	return -1;
};

const scanTable = (text: string, styles: MdStyle[], from: number, to: number, line: string): void => {
	if (TABLE_DELIM.test(line)) {
		fill(styles, from, to, "marker");
		return;
	}
	let start = 0;
	while (start <= line.length) {
		const pipe = nextPipe(line, start);
		const end = pipe < 0 ? line.length : pipe;
		if (end > start) scanInline(text, styles, from + start, from + end, "plain");
		if (pipe < 0) return;
		styles[from + pipe] = "marker";
		start = pipe + 1;
	}
};

const scanLine = (text: string, styles: MdStyle[], from: number, to: number, line: string): void => {
	if (BREAK.test(line)) {
		fill(styles, from, to, "marker");
		return;
	}
	const heading = HEADING.exec(line);
	if (heading) {
		scanHeading(text, styles, from, to, line, heading);
		return;
	}
	const quote = QUOTE.exec(line);
	if (quote) {
		fill(styles, from, from + quote[0].length, "bullet");
		scanInline(text, styles, from + quote[0].length, to, "quote");
		return;
	}
	const list = LIST.exec(line);
	if (list) {
		scanList(text, styles, from, to, line, list);
		return;
	}
	if (line.trimStart().startsWith("|")) {
		scanTable(text, styles, from, to, line);
		return;
	}
	scanInline(text, styles, from, to, "plain");
};

const scanLines = (text: string, styles: MdStyle[], from: number, to: number): void => {
	let at = from;
	while (at < to) {
		const found = text.indexOf("\n", at);
		const end = found < 0 ? to : found;
		scanLine(text, styles, at, end, text.slice(at, end));
		at = end + 1;
	}
};

export function highlight(text: string): MdStyle[] {
	const styles = new Array<MdStyle>(text.length).fill("plain");
	let at = 0;
	for (const block of fences(text).filter((fence) => fence.closed)) {
		scanLines(text, styles, at, block.open);
		fill(styles, block.open, block.contentStart - 1, "marker");
		fill(styles, block.contentStart, block.contentEnd, "code");
		fill(styles, block.contentEnd, block.end, "marker");
		at = block.end + 1;
	}
	scanLines(text, styles, at, text.length);
	return styles;
}
