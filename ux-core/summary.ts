import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const ELLIPSIS = "…";

/** Collapse all whitespace (including newlines) into single spaces. */
export function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * The collapsed widget line: `prefix` + the prompt on one line, cut to `width`
 * terminal columns with `…`. Uses display width, so CJK characters count as 2.
 */
export function collapsedLine(text: string, width: number, prefix = "❯ "): string {
	if (width <= 0) return "";
	const line = `${prefix}${oneLine(text)}`;
	if (visibleWidth(line) <= width) return line;
	// truncateToWidth appends SGR resets; the input has no styling, so drop them.
	return truncateToWidth(line, width, ELLIPSIS).replace(/\u001b\[0m/g, "");
}

/** The expanded widget lines: every line of the prompt, wrapped to `width` after `prefix`. */
export function expandedLines(text: string, width: number, prefix = "│ "): string[] {
	const inner = Math.max(1, width - visibleWidth(prefix));
	const out: string[] = [];
	for (const raw of text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n")) {
		const wrapped = raw === "" ? [""] : wrapTextWithAnsi(raw, inner);
		for (const w of wrapped) out.push(`${prefix}${w}`);
	}
	return out;
}
