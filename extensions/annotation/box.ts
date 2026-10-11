import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type BoxResult = { kind: "insert"; note: string } | { kind: "cancel" };

type BoxTheme = Pick<Theme, "fg">;

export const QUOTE_PREVIEW_LINES = 3;

export function quotePreview(text: string, maxLines = QUOTE_PREVIEW_LINES): { lines: string[]; more: number } {
	const lines = text.split("\n");
	return { lines: lines.slice(0, maxLines), more: Math.max(0, lines.length - maxLines) };
}

/** Rows the box renders: border, quote preview, blank, input, hint, border. */
export function boxHeight(text: string): number {
	const preview = quotePreview(text);
	return preview.lines.length + (preview.more > 0 ? 1 : 0) + 5;
}

export class AnnotationBox implements Component, Focusable {
	private readonly input = new Input({ prompt: " > ", placeholder: "Add a note, or press Enter to quote only" });
	private readonly theme: BoxTheme;
	private readonly selected: string;

	constructor(theme: BoxTheme, selected: string, done: (result: BoxResult) => void) {
		this.theme = theme;
		this.selected = selected;
		this.input.onSubmit = (value) => done({ kind: "insert", note: value });
		this.input.onEscape = () => done({ kind: "cancel" });
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(10, width - 2);
		const preview = quotePreview(this.selected);
		const quote = preview.lines.map((line) => ` ${th.fg("dim", "│")} ${th.fg("muted", line)}`);
		if (preview.more > 0) quote.push(` ${th.fg("dim", `│ … ${preview.more} more line${preview.more === 1 ? "" : "s"}`)}`);
		return frame(th, width, "Annotate", [...quote, "", ...this.input.render(inner).slice(0, 1), th.fg("dim", " Enter insert · Esc cancel")]);
	}
}

function frame(theme: BoxTheme, width: number, title: string, body: string[]): string[] {
	const inner = Math.max(10, width - 2);
	const border = (s: string) => theme.fg("border", s);
	const row = (content: string) => {
		const clipped = truncateToWidth(content, inner);
		return border("│") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + border("│");
	};
	const label = ` ${title} `;
	const top = border("╭─") + theme.fg("accent", label) + border(`${"─".repeat(Math.max(0, inner - 1 - visibleWidth(label)))}╮`);
	return [top, ...body.map(row), border(`╰${"─".repeat(inner)}╯`)];
}
