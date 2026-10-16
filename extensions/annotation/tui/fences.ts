export interface FenceSpan {
	open: number;
	end: number;
}

export interface Fence extends FenceSpan {
	lang: string;
	contentStart: number;
	contentEnd: number;
	closed: boolean;
}

export function fences(text: string): Fence[] {
	const found: Fence[] = [];
	let open: { char: string; size: number; lang: string; open: number; contentStart: number } | undefined;
	let lineStart = 0;
	for (const line of text.split("\n")) {
		const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		const lineEnd = lineStart + line.length;
		if (fence && !open) {
			if (!(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
				open = { char: fence[1]![0]!, size: fence[1]!.length, lang: fence[2]!.trim().split(/\s+/)[0] ?? "", open: lineStart, contentStart: lineEnd + 1 };
			}
		} else if (fence && open && fence[1]![0] === open.char && fence[1]!.length >= open.size && fence[2]!.trim() === "") {
			found.push({ lang: open.lang, open: open.open, contentStart: open.contentStart, contentEnd: lineStart, end: lineEnd, closed: true });
			open = undefined;
		}
		lineStart = lineEnd + 1;
	}
	if (open) found.push({ lang: open.lang, open: open.open, contentStart: open.contentStart, contentEnd: text.length, end: text.length, closed: false });
	return found;
}

export function mermaidFences(text: string): Fence[] {
	return fences(text).filter((fence) => fence.closed && fence.lang.toLowerCase() === "mermaid");
}
