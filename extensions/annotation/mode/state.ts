import type { Action, Browse, Effect, Mode, ModeKind, Motion, Notebook, Resting, RowChar, RowSpan, State, Transition, Viewport } from "./data.ts";
import { move, pageDelta } from "./motion.ts";
import type { Transcript } from "./transcript.ts";

export interface ViewEnv {
	readonly doc: Transcript;
	readonly viewport: Viewport;
}

export interface Binding {
	readonly keys: readonly string[];
	readonly modes: readonly ModeKind[];
	readonly action?: Action;
	readonly group: string;
	readonly label: string;
	readonly hint?: string;
}

const NORMAL: readonly ModeKind[] = ["normal"];
const VISUAL: readonly ModeKind[] = ["visual"];
const BROWSE: readonly ModeKind[] = ["normal", "visual"];
const LIST: readonly ModeKind[] = ["list"];
const HELP: readonly ModeKind[] = ["help"];
const NOTE: readonly ModeKind[] = ["note"];
const BROWSING: Browse = { kind: "normal", count: "", prefix: "" };

const motion = (keys: readonly string[], target: Motion, label: string): Binding => ({ keys, modes: BROWSE, action: { type: "move", motion: target }, group: "Move", label });

export const bindings: readonly Binding[] = [
	motion(["h", "left"], "left", "move by character"),
	motion(["l", "right"], "right", "move by character"),
	motion(["j", "down"], "down", "move by row"),
	motion(["k", "up"], "up", "move by row"),
	motion(["w"], "wordForward", "move by word"),
	motion(["b"], "wordBackward", "move by word"),
	motion(["e"], "wordEnd", "move by word"),
	motion(["0", "home"], "lineStart", "move within the row"),
	motion(["^"], "firstNonBlank", "move within the row"),
	motion(["$", "end"], "lineEnd", "move within the row"),
	motion(["gg"], "docStart", "transcript start"),
	motion(["G"], "docEnd", "transcript end"),
	motion(["}"], "unitNext", "jump between messages"),
	motion(["{"], "unitPrevious", "jump between messages"),
	motion(["ctrl+d"], "halfPageDown", "half page down"),
	motion(["ctrl+u"], "halfPageUp", "half page up"),
	motion(["ctrl+f", "pageDown"], "pageDown", "page down"),
	motion(["ctrl+b", "pageUp"], "pageUp", "page up"),
	{ keys: ["v"], modes: BROWSE, action: { type: "visual", shape: "char" }, group: "Select", label: "toggle select", hint: "select" },
	{ keys: ["V"], modes: BROWSE, action: { type: "visual", shape: "line" }, group: "Select", label: "toggle line select" },
	{ keys: ["o"], modes: VISUAL, action: { type: "swapEnds" }, group: "Select", label: "swap ends", hint: "swap" },
	{ keys: ["escape", "q"], modes: VISUAL, action: { type: "back" }, group: "Select", label: "leave visual", hint: "leave" },
	{ keys: ["a"], modes: BROWSE, action: { type: "annotate", scope: "selectionOrLine" }, group: "Annotate", label: "note on selection or row", hint: "note" },
	{ keys: ["A"], modes: BROWSE, action: { type: "annotate", scope: "unit" }, group: "Annotate", label: "note on whole message" },
	{ keys: ["enter"], modes: NOTE, group: "Note editor", label: "save note", hint: "save" },
	{ keys: ["escape", "ctrl+c"], modes: NOTE, action: { type: "back" }, group: "Note editor", label: "cancel note", hint: "cancel" },
	{ keys: ["tab"], modes: BROWSE, action: { type: "openList" }, group: "List", label: "notes list", hint: "list" },
	{ keys: ["j", "down"], modes: LIST, action: { type: "listMove", delta: 1 }, group: "List", label: "next note" },
	{ keys: ["k", "up"], modes: LIST, action: { type: "listMove", delta: -1 }, group: "List", label: "previous note" },
	{ keys: ["e"], modes: LIST, action: { type: "listEdit" }, group: "List", label: "edit note", hint: "edit" },
	{ keys: ["d"], modes: LIST, action: { type: "listDelete" }, group: "List", label: "delete note", hint: "delete" },
	{ keys: ["tab", "escape", "q"], modes: LIST, action: { type: "back" }, group: "List", label: "back", hint: "back" },
	{ keys: ["s"], modes: ["normal", "list"], action: { type: "deliver", delivery: "editor" }, group: "Send", label: "append notes to the editor", hint: "editor" },
	{ keys: ["S"], modes: ["normal", "list"], action: { type: "deliver", delivery: "agent" }, group: "Send", label: "submit notes to pi", hint: "submit" },
	{ keys: ["ctrl+c"], modes: ["normal", "visual", "list", "help"], action: { type: "quit" }, group: "Quit", label: "quit" },
	{ keys: ["q", "escape"], modes: NORMAL, action: { type: "quit" }, group: "Quit", label: "quit", hint: "quit" },
	{ keys: ["?"], modes: ["normal", "visual", "list"], action: { type: "openHelp" }, group: "Help", label: "help", hint: "help" },
	{ keys: ["j", "down"], modes: HELP, action: { type: "helpScroll", delta: 1 }, group: "Help", label: "scroll down", hint: "scroll" },
	{ keys: ["k", "up"], modes: HELP, action: { type: "helpScroll", delta: -1 }, group: "Help", label: "scroll up" },
	{ keys: ["escape", "?", "q"], modes: HELP, action: { type: "back" }, group: "Help", label: "close help", hint: "close" },
];

const KEY_NAMES: Record<string, string> = {
	left: "←",
	right: "→",
	up: "↑",
	down: "↓",
	"ctrl+d": "Ctrl-d",
	"ctrl+u": "Ctrl-u",
	"ctrl+f": "Ctrl-f",
	"ctrl+b": "Ctrl-b",
	"ctrl+c": "Ctrl-c",
	pageDown: "PgDn",
	pageUp: "PgUp",
	enter: "Enter",
	tab: "Tab",
	escape: "Esc",
	home: "Home",
	end: "End",
};

export function displayKey(key: string): string {
	return KEY_NAMES[key] ?? key;
}

export interface HelpEntry {
	readonly group: string;
	readonly keys: string;
	readonly label: string;
	readonly modes: string;
}

export type HelpRow = { readonly heading: string } | HelpEntry;

export function helpRows(): HelpRow[] {
	const entries = new Map<string, { group: string; label: string; modes: string; keys: string[] }>();
	for (const binding of bindings) {
		const modes = binding.modes.join("/");
		const key = `${binding.group}\0${binding.label}\0${modes}`;
		const entry = entries.get(key) ?? { group: binding.group, label: binding.label, modes, keys: [] };
		for (const key of binding.keys) {
			const shown = displayKey(key);
			if (!entry.keys.includes(shown)) entry.keys.push(shown);
		}
		entries.set(key, entry);
	}
	const rows: HelpRow[] = [];
	let group: string | undefined;
	for (const entry of entries.values()) {
		if (entry.group !== group) rows.push({ heading: entry.group });
		group = entry.group;
		rows.push({ group: entry.group, keys: entry.keys.join(" "), label: entry.label, modes: entry.modes });
	}
	return rows;
}

export function hintFor(kind: ModeKind): string {
	return bindings
		.filter((binding) => binding.hint !== undefined && binding.modes.includes(kind))
		.map((binding) => `${displayKey(binding.keys[0])} ${binding.hint}`)
		.join(" · ");
}

export function modeTag(mode: Mode): string {
	switch (mode.kind) {
		case "normal":
			return "NORMAL";
		case "visual":
			return mode.selection.shape === "char" ? "VISUAL" : "V-LINE";
		case "note":
			return "NOTE";
		case "list":
			return "LIST";
		case "help":
			return "HELP";
	}
}

export function pendingText(mode: Mode): string {
	return mode.kind === "normal" || mode.kind === "visual" ? `${mode.count}${mode.prefix}` : "";
}

export function statusOf(state: State): { tag: string; text: string; error: boolean; pending: string } {
	return { tag: modeTag(state.mode), text: state.message?.text ?? hintFor(state.mode.kind), error: state.message?.error ?? false, pending: pendingText(state.mode) };
}

function actionFor(key: string, kind: ModeKind): Action | undefined {
	return bindings.find((binding) => binding.action !== undefined && binding.keys.includes(key) && binding.modes.includes(kind))?.action;
}

export function keyAction(state: State, key: string): Action | undefined {
	const mode = state.mode;
	switch (mode.kind) {
		case "note":
		case "list":
			return actionFor(key, mode.kind);
		case "help":
			return actionFor(key, "help") ?? { type: "back" };
		default:
			if (key === "ctrl+c") return actionFor(key, mode.kind);
			if (mode.prefix !== "") return actionFor(mode.prefix + key, mode.kind) ?? { type: "prefix", prefix: "" };
			if (key === "g") return { type: "prefix", prefix: "g" };
			if (/^[1-9]$/.test(key) || (key === "0" && mode.count !== "")) return { type: "count", digit: key };
			return actionFor(key, mode.kind);
	}
}

export function countOf(mode: Mode): number | undefined {
	if (mode.kind !== "normal" && mode.kind !== "visual") return undefined;
	return mode.count === "" ? undefined : Math.min(10000, Number(mode.count));
}

function entryAt(doc: Transcript, viewport: Viewport): RowChar | undefined {
	const last = Math.min(doc.rowCount, viewport.top + viewport.height);
	for (let row = Math.max(0, viewport.top); row < last; row++) {
		const text = doc.text(row);
		if (text.glyphs.length > 0) return { row, char: text.firstNonBlank };
	}
	const unit = doc.units.at(-1);
	if (unit) return { row: unit.firstRow, char: doc.text(unit.firstRow).firstNonBlank };
	return doc.rowCount > 0 ? { row: 0, char: 0 } : undefined;
}

export function initialState(doc: Transcript, viewport: Viewport, notebook: Notebook): State | undefined {
	const at = entryAt(doc, viewport);
	if (!at) return undefined;
	return { caret: doc.placeAt(at.row, at.char), goalX: doc.text(at.row).x[at.char], mode: BROWSING, notebook, quitArmed: false, message: undefined };
}

type Working = { -readonly [K in keyof State]: State[K] };

function seat(state: State, env: ViewEnv): Working | undefined {
	const doc = env.doc;
	const at = entryAt(doc, env.viewport);
	if (!at) return undefined;
	let dropped = false;
	const settleResting = <T extends Resting>(mode: T): T | Browse => {
		if (mode.kind !== "visual") return mode;
		const anchor = doc.settle(mode.selection.anchor);
		if (anchor) return { ...mode, selection: { ...mode.selection, anchor } };
		dropped = true;
		return BROWSING;
	};
	const settleMode = (): Mode => {
		switch (state.mode.kind) {
			case "visual":
				return settleResting(state.mode);
			case "note":
				return { ...state.mode, draft: { ...state.mode.draft, back: settleResting(state.mode.draft.back) } };
			case "help":
				return { ...state.mode, back: settleResting(state.mode.back) };
			default:
				return state.mode;
		}
	};
	const mode = settleMode();
	const settled = doc.settle(state.caret);
	if (settled && !dropped) return { ...state, caret: settled, mode };
	const caret = settled ?? doc.placeAt(at.row, at.char);
	const goalX = settled ? state.goalX : doc.text(at.row).x[at.char];
	const text = dropped ? "selection cleared: conversation changed" : "caret moved: conversation changed";
	return { ...state, caret, goalX, mode, message: { text, error: false } };
}

export function reduce(state: State, action: Action, env: ViewEnv): Transition {
	const doc = env.doc;
	const seated = seat(state, env);
	if (!seated) return { state, effects: [{ type: "exit", outcome: { kind: "detached", reason: "the conversation is empty" } }] };
	const next: Working = action.type === "docChanged" ? seated : { ...seated, message: undefined, quitArmed: action.type === "quit" && seated.quitArmed };
	const effects: Effect[] = [];
	const mode = next.mode;
	const row = doc.rowOf(next.caret)!;
	let top = env.viewport.top;
	const quit = (): void => {
		const count = next.notebook.notes.length;
		if (count > 0 && !next.quitArmed) {
			next.quitArmed = true;
			next.message = { text: `${count} unsent note${count === 1 ? "" : "s"}; press again to quit`, error: true };
			return;
		}
		effects.push({ type: "exit", outcome: { kind: "quit" } });
	};
	switch (action.type) {
		case "count": {
			if (mode.kind === "normal" || mode.kind === "visual") next.mode = { ...mode, count: (mode.count + action.digit).slice(-4) };
			break;
		}
		case "prefix": {
			if (mode.kind === "normal" || mode.kind === "visual") next.mode = { ...mode, prefix: action.prefix, count: action.prefix === "" ? "" : mode.count };
			break;
		}
		case "move": {
			if (mode.kind !== "normal" && mode.kind !== "visual") break;
			const count = countOf(mode);
			const result = move(doc, { row, char: next.caret.char }, next.goalX, action.motion, count, env.viewport.height);
			next.caret = doc.placeAt(result.row, result.char);
			next.goalX = result.goalX;
			const page = pageDelta(action.motion, env.viewport.height);
			if (page !== undefined) top += page * (count ?? 1);
			break;
		}
		case "visual": {
			if (mode.kind === "visual") next.mode = mode.selection.shape === action.shape ? BROWSING : { ...mode, selection: { ...mode.selection, shape: action.shape } };
			else if (mode.kind === "normal") next.mode = { kind: "visual", selection: { shape: action.shape, anchor: next.caret }, count: "", prefix: "" };
			break;
		}
		case "swapEnds": {
			if (mode.kind !== "visual") break;
			const anchor = mode.selection.anchor;
			next.mode = { ...mode, selection: { ...mode.selection, anchor: next.caret } };
			next.caret = anchor;
			next.goalX = doc.text(doc.rowOf(anchor)!).x[anchor.char];
			break;
		}
		case "annotate": {
			if (mode.kind !== "normal" && mode.kind !== "visual") break;
			let spans: RowSpan[];
			if (action.scope === "unit") spans = unitSpans(doc, row);
			else if (mode.kind === "visual") spans = doc.spansBetween(mode.selection.shape, mode.selection.anchor, next.caret);
			else spans = [{ row, from: 0, to: doc.text(row).glyphs.length }];
			const quote = doc.quote(spans);
			if (quote === undefined) {
				next.message = { text: "nothing to quote here", error: true };
				break;
			}
			next.mode = { kind: "note", draft: { quote, marks: doc.marksFor(spans), editing: undefined, back: mode } };
			effects.push({ type: "editNote", initialText: "" });
			break;
		}
		case "saveNote": {
			if (mode.kind !== "note") break;
			const draft = mode.draft;
			const text = action.text.trim();
			const notebook = next.notebook;
			if (draft.editing !== undefined) {
				next.notebook = { ...notebook, notes: notebook.notes.map((note) => (note.id === draft.editing ? { ...note, text } : note)) };
				next.mode = draft.back;
				break;
			}
			const notes = [...notebook.notes, { id: notebook.nextId, quote: draft.quote, text, marks: draft.marks }];
			next.notebook = { ...notebook, notes, nextId: notebook.nextId + 1 };
			next.mode = BROWSING;
			next.message = { text: `added note ${notes.length}; s to append, S to submit, Tab to review`, error: false };
			break;
		}
		case "back": {
			if (mode.kind === "normal") quit();
			else if (mode.kind === "note") next.mode = mode.draft.back;
			else if (mode.kind === "help") next.mode = mode.back;
			else next.mode = BROWSING;
			break;
		}
		case "openList": {
			if (mode.kind === "normal" || mode.kind === "visual") next.mode = { kind: "list", index: 0 };
			break;
		}
		case "listMove": {
			if (mode.kind === "list") next.mode = { kind: "list", index: Math.max(0, Math.min(next.notebook.notes.length - 1, mode.index + action.delta)) };
			break;
		}
		case "listEdit": {
			if (mode.kind !== "list") break;
			const note = next.notebook.notes[mode.index];
			if (!note) break;
			next.mode = { kind: "note", draft: { quote: note.quote, marks: note.marks, editing: note.id, back: mode } };
			effects.push({ type: "editNote", initialText: note.text });
			break;
		}
		case "listDelete": {
			if (mode.kind !== "list") break;
			const note = next.notebook.notes[mode.index];
			if (!note) break;
			const notes = next.notebook.notes.filter((entry) => entry !== note);
			next.notebook = { ...next.notebook, notes };
			next.mode = { kind: "list", index: Math.max(0, Math.min(mode.index, notes.length - 1)) };
			next.message = { text: "deleted", error: false };
			break;
		}
		case "openHelp": {
			if (mode.kind === "normal" || mode.kind === "visual" || mode.kind === "list") next.mode = { kind: "help", back: mode, top: 0 };
			break;
		}
		case "helpScroll": {
			if (mode.kind === "help") next.mode = { ...mode, top: Math.max(0, Math.min(helpRows().length - 1, mode.top + action.delta)) };
			break;
		}
		case "deliver": {
			const notes = next.notebook.notes;
			if (notes.length === 0) {
				next.message = { text: "no notes yet; select text with v and press a", error: true };
				break;
			}
			effects.push({ type: "exit", outcome: { kind: action.delivery === "editor" ? "append" : "submit", notes } });
			break;
		}
		case "quit": {
			quit();
			break;
		}
		case "otherKey":
		case "docChanged":
			break;
	}
	const keepsPending = action.type === "count" || action.type === "prefix" || action.type === "docChanged";
	if (!keepsPending && (next.mode.kind === "normal" || next.mode.kind === "visual")) {
		next.mode = { ...next.mode, count: "", prefix: "" };
	}
	const caretRow = doc.rowOf(next.caret)!;
	if (caretRow < top) top = caretRow;
	else if (caretRow >= top + env.viewport.height) top = caretRow - env.viewport.height + 1;
	if (top !== env.viewport.top) effects.push({ type: "scroll", top });
	return { state: next, effects };
}

function unitSpans(doc: Transcript, row: number): RowSpan[] {
	const unit = doc.unitAt(row);
	if (!unit) return [];
	const spans: RowSpan[] = [];
	for (let at = unit.firstRow; at <= unit.lastRow; at++) spans.push({ row: at, from: 0, to: doc.text(at).glyphs.length });
	return spans;
}
