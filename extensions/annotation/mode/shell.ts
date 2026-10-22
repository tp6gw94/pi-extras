import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, Editor, type Focusable, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { Action, Mode, Notebook, Outcome, Place, State } from "./data.ts";
import type { Attachment, Hooks } from "./host.ts";
import { keyOf } from "./keys.ts";
import { decorationsOf, type Palette, paintRows } from "./paint.ts";
import { helpRows, initialState, keyAction, reduce, statusOf } from "./state.ts";
import type { Transcript } from "./transcript.ts";

export interface ShellOptions {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly notebook: Notebook;
	readonly commit: (next: Notebook) => void;
	readonly finish: (outcome: Outcome) => void;
	readonly isIdle: () => boolean;
}

function anchorOf(mode: Mode): Place | undefined {
	if (mode.kind === "note") return anchorOf(mode.draft.back);
	if (mode.kind === "help") return anchorOf(mode.back);
	return mode.kind === "visual" ? mode.selection.anchor : undefined;
}

function changed(doc: Transcript, place: Place): boolean {
	const settled = doc.settle(place);
	return !settled || settled.line !== place.line || settled.char !== place.char;
}

export class AnnotationDock implements Component, Focusable {
	private readonly options: ShellOptions;
	private readonly editor: Editor;
	private attachment!: Attachment;
	private state!: State;
	private palette!: Palette;
	private focusedFlag = false;
	private phase: "active" | "evicted" | "disposed" = "active";
	private lastRenderFrame = 0;
	private renderedHeight = 0;
	private settleTask: NodeJS.Immediate | undefined;
	private capturePending = false;

	constructor(options: ShellOptions) {
		this.options = options;
		const muted = (text: string) => options.theme.fg("muted", text);
		this.editor = new Editor(options.tui, {
			borderColor: (text) => options.theme.fg("border", text),
			selectList: { selectedPrefix: (text) => options.theme.fg("accent", text), selectedText: (text) => text, description: muted, scrollInfo: muted, noMatch: muted },
		});
		this.editor.onSubmit = (text) => this.dispatch({ type: "saveNote", text });
		this.invalidate();
	}

	bind(attachment: Attachment): this | undefined {
		this.attachment = attachment;
		const state = initialState(attachment.doc, attachment.viewport(), this.options.notebook);
		if (!state) return undefined;
		this.state = state;
		return this;
	}

	get focused(): boolean { return this.focusedFlag; }

	set focused(value: boolean) {
		this.focusedFlag = value;
		this.syncFocus();
	}

	hooks(): Hooks {
		return {
			onCapture: (doc) => {
				const anchor = anchorOf(this.state.mode);
				if (!changed(doc, this.state.caret) && (!anchor || !changed(doc, anchor))) return;
				if (this.capturePending) return;
				this.capturePending = true;
				queueMicrotask(() => {
					this.capturePending = false;
					this.dispatch({ type: "docChanged" });
				});
			},
			paint: (rows, doc) => {
				const mode = this.state.mode;
				const projected = {
					...this.state,
					caret: doc.settle(this.state.caret) ?? this.state.caret,
					mode: mode.kind === "visual" ? { ...mode, selection: { ...mode.selection, anchor: doc.settle(mode.selection.anchor) ?? mode.selection.anchor } } : mode,
				};
				return paintRows(rows, doc, decorationsOf(doc, projected), this.palette);
			},
			alive: (frame) => {
				if (frame - this.lastRenderFrame > 2) this.phase = "evicted";
				return this.phase === "active";
			},
			onEvicted: () => this.dispose(),
			onFullscreenLeft: () => this.finish({ kind: "detached", reason: "left fullscreen" }),
		};
	}

	handleInput(data: string): void {
		if (this.phase !== "active") return;
		if (!this.attachment.stillFullscreen()) {
			this.finish({ kind: "detached", reason: "left fullscreen" });
			return;
		}
		const key = keyOf(data);
		const action = key === undefined ? undefined : keyAction(this.state, key);
		if (action) this.dispatch(action);
		else if (this.state.mode.kind === "note") {
			this.editor.handleInput(data);
			this.options.tui.requestRender();
		} else this.dispatch({ type: "otherKey" });
	}

	render(width: number): string[] {
		if (this.phase !== "active") return [];
		this.lastRenderFrame = this.attachment.frame;
		const height = Math.floor(this.options.tui.terminal.rows / 3);
		const panelHeight = Math.max(0, height - 1);
		const mode = this.state.mode;
		let panel: string[] = [];
		if (mode.kind === "note") panel = this.renderNote(width, panelHeight);
		else if (mode.kind === "list") {
			const notes = this.state.notebook.notes;
			const top = Math.max(0, mode.index - panelHeight + 1);
			panel = notes.length === 0 ? ["No notes yet; select text with v and press a."] : notes.slice(top, top + panelHeight).map((note, offset) => {
				const index = top + offset;
				return `${index === mode.index ? ">" : " "} ${index + 1}. ${note.quote.split("\n")[0]} — ${note.text.split("\n")[0] || "(no note)"}`;
			});
		} else if (mode.kind === "help") panel = helpRows().slice(mode.top, mode.top + panelHeight).map((row) => "heading" in row ? row.heading : `  ${row.keys}  ${row.label}  ${row.modes}`);
		const lines = [this.renderStatus(), ...panel].slice(0, height).map((line) => truncateToWidth(line, width));
		if (lines.length !== this.renderedHeight) {
			this.renderedHeight = lines.length;
			this.scheduleSettle();
		}
		return lines;
	}

	invalidate(): void {
		this.palette = { caret: "\x1b[7m", noted: "\x1b[4m", selected: this.options.theme.getBgAnsi("selectedBg") };
		this.editor.invalidate();
	}

	dispose(): void {
		if (this.phase === "disposed") return;
		this.phase = "disposed";
		if (this.settleTask) clearImmediate(this.settleTask);
		this.editor.focused = false;
		this.attachment?.detach();
	}

	private finish(outcome: Outcome): void {
		if (this.phase !== "active") return;
		this.dispose();
		this.options.finish(outcome);
	}

	private dispatch(action: Action): void {
		if (this.phase !== "active") return;
		const previous = this.state;
		const { state, effects } = reduce(previous, action, { doc: this.attachment.doc, viewport: this.attachment.viewport() });
		this.state = state;
		if (state.notebook !== previous.notebook) this.options.commit(state.notebook);
		this.syncFocus();
		for (const effect of effects) {
			if (effect.type === "editNote") this.editor.setText(effect.initialText);
			else if (effect.type === "scroll") this.attachment.scrollTo(effect.top);
			else {
				this.finish(effect.outcome);
				return;
			}
		}
		this.options.tui.requestRender();
	}

	private syncFocus(): void {
		this.editor.focused = this.phase === "active" && this.focusedFlag && this.state.mode.kind === "note";
	}

	private scheduleSettle(): void {
		if (this.settleTask) return;
		this.settleTask = setImmediate(() => {
			this.settleTask = undefined;
			this.dispatch({ type: "docChanged" });
		});
	}

	private renderStatus(): string {
		const { tag, pending, text, error } = statusOf(this.state);
		const doc = this.attachment.doc;
		const caret = doc.settle(this.state.caret);
		const row = caret ? doc.rowOf(caret)! : undefined;
		const position = caret && row !== undefined ? `${row + 1}:${doc.text(row).x[caret.char] + 1}` : "—";
		const notes = this.state.notebook.notes.length;
		const busy = this.options.isIdle() ? "" : " · working";
		return `${tag}${pending ? ` ${pending}` : ""} · ${position} · ${notes} note${notes === 1 ? "" : "s"}${busy}  ${this.options.theme.fg(error ? "error" : "muted", text)}`;
	}

	private renderNote(width: number, height: number): string[] {
		if (height === 0) return [];
		const mode = this.state.mode;
		const preview = mode.kind === "note" && height >= 4 ? [this.options.theme.fg("muted", `> ${mode.draft.quote.split("\n")[0]}`)] : [];
		const available = height - preview.length;
		const lines = this.editor.render(width);
		const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		const top = Math.max(0, Math.min(cursor - available + 1, lines.length - available));
		return [...preview, ...lines.slice(top, top + available)];
	}
}
