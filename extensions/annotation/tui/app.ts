import type * as PiTui from "@earendil-works/pi-tui";
import type { Component, Editor, Focusable, Input, TUI } from "@earendil-works/pi-tui";
import type { Annotation } from "../quote.ts";
import { type AnnotateClient, disconnectReason, type InitialSnapshot, ProtocolError } from "./client.ts";
import { type Doc, INDENT, itemOf, type Layout, layoutCache, locate, selectionRange, type Span, spansOf } from "./document.ts";
import { type Action, type Effect, type Env, type HelpEntry, helpRows, hintFor, initialModel, keyAction, type Model, modeTag, pendingText, quitWarning, reduce } from "./model.ts";

export type TuiLib = typeof PiTui;

export interface AppOptions {
	lib: TuiLib;
	tui: TUI;
	client: AnnotateClient;
	snapshot: InitialSnapshot;
	title: string;
	onExit(): void;
}

const sgr = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const bold = sgr("1");
const dim = sgr("2");
const inverse = sgr("7");
const red = sgr("31");
const green = sgr("32");
const KIND_STYLE = { user: sgr("1;32"), assistant: sgr("1;36"), tool: sgr("33") };
const SELECTED = "48;5;24";
const MARKED = "4";

const NAMED_KEYS = ["escape", "enter", "tab", "up", "down", "left", "right", "pageUp", "pageDown", "home", "end", "ctrl+c", "ctrl+d", "ctrl+u", "ctrl+f", "ctrl+b"] as const;

const sleep = (ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms).unref());

export class AnnotateApp implements Component, Focusable {
	private model: Model;
	private readonly lib: TuiLib;
	private readonly tui: TUI;
	private readonly client: AnnotateClient;
	private readonly editor: Editor;
	private readonly input: Input;
	private readonly title: string;
	private readonly onExit: () => void;
	private readonly abort = new AbortController();
	private readonly layouts: (doc: Doc, width: number) => Layout;
	private width: number;
	private pageHeight: number;
	private focusedFlag = false;
	private stopped = false;

	constructor(options: AppOptions) {
		this.lib = options.lib;
		this.tui = options.tui;
		this.client = options.client;
		this.title = options.title;
		this.onExit = options.onExit;
		this.layouts = layoutCache(this.lib.visibleWidth);
		this.model = initialModel(options.snapshot.items, options.snapshot.version, options.snapshot.nextSeq);
		this.width = options.tui.terminal.columns;
		this.pageHeight = Math.max(1, options.tui.terminal.rows - 2);
		this.editor = new this.lib.Editor(options.tui, {
			borderColor: dim,
			selectList: { selectedPrefix: (t) => t, selectedText: (t) => t, description: dim, scrollInfo: dim, noMatch: dim },
		});
		this.editor.onSubmit = (text) => this.dispatch({ type: "saveNote", text });
		this.input = new this.lib.Input({ prompt: "/" });
		this.input.onSubmit = (query) => this.dispatch({ type: "searchSubmit", query });
	}

	get focused(): boolean {
		return this.focusedFlag;
	}

	set focused(value: boolean) {
		this.focusedFlag = value;
		this.syncFocus();
	}

	start(): void {
		void this.poll();
	}

	stop(): void {
		this.stopped = true;
		this.abort.abort();
	}

	invalidate(): void {
		this.editor.invalidate();
		this.input.invalidate();
	}

	handleInput(data: string): void {
		const key = this.key(data);
		const action = key === undefined ? undefined : keyAction(this.model, key);
		if (action) {
			this.dispatch(action);
			return;
		}
		this.dispatch({ type: "otherKey" });

		const mode = this.model.mode.kind;
		if (mode === "note" || mode === "search") {
			(mode === "note" ? this.editor : this.input).handleInput(data);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		this.width = width;
		const height = Math.max(1, this.tui.terminal.rows);
		const mode = this.model.mode.kind;
		const panel = mode === "note" ? this.renderNotePanel(width) : [];
		const panelLines = panel.slice(0, Math.max(0, height - 2));
		const bodyHeight = Math.max(0, height - 2 - panelLines.length);
		this.pageHeight = Math.max(1, bodyHeight);
		const body = this.renderBody(width, bodyHeight);
		const status = mode === "search" ? (this.input.render(width)[0] ?? this.renderStatus(width)) : this.renderStatus(width);
		return [this.renderTitle(width), ...body, ...panelLines, status].slice(0, height).map((line) => this.fit(line, width));
	}

	private key(data: string): string | undefined {
		for (const name of NAMED_KEYS) if (this.lib.matchesKey(data, name)) return name;
		const printable = this.lib.decodeKittyPrintable(data) ?? data;
		return [...printable].length === 1 && printable >= " " ? printable : undefined;
	}

	private dispatch(action: Action): void {
		if (this.stopped) return;
		const { model, effects } = reduce(this.model, action, this.env());
		this.model = model;
		this.syncFocus();
		for (const effect of effects) this.runEffect(effect);
		this.tui.requestRender();
	}

	private env(): Env {
		return { height: this.pageHeight, layoutOf: (doc) => this.layouts(doc, this.width) };
	}

	private runEffect(effect: Effect): void {
		switch (effect.type) {
			case "editNote":
				this.editor.setText(effect.initialText);
				break;
			case "openSearch":
				this.input.setValue("");
				break;
			case "send":
				void this.send(effect.notes);
				break;
			case "exit":
				this.stop();
				this.onExit();
				break;
		}
	}

	private async send(notes: readonly Annotation[]): Promise<void> {
		const ids = this.model.sending ?? [];
		try {
			const outcome = await this.client.send(this.model.seq, notes);
			if (this.stopped) return;
			if (outcome.ok) this.dispatch({ type: "sent", ids, inserted: outcome.inserted, nextSeq: outcome.nextSeq });
			else if (outcome.kind === "conflict") this.dispatch({ type: "conflict", expectedSeq: outcome.expectedSeq });
			else this.dispatch({ type: "rejected", reason: outcome.reason });
		} catch (error) {
			if (this.stopped) return;
			this.dispatch({ type: "failed", reason: disconnectReason(error) });
		}
	}

	private async poll(): Promise<void> {
		while (!this.stopped && this.model.connection.status === "live") {
			let update;
			try {
				update = await this.client.watch(this.model.version, this.abort.signal);
			} catch (error) {
				if (this.stopped || this.abort.signal.aborted) return;
				if (error instanceof ProtocolError && error.code === "busy") {
					await sleep(5000);
					continue;
				}
				this.dispatch({ type: "disconnected", reason: disconnectReason(error) });
				return;
			}
			this.dispatch({ type: "update", version: update.version, reset: update.reset, items: update.items });
		}
	}

	private syncFocus(): void {
		this.editor.focused = this.focusedFlag && this.model.mode.kind === "note";
		this.input.focused = this.focusedFlag && this.model.mode.kind === "search";
	}

	private fit(line: string, width: number): string {
		return this.lib.truncateToWidth(line, width);
	}

	private renderTitle(width: number): string {
		const count = this.model.notes.length;
		const state = this.model.connection.status === "live" ? green("● live") : red("○ closed");
		const right = `${count} note${count === 1 ? "" : "s"}  ${state}`;
		const left = this.lib.truncateToWidth(bold(this.title), Math.max(0, width - this.lib.visibleWidth(right) - 1));
		const gap = Math.max(1, width - this.lib.visibleWidth(left) - this.lib.visibleWidth(right));
		return `${left}${" ".repeat(gap)}${right}`;
	}

	private renderStatus(width: number): string {
		const model = this.model;
		const message = model.message;
		const warning = quitWarning(model);
		const parts: string[] = [];
		if (warning) parts.push(red(warning));
		if (message) parts.push(message.error ? red(message.text) : green(message.text));
		const text = parts.length > 0 ? parts.join(" · ") : dim(hintFor(model.mode.kind));
		const pending = pendingText(model);
		const left = `${inverse(` ${modeTag(model)} `)} ${text}`;
		if (pending === "") return this.fit(left, width);
		const gap = Math.max(1, width - this.lib.visibleWidth(left) - pending.length);
		return this.fit(`${left}${" ".repeat(gap)}${pending}`, width);
	}

	private renderNotePanel(width: number): string[] {
		if (this.model.mode.kind !== "note") return [];
		const lines = this.model.mode.draft.quote.split("\n");
		const preview = lines.slice(0, 3).map((line) => dim(`> ${line}`));
		if (lines.length > 3) preview.push(dim(`> … ${lines.length - 3} more line${lines.length - 3 === 1 ? "" : "s"}`));
		return [...preview, ...this.editor.render(width)];
	}

	private renderBody(width: number, height: number): string[] {
		const mode = this.model.mode.kind;
		let body: string[];
		if (mode === "list") body = this.renderList(width, height);
		else if (mode === "help") body = this.renderHelp();
		else body = this.renderDocument(width, height);
		const lines = body.slice(0, height);
		while (lines.length < height) lines.push("");
		return lines;
	}

	private renderHelp(): string[] {
		const top = this.model.mode.kind === "help" ? this.model.mode.top : 0;
		const rows = helpRows();
		const entries = rows.filter((row): row is HelpEntry => !("heading" in row));
		const keyWidth = Math.max(...entries.map((row) => this.lib.visibleWidth(row.keys)));
		const labelWidth = Math.max(...entries.map((row) => this.lib.visibleWidth(row.label)));
		const lines = rows.map((row) => ("heading" in row ? bold(row.heading) : `  ${row.keys.padEnd(keyWidth)}  ${row.label.padEnd(labelWidth)}  ${dim(row.modes)}`));
		return lines.slice(top);
	}

	private renderList(width: number, height: number): string[] {
		const notes = this.model.notes;
		const index = this.model.mode.kind === "list" ? this.model.mode.index : 0;
		if (notes.length === 0) return ["", dim("  No notes yet. Select text with v or V, then press a.")];
		const visible = Math.max(1, Math.floor(height / 2));
		const top = Math.max(0, Math.min(Math.floor(index / visible) * visible, Math.max(0, notes.length - visible)));
		const lines: string[] = [];
		notes.slice(top, top + visible).forEach((note, offset) => {
			const at = top + offset;
			const quoteLines = note.quote.split("\n");
			const more = quoteLines.length > 1 ? dim(` (+${quoteLines.length - 1} lines)`) : "";
			const head = `${at === index ? inverse(` ${at + 1} `) : ` ${at + 1} `} ${dim(`> ${quoteLines[0]}`)}${more}`;
			const text = note.text === "" ? dim("(no note)") : note.text.split("\n")[0]!;
			lines.push(this.fit(head, width), this.fit(`     ${text}`, width));
		});
		return lines;
	}

	private renderDocument(width: number, height: number): string[] {
		const model = this.model;
		if (model.items.length === 0) return ["", dim("  Waiting for messages…")];
		const draft = model.mode.kind === "note" ? model.mode.draft : undefined;
		const visual = model.mode.kind === "visual" ? model.mode : undefined;
		const doc = { items: model.items, expanded: model.expanded };
		const canvas = this.layouts(doc, width);
		const caret = model.caret ? locate(canvas, model.caret) : undefined;
		const showCaret = model.mode.kind === "normal";
		let selections: Span[] = [];
		if (visual && model.caret) {
			const range = selectionRange(doc, visual.shape, visual.anchor, model.caret);
			selections = range ? spansOf(doc, range) : [];
		}
		const marks: Span[] = [...(draft?.spans ?? []), ...model.notes.flatMap((note) => note.spans)];
		const noteCounts = new Map<string, number>();
		const count = (spans: readonly Span[]) => {
			for (const id of new Set(spans.map((span) => span.itemId))) noteCounts.set(id, (noteCounts.get(id) ?? 0) + 1);
		};
		for (const note of model.notes) count(note.spans);
		if (draft) count(draft.spans);
		const covers = (spans: readonly Span[], itemId: string, offset: number) => spans.some((span) => span.itemId === itemId && offset >= span.start && offset < span.end);
		const at = model.viewport ? locate(canvas, model.viewport) : undefined;
		const maxTop = Math.max(0, canvas.rows.length - height);
		const viewTop = Math.max(0, Math.min(maxTop, at ? at.row : 0));
		const top = caret ? Math.max(caret.row - height + 1, Math.min(viewTop, caret.row)) : viewTop;
		const lines: string[] = [];
		for (let row = top; row < Math.min(canvas.rows.length, top + height); row++) {
			const current = canvas.rows[row]!;
			const item = itemOf(doc, current.itemId)!;
			if (current.type === "header") {
				const glyph = item.kind === "tool" ? (model.expanded.has(item.id) ? "▾" : "▸") : "●";
				const label = `${glyph} ${item.label}`;
				const badgeCount = noteCounts.get(item.id) ?? 0;
				const badge = badgeCount > 0 ? dim(` · ${badgeCount} note${badgeCount === 1 ? "" : "s"}`) : "";
				const head = caret && showCaret && caret.row === row ? inverse(label) : KIND_STYLE[item.kind](label);
				lines.push(`${head}${badge} ${dim("─".repeat(width))}`);
				continue;
			}
			let out = " ".repeat(INDENT);
			if (current.cells.length === 0) {
				if (showCaret && caret && caret.row === row) out += inverse(" ");
				else if (covers(selections, current.itemId, current.start)) out += `\x1b[${SELECTED}m \x1b[0m`;
				lines.push(out);
				continue;
			}
			let style = "";
			let buffer = "";
			const flush = () => {
				if (buffer === "") return;
				out += style === "" ? buffer : `\x1b[${style}m${buffer}\x1b[0m`;
				buffer = "";
			};
			current.cells.forEach((cell, col) => {
				const codes: string[] = [];
				if (showCaret && caret && caret.row === row && caret.col === col) codes.push("7");
				else if (covers(selections, current.itemId, cell.offset)) codes.push(SELECTED);
				if (covers(marks, current.itemId, cell.offset)) codes.push(MARKED);
				const next = codes.join(";");
				if (next !== style) {
					flush();
					style = next;
				}
				buffer += cell.text;
			});
			flush();
			lines.push(out);
		}
		return lines;
	}
}
