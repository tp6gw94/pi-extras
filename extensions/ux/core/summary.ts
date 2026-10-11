import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripControls } from "./strip-controls.ts";

export { stripControls, TAB } from "./strip-controls.ts";

export const ELLIPSIS = "…";

export function oneLine(text: string): string {
	return stripControls(text).replace(/\s+/g, " ").trim();
}

export function collapsedLine(text: string, width: number, prefix = "❯ "): string {
	if (width <= 0) return "";
	const line = `${prefix}${oneLine(text)}`;
	if (visibleWidth(line) <= width) return line;
	// truncateToWidth appends SGR resets; the input has no styling, so drop them.
	return truncateToWidth(line, width, ELLIPSIS).replace(/\u001b\[0m/g, "");
}

export function expandedLines(text: string, width: number, prefix = "│ "): string[] {
	const inner = Math.max(1, width - visibleWidth(prefix));
	const out: string[] = [];
	for (const raw of stripControls(text).replace(/\n+$/, "").split("\n")) {
		const wrapped = raw === "" ? [""] : wrapTextWithAnsi(raw, inner);
		for (const w of wrapped) out.push(`${prefix}${w}`);
	}
	return out;
}
