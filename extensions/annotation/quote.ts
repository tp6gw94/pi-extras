import { stripControls } from "../ux/core/strip-controls.ts";

export interface Annotation {
	quote: string;
	note: string;
}

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

export function annotationBlock(item: Annotation): string | undefined {
	const quote = formatQuote(stripControls(item.quote));
	if (quote === undefined) return undefined;
	const note = stripControls(item.note).trim();
	return note === "" ? quote : `${quote}${note}\n\n`;
}

export function annotationsText(items: readonly Annotation[], before = ""): string | undefined {
	const blocks = items.map(annotationBlock).filter((block): block is string => block !== undefined);
	if (blocks.length === 0) return undefined;
	const lead = before !== "" && !before.endsWith("\n") ? "\n" : "";
	return `${lead}${blocks.join("")}`;
}
