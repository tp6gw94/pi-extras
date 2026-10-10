/** Where an `input` event came from (mirrors pi's `InputSource`). */
export type InputSource = "interactive" | "rpc" | "extension";

/**
 * State of the pinned prompt. Only text the user typed in the interactive editor
 * replaces it; RPC and extension-sent input (for example a pi-hooks fix request) do not.
 */
export class PromptPin {
	private current: string | undefined;
	private expandedFlag = false;

	get text(): string | undefined {
		return this.current;
	}

	get expanded(): boolean {
		return this.expandedFlag;
	}

	/** Returns true when the pin changed. A new prompt starts collapsed. */
	fromInput(text: string, source: InputSource): boolean {
		if (source !== "interactive") return false;
		if (text.trim() === "") return false;
		this.current = text;
		this.expandedFlag = false;
		return true;
	}

	/** Replace the pin from session history (or clear it with undefined). */
	restore(text: string | undefined): void {
		this.current = text && text.trim() !== "" ? text : undefined;
		this.expandedFlag = false;
	}

	/** Toggle expanded/collapsed. Returns the new state, or undefined when nothing is pinned. */
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

/**
 * The text of the last user message on the current branch (`sessionManager.getBranch()`),
 * or undefined. Custom messages (role "custom", e.g. pi-hooks) and assistant/tool messages are skipped.
 */
export function lastUserPrompt(entries: readonly EntryLike[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type !== "message" || e.message?.role !== "user") continue;
		const text = textOf(e.message.content);
		if (text.trim() !== "") return text;
	}
	return undefined;
}
