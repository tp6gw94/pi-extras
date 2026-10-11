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
