export type InputSource = "interactive" | "rpc" | "extension";

export class PromptPin {
	private current: string | undefined;
	private expandedFlag = false;

	get text(): string | undefined {
		return this.current;
	}

	get expanded(): boolean {
		return this.expandedFlag;
	}

	fromInput(text: string, source: InputSource): boolean {
		if (source !== "interactive") return false;
		if (text.trim() === "") return false;
		this.current = text;
		this.expandedFlag = false;
		return true;
	}

	restore(text: string | undefined): void {
		this.current = text && text.trim() !== "" ? text : undefined;
		this.expandedFlag = false;
	}

	toggle(): boolean | undefined {
		if (this.current === undefined) return undefined;
		this.expandedFlag = !this.expandedFlag;
		return this.expandedFlag;
	}
}

interface EntryLike {
	type: string;
	message?: { role?: string; content?: unknown };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => typeof c === "object" && c !== null && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export function lastUserPrompt(entries: readonly EntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type !== "message" || e.message?.role !== "user") continue;
		const text = textOf(e.message.content);
		if (text.trim() !== "") return text;
	}
	return undefined;
}
