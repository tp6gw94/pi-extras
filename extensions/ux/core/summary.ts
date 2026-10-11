import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const ELLIPSIS = "…";

export const TAB = "    ";

// ESC sequences: OSC (ESC ] … BEL or ST), DCS, SOS, PM and APC strings (ESC P, X, ^, _ … ST),
// CSI (ESC [ params final), then any other ESC + intermediates + final byte.
const ESC_SEQUENCE =
	/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]?/g;
// C0 controls except tab and newline, DEL, and C1 controls (8-bit CSI, OSC and friends).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * Make prompt text safe to draw: drop terminal escape sequences and control characters, so a
 * pasted `ESC[2J` or OSC sequence cannot clear the screen or retitle the terminal from the widget.
 * Line breaks become `\n` and tabs become spaces. Everything else printable is kept.
 */
export function stripControls(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(ESC_SEQUENCE, "")
		.replace(CONTROL, "")
		.replace(/\t/g, TAB);
}

/** Collapse all whitespace (including newlines) into single spaces, after dropping controls. */
export function oneLine(text: string): string {
	return stripControls(text).replace(/\s+/g, " ").trim();
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

/** The expanded widget lines: every line of the prompt without controls, wrapped to `width` after `prefix`. */
export function expandedLines(text: string, width: number, prefix = "│ "): string[] {
	const inner = Math.max(1, width - visibleWidth(prefix));
	const out: string[] = [];
	for (const raw of stripControls(text).replace(/\n+$/, "").split("\n")) {
		const wrapped = raw === "" ? [""] : wrapTextWithAnsi(raw, inner);
		for (const w of wrapped) out.push(`${prefix}${w}`);
	}
	return out;
}
