import { AssistantMessageComponent, getMarkdownTheme, initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { BlockId, Capture } from "../mode/data.ts";
import { Transcript } from "../mode/transcript.ts";

initTheme("dark");

type AssistantMessage = NonNullable<ConstructorParameters<typeof AssistantMessageComponent>[0]>;

export const id = (n: number): BlockId => n as BlockId;

export const user = (text: string): Component => new UserMessageComponent(text);

export const assistant = (text: string): Component => new AssistantMessageComponent(message(text));

export const markdown = (text: string, theme: Partial<MarkdownTheme> = {}): Component => new Markdown(text, 1, 0, { ...getMarkdownTheme(), ...theme });

export const spacer = (lines = 1): Component => new Spacer(lines);

export function capture(children: readonly Component[], width: number): Capture {
	const chat = new Container();
	for (const child of children) chat.addChild(child);
	const rows = chat.render(width);
	return { width, rows, blocks: children.map((child, index) => ({ id: id(index + 1), height: child.render(width).length })) };
}

export const transcript = (children: readonly Component[], width = 40): Transcript => new Transcript(capture(children, width));

export const plain = (rows: readonly string[]): string[] => rows.map(stripTerminalSequences);

function message(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	};
}
