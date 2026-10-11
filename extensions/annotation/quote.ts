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

/** The quote, then the typed note, then a blank line. An empty note still inserts the quote. */
export function annotationText(selected: string, note: string, before = ""): string | undefined {
	const quote = formatQuote(selected, before);
	if (quote === undefined) return undefined;
	const typed = note.trim();
	return typed === "" ? quote : `${quote}${typed}\n\n`;
}
