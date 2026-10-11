/**
 * Format clipboard text as a Markdown quote: every line prefixed with `> `,
 * followed by one blank line. Returns undefined for empty or whitespace-only text.
 *
 * When `before` (the current editor text) is non-empty and does not end with a
 * newline, the quote starts on a new line so it does not run into typed text.
 */
export function formatQuote(text: string, before = ""): string | undefined {
	const normalized = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
	if (normalized.trim() === "") return undefined;
	const body = normalized
		.replace(/^\n+/, "")
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	const lead = before !== "" && !before.endsWith("\n") ? "\n" : "";
	return `${lead}${body}\n\n`;
}
