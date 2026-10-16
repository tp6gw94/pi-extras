import type { Annotation } from "../quote.ts";
import type { SnapshotItem } from "../snapshot.ts";
import {
	type Doc,
	type Layout,
	type Motion,
	type Position,
	type Range,
	type Shape,
	type Span,
	clampOffset,
	columnX,
	headerAt,
	isFolded,
	itemOf,
	lineRange,
	locate,
	messageRange,
	move,
	pageScroll,
	positionAt,
	quote,
	remap,
	search as findMatch,
	selectionRange,
	settle,
	spansOf,
	startOf,
} from "./document.ts";

export type ModeKind = "normal" | "visual" | "note" | "list" | "search" | "help";
export type Prefix = "" | "g" | "z";

export interface BrowseMode {
	kind: "normal";
	count: string;
	prefix: Prefix;
}

export interface VisualMode {
	kind: "visual";
	shape: Shape;
	anchor: Position;
	count: string;
	prefix: Prefix;
}

export interface ListMode {
	kind: "list";
	index: number;
}

export type PriorMode = BrowseMode | VisualMode | ListMode;

export interface NoteDraft {
	quote: string;
	spans: Span[];
	source: Position;
	index?: number;
	from: PriorMode;
}

export type Mode =
	| BrowseMode
	| VisualMode
	| { kind: "note"; draft: NoteDraft }
	| ListMode
	| { kind: "search"; prior: BrowseMode | VisualMode }
	| { kind: "help"; back: PriorMode; top: number };

export interface Note {
	id: string;
	quote: string;
	spans: Span[];
	source: Position;
	text: string;
}

export type Connection = { status: "live" } | { status: "closed"; reason: string };

export interface Model {
	items: readonly SnapshotItem[];
	expanded: ReadonlySet<string>;
	caret: Position | undefined;
	goalX: number;
	viewport: Position | undefined;
	version: number;
	seq: number;
	notes: Note[];
	nextNote: number;
	mode: Mode;
	connection: Connection;
	quitArmed: boolean;
	message?: { text: string; error: boolean };
	lastSearch?: { query: string; direction: 1 | -1 };
	sending: readonly string[] | undefined;
}

export type Effect =
	| { type: "send"; notes: readonly Annotation[] }
	| { type: "editNote"; initialText: string }
	| { type: "openSearch" }
	| { type: "exit" };

export interface Env {
	height: number;
	layoutOf(doc: Doc): Layout;
}

export interface Transition {
	model: Model;
	effects: Effect[];
}

export type Action =
	| { type: "move"; motion: Motion }
	| { type: "count"; digit: string }
	| { type: "prefix"; prefix: Prefix }
	| { type: "visual"; shape: Shape }
	| { type: "swapEnds" }
	| { type: "escape" }
	| { type: "annotate"; scope: "selectionOrLine" | "message" }
	| { type: "fold" }
	| { type: "foldAll"; folded: boolean }
	| { type: "center" }
	| { type: "openSearch" }
	| { type: "searchSubmit"; query: string }
	| { type: "searchRepeat"; reverse: boolean }
	| { type: "openHelp" }
	| { type: "helpScroll"; delta: 1 | -1 }
	| { type: "openList" }
	| { type: "listMove"; delta: 1 | -1 }
	| { type: "listJump" }
	| { type: "listEdit" }
	| { type: "listDelete" }
	| { type: "saveNote"; text: string }
	| { type: "cancelNote" }
	| { type: "send" }
	| { type: "otherKey" }
	| { type: "sent"; ids: readonly string[]; inserted: number; nextSeq: number }
	| { type: "conflict"; expectedSeq: number }
	| { type: "rejected"; reason: string }
	| { type: "failed"; reason: string }
	| { type: "update"; version: number; reset: boolean; items: readonly SnapshotItem[] }
	| { type: "disconnected"; reason: string }
	| { type: "quit" };

export interface Binding {
	keys: readonly string[];
	modes: readonly ModeKind[];
	action?: Action | Motion;
	group: string;
	label: string;
	global?: true;
}

const NORMAL: readonly ModeKind[] = ["normal"];
const VISUAL: readonly ModeKind[] = ["visual"];
const NORMAL_VISUAL: readonly ModeKind[] = ["normal", "visual"];
const LIST: readonly ModeKind[] = ["list"];
const HELP: readonly ModeKind[] = ["help"];
const NOTE: readonly ModeKind[] = ["note"];
const SEARCH: readonly ModeKind[] = ["search"];
const ALL_MODES: readonly ModeKind[] = ["normal", "visual", "note", "list", "search", "help"];

export const bindings: readonly Binding[] = [
	{ keys: ["h", "left"], modes: NORMAL_VISUAL, action: "left", group: "Move", label: "move by character" },
	{ keys: ["l", "right"], modes: NORMAL_VISUAL, action: "right", group: "Move", label: "move by character" },
	{ keys: ["j", "down"], modes: NORMAL_VISUAL, action: "down", group: "Move", label: "move by row" },
	{ keys: ["k", "up"], modes: NORMAL_VISUAL, action: "up", group: "Move", label: "move by row" },
	{ keys: ["w"], modes: NORMAL_VISUAL, action: "wordForward", group: "Move", label: "move by word" },
	{ keys: ["b"], modes: NORMAL_VISUAL, action: "wordBackward", group: "Move", label: "move by word" },
	{ keys: ["e"], modes: NORMAL_VISUAL, action: "wordEnd", group: "Move", label: "move by word" },
	{ keys: ["0", "home"], modes: NORMAL_VISUAL, action: "lineStart", group: "Move", label: "move within the line" },
	{ keys: ["^"], modes: NORMAL_VISUAL, action: "firstNonBlank", group: "Move", label: "move within the line" },
	{ keys: ["$", "end"], modes: NORMAL_VISUAL, action: "lineEnd", group: "Move", label: "move within the line" },
	{ keys: ["gg"], modes: NORMAL_VISUAL, action: "docStart", group: "Move", label: "document start" },
	{ keys: ["G"], modes: NORMAL_VISUAL, action: "docEnd", group: "Move", label: "document end" },
	{ keys: ["}"], modes: NORMAL_VISUAL, action: "itemNext", group: "Move", label: "jump between messages" },
	{ keys: ["{"], modes: NORMAL_VISUAL, action: "itemPrevious", group: "Move", label: "jump between messages" },
	{ keys: ["ctrl+d"], modes: NORMAL_VISUAL, action: "halfPageDown", group: "Move", label: "half page down" },
	{ keys: ["ctrl+u"], modes: NORMAL_VISUAL, action: "halfPageUp", group: "Move", label: "half page up" },
	{ keys: ["ctrl+f", "pageDown"], modes: NORMAL_VISUAL, action: "pageDown", group: "Move", label: "page down" },
	{ keys: ["ctrl+b", "pageUp"], modes: NORMAL_VISUAL, action: "pageUp", group: "Move", label: "page up" },
	{ keys: ["v"], modes: NORMAL_VISUAL, action: { type: "visual", shape: "char" }, group: "Select", label: "toggle select" },
	{ keys: ["V"], modes: NORMAL_VISUAL, action: { type: "visual", shape: "line" }, group: "Select", label: "toggle line select" },
	{ keys: ["o"], modes: VISUAL, action: { type: "swapEnds" }, group: "Select", label: "swap ends" },
	{ keys: ["escape", "q"], modes: VISUAL, action: { type: "escape" }, group: "Select", label: "leave visual" },
	{ keys: ["a"], modes: NORMAL_VISUAL, action: { type: "annotate", scope: "selectionOrLine" }, group: "Annotate", label: "note on selection/line" },
	{ keys: ["A"], modes: NORMAL_VISUAL, action: { type: "annotate", scope: "message" }, group: "Annotate", label: "note on whole message" },
	{ keys: ["enter"], modes: VISUAL, action: { type: "annotate", scope: "selectionOrLine" }, group: "Annotate", label: "note on selection" },
	{ keys: ["enter", "za"], modes: NORMAL, action: { type: "fold" }, group: "Tool output", label: "fold or unfold tool" },
	{ keys: ["zR"], modes: NORMAL_VISUAL, action: { type: "foldAll", folded: false }, group: "Tool output", label: "unfold all tools" },
	{ keys: ["zM"], modes: NORMAL_VISUAL, action: { type: "foldAll", folded: true }, group: "Tool output", label: "fold all tools" },
	{ keys: ["zz"], modes: NORMAL_VISUAL, action: { type: "center" }, group: "View", label: "center the caret" },
	{ keys: ["/"], modes: NORMAL, action: { type: "openSearch" }, group: "Search", label: "search" },
	{ keys: ["n"], modes: NORMAL, action: { type: "searchRepeat", reverse: false }, group: "Search", label: "next match" },
	{ keys: ["N"], modes: NORMAL, action: { type: "searchRepeat", reverse: true }, group: "Search", label: "previous match" },
	{ keys: ["escape"], modes: SEARCH, action: { type: "escape" }, group: "Search", label: "cancel search" },
	{ keys: ["tab"], modes: NORMAL_VISUAL, action: { type: "openList" }, group: "List", label: "notes list" },
	{ keys: ["j", "down"], modes: LIST, action: { type: "listMove", delta: 1 }, group: "List", label: "next note" },
	{ keys: ["k", "up"], modes: LIST, action: { type: "listMove", delta: -1 }, group: "List", label: "previous note" },
	{ keys: ["enter"], modes: LIST, action: { type: "listJump" }, group: "List", label: "jump to source" },
	{ keys: ["e"], modes: LIST, action: { type: "listEdit" }, group: "List", label: "edit note" },
	{ keys: ["d"], modes: LIST, action: { type: "listDelete" }, group: "List", label: "delete note" },
	{ keys: ["tab", "escape", "q"], modes: LIST, action: { type: "escape" }, group: "List", label: "back" },
	{ keys: ["enter"], modes: NOTE, group: "Note editor", label: "save note" },
	{ keys: ["ctrl+j", "shift+enter"], modes: NOTE, group: "Note editor", label: "new line" },
	{ keys: ["escape"], modes: NOTE, action: { type: "cancelNote" }, group: "Note editor", label: "cancel note" },
	{ keys: ["s"], modes: [...NORMAL, ...LIST], action: { type: "send" }, group: "Send", label: "send notes" },
	{ keys: ["?"], modes: ["normal", "visual", "list"], action: { type: "openHelp" }, group: "Help", label: "help" },
	{ keys: ["j", "down"], modes: HELP, action: { type: "helpScroll", delta: 1 }, group: "Help", label: "scroll down" },
	{ keys: ["k", "up"], modes: HELP, action: { type: "helpScroll", delta: -1 }, group: "Help", label: "scroll up" },
	{ keys: ["?", "escape", "q"], modes: HELP, action: { type: "escape" }, group: "Help", label: "close help" },
	{ keys: ["q"], modes: NORMAL, action: { type: "quit" }, group: "Quit", label: "quit" },
	{ keys: ["ctrl+c"], modes: ALL_MODES, action: { type: "quit" }, group: "Quit", label: "quit", global: true },
];

export const HINTS: Record<ModeKind, readonly (readonly [key: string, label: string])[]> = {
	normal: [["v", "select"], ["a", "note"], ["tab", "list"], ["s", "send"], ["q", "quit"], ["?", "help"]],
	visual: [["a", "note"], ["o", "swap"], ["escape", "leave"], ["tab", "list"], ["?", "help"]],
	list: [["enter", "jump"], ["e", "edit"], ["d", "delete"], ["tab", "back"], ["s", "send"], ["?", "help"]],
	note: [["enter", "save"], ["ctrl+j", "new line"], ["escape", "cancel"], ["ctrl+c", "quit"]],
	search: [],
	help: [["j", "scroll"], ["escape", "close"]],
};

const PASS_THROUGH: ReadonlySet<Action["type"]> = new Set(["otherKey", "update", "sent", "conflict", "rejected", "failed", "disconnected"]);

export function countOf(mode: Mode): number {
	if (mode.kind !== "normal" && mode.kind !== "visual") return 1;
	if (mode.count === "") return 1;
	return Math.min(10000, Number(mode.count));
}

export function pendingText(model: Model): string {
	if (model.mode.kind === "normal" || model.mode.kind === "visual") return `${model.mode.count}${model.mode.prefix}`;
	return "";
}

export function modeTag(model: Model): string {
	switch (model.mode.kind) {
		case "normal":
			return "NORMAL";
		case "visual":
			return model.mode.shape === "char" ? "VISUAL" : "V-LINE";
		case "note":
			return "NOTE";
		case "list":
			return "LIST";
		case "search":
			return "SEARCH";
		case "help":
			return "HELP";
	}
}

const KEY_NAMES: Record<string, string> = {
	left: "←",
	right: "→",
	up: "↑",
	down: "↓",
	"ctrl+d": "Ctrl-d",
	"ctrl+u": "Ctrl-u",
	"ctrl+f": "Ctrl-f",
	"ctrl+b": "Ctrl-b",
	"ctrl+c": "Ctrl-C",
	"ctrl+j": "Ctrl-J",
	"shift+enter": "Shift+Enter",
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
	group: string;
	keys: string;
	label: string;
	modes: string;
}

function keysOf(bindingKeys: readonly string[], into: string[]): string[] {
	for (const key of bindingKeys) {
		const shown = displayKey(key);
		if (!into.includes(shown)) into.push(shown);
	}
	return into;
}

export function helpLines(): HelpEntry[] {
	const rows = new Map<string, { group: string; label: string; modes: string; keys: string[] }>();
	for (const binding of bindings) {
		const modes = binding.modes.join("/");
		const id = `${binding.group}\0${binding.label}\0${modes}`;
		const row = rows.get(id) ?? { group: binding.group, label: binding.label, modes, keys: [] };
		keysOf(binding.keys, row.keys);
		rows.set(id, row);
	}
	return [...rows.values()].map(({ keys, ...row }) => ({ ...row, keys: keys.join(" ") }));
}

export type HelpRow = { heading: string } | HelpEntry;

export function helpRows(): HelpRow[] {
	const rows: HelpRow[] = [];
	let group: string | undefined;
	for (const entry of helpLines()) {
		if (entry.group !== group) rows.push({ heading: entry.group });
		group = entry.group;
		rows.push(entry);
	}
	return rows;
}

export function hintFor(kind: ModeKind): string {
	return HINTS[kind].map(([key, label]) => `${displayKey(key)} ${label}`).join(" · ");
}

function resolve(key: string, applies: (binding: Binding) => boolean): Action | undefined {
	const action = bindings.find((binding) => binding.action !== undefined && binding.keys.includes(key) && applies(binding))?.action;
	return typeof action === "string" ? { type: "move", motion: action } : action;
}

function actionFor(key: string, kind: ModeKind): Action | undefined {
	return resolve(key, (binding) => binding.modes.includes(kind));
}

export function quitWarning(model: Model): string | undefined {
	if (!model.quitArmed) return undefined;
	return `${model.notes.length} unsent note${model.notes.length === 1 ? "" : "s"}; press again to quit`;
}

function globalAction(key: string): Action | undefined {
	return resolve(key, (binding) => binding.global === true);
}

export function keyAction(model: Model, key: string): Action | undefined {
	const mode = model.mode;
	const global = globalAction(key);
	if (global) return global;
	if (mode.kind === "help") {
		return actionFor(key, "help") ?? { type: "escape" };
	}
	if (mode.kind === "note" || mode.kind === "search") return actionFor(key, mode.kind);
	if (mode.kind === "normal" || mode.kind === "visual") {
		if (mode.prefix) {
			return actionFor(mode.prefix + key, mode.kind) ?? { type: "prefix", prefix: "" };
		}
		if (key === "g" || key === "z") return { type: "prefix", prefix: key };
		if (/^[1-9]$/.test(key) || (key === "0" && mode.count !== "")) return { type: "count", digit: key };
	}
	return actionFor(key, mode.kind);
}

export function initialModel(items: readonly SnapshotItem[], version: number, seq: number): Model {
	const last = items.at(-1);
	return {
		items,
		expanded: new Set(),
		caret: last && startOf({ items, expanded: new Set() }, last),
		goalX: 0,
		viewport: last && headerAt(last.id),
		version,
		seq,
		notes: [],
		nextNote: 1,
		mode: { kind: "normal", count: "", prefix: "" },
		connection: { status: "live" },
		quitArmed: false,
		sending: undefined,
	};
}

function docOf(model: Model): Doc {
	return { items: model.items, expanded: model.expanded };
}

function resetBrowse(mode: Mode): Mode {
	if (mode.kind === "normal" || mode.kind === "visual") return { ...mode, count: "", prefix: "" };
	return mode;
}

function viewportRow(model: Model, canvas: Layout): number {
	const at = model.viewport ? locate(canvas, model.viewport) : undefined;
	return at ? at.row : 0;
}

function reveal(model: Model, canvas: Layout, height: number): void {
	const caret = model.caret;
	if (!caret) return;
	const at = locate(canvas, caret);
	if (!at) return;
	const top = viewportRow(model, canvas);
	const rows = Math.max(1, height);
	if (at.row < top) model.viewport = positionAt(canvas, at.row, 0) ?? model.viewport;
	else if (at.row >= top + rows) model.viewport = positionAt(canvas, at.row - rows + 1, 0) ?? model.viewport;
}

function scrollViewport(model: Model, canvas: Layout, height: number, delta: number): void {
	const top = viewportRow(model, canvas);
	const maxTop = Math.max(0, canvas.rows.length - Math.max(1, height));
	const target = Math.max(0, Math.min(maxTop, top + delta));
	model.viewport = positionAt(canvas, target, 0) ?? model.viewport;
}

function settleFolded(model: Model): void {
	const doc = docOf(model);
	if (model.caret) model.caret = settle(doc, model.caret);
	if (model.mode.kind === "visual") model.mode = { ...model.mode, anchor: settle(doc, model.mode.anchor) };
}

function expandTool(model: Model, itemId: string): void {
	const doc = docOf(model);
	const item = itemOf(doc, itemId);
	if (!item || !isFolded(doc, item)) return;
	const expanded = new Set(model.expanded);
	expanded.add(item.id);
	model.expanded = expanded;
}

function nearestPosition(doc: Doc, previous: readonly SnapshotItem[], pos: Position): Position | undefined {
	const index = previous.findIndex((item) => item.id === pos.itemId);
	const ids = new Set(doc.items.map((item) => item.id));
	for (let i = index - 1; i >= 0; i--) {
		if (ids.has(previous[i]!.id)) return headerAt(previous[i]!.id);
	}
	for (let i = index + 1; i < previous.length; i++) {
		if (ids.has(previous[i]!.id)) return headerAt(previous[i]!.id);
	}
	const first = doc.items[0];
	return first ? headerAt(first.id) : undefined;
}

function applyUpdate(model: Model, action: Extract<Action, { type: "update" }>): void {
	const previous = model.items;
	const items = action.reset ? [...action.items] : [...previous, ...action.items];
	model.items = items;
	model.version = action.version;
	const doc = docOf(model);
	if (!action.reset) {
		const last = items.at(-1);
		if (!model.caret && last) {
			model.caret = startOf(doc, last);
			model.viewport = headerAt(last.id);
		}
		return;
	}

	const before: Doc = { items: previous, expanded: model.expanded };
	const changed = (pos: Position): boolean => {
		const after = itemOf(doc, pos.itemId);
		const prior = itemOf(before, pos.itemId);
		return !after || !prior || after.text !== prior.text;
	};
	const caret = model.caret;
	let cleared = false;
	const carry = <T extends PriorMode>(mode: T): T | BrowseMode => {
		if (mode.kind !== "visual") return mode;
		if (changed(mode.anchor) || !caret || changed(caret)) {
			cleared = true;
			return { kind: "normal", count: "", prefix: "" };
		}
		return { ...mode, anchor: remap(doc, mode.anchor) ?? mode.anchor };
	};
	const mode = model.mode;
	switch (mode.kind) {
		case "visual":
			model.mode = carry(mode);
			break;
		case "note":
			model.mode = { ...mode, draft: { ...mode.draft, from: carry(mode.draft.from) } };
			break;
		case "search":
			model.mode = { ...mode, prior: carry(mode.prior) };
			break;
		case "help":
			model.mode = { ...mode, back: carry(mode.back) };
			break;
	}
	if (caret) model.caret = remap(doc, caret) ?? nearestPosition(doc, previous, caret);
	if (model.viewport) model.viewport = remap(doc, model.viewport) ?? nearestPosition(doc, previous, model.viewport);
	if (cleared) model.message = { text: "selection cleared: conversation changed", error: false };
}

export function reduce(model: Model, action: Action, env: Env): Transition {
	const effects: Effect[] = [];
	const next: Model = { ...model };
	if (!PASS_THROUGH.has(action.type)) {
		next.message = undefined;
		if (action.type !== "quit") next.quitArmed = false;
	}
	switch (action.type) {
		case "count": {
			if (next.mode.kind === "normal" || next.mode.kind === "visual") next.mode = { ...next.mode, count: (next.mode.count + action.digit).slice(-4) };
			break;
		}
		case "prefix": {
			if (next.mode.kind === "normal" || next.mode.kind === "visual") next.mode = { ...next.mode, prefix: action.prefix, count: action.prefix === "" ? "" : next.mode.count };
			break;
		}
		case "move": {
			if (!next.caret) break;
			const times = countOf(next.mode);
			const doc = docOf(next);
			const canvas = env.layoutOf(doc);
			let result = { pos: next.caret, goalX: next.goalX };
			for (let i = 0; i < times; i++) result = move(doc, canvas, result.pos, result.goalX, action.motion, env.height);
			next.caret = result.pos;
			next.goalX = result.goalX;
			next.mode = resetBrowse(next.mode);
			const scroll = pageScroll(action.motion, env.height);
			if (scroll !== undefined) scrollViewport(next, canvas, env.height, scroll);
			break;
		}
		case "visual": {
			if (!next.caret) break;
			if (next.mode.kind === "visual") next.mode = next.mode.shape === action.shape ? { kind: "normal", count: "", prefix: "" } : { ...next.mode, shape: action.shape };
			else if (next.mode.kind === "normal") next.mode = { kind: "visual", shape: action.shape, anchor: next.caret, count: "", prefix: "" };
			break;
		}
		case "swapEnds": {
			if (next.mode.kind !== "visual" || !next.caret) break;
			const anchor = next.mode.anchor;
			next.mode = { ...next.mode, anchor: next.caret };
			next.caret = anchor;
			next.goalX = columnX(env.layoutOf(docOf(next)), anchor);
			break;
		}
		case "escape": {
			const mode = next.mode;
			if (mode.kind === "visual") next.mode = { kind: "normal", count: "", prefix: "" };
			else if (mode.kind === "note") next.mode = mode.draft.from;
			else if (mode.kind === "list") next.mode = { kind: "normal", count: "", prefix: "" };
			else if (mode.kind === "search") next.mode = mode.prior;
			else if (mode.kind === "help") next.mode = mode.back;
			break;
		}
		case "annotate": {
			if (!next.caret) break;
			const mode = next.mode;
			if (mode.kind !== "normal" && mode.kind !== "visual") break;
			const doc = docOf(next);
			let range: Range | undefined;
			let includeFolded = false;
			if (action.scope === "message") {
				range = messageRange(doc, next.caret);
				includeFolded = true;
			} else if (mode.kind === "visual") {
				range = selectionRange(doc, mode.shape, mode.anchor, next.caret);
			} else {
				if (next.caret.header) {
					range = messageRange(doc, next.caret);
					includeFolded = true;
				} else {
					range = lineRange(doc, next.caret);
				}
			}
			const text = range ? quote(doc, range, includeFolded) : undefined;
			if (!range || text === undefined) {
				next.message = { text: "nothing to quote here", error: true };
				break;
			}
			next.mode = { kind: "note", draft: { quote: text, spans: spansOf(doc, range), source: range.start, from: mode } };
			effects.push({ type: "editNote", initialText: "" });
			break;
		}
		case "fold": {
			if (!next.caret) break;
			const item = itemOf(docOf(next), next.caret.itemId);
			if (!item || item.kind !== "tool") break;
			const folding = next.expanded.has(item.id);
			const expanded = new Set(next.expanded);
			if (folding) expanded.delete(item.id);
			else expanded.add(item.id);
			next.expanded = expanded;
			settleFolded(next);
			break;
		}
		case "foldAll": {
			const expanded = new Set<string>();
			if (!action.folded) {
				for (const item of next.items) {
					if (item.kind === "tool") expanded.add(item.id);
				}
			}
			next.expanded = expanded;
			settleFolded(next);
			break;
		}
		case "center": {
			if (!next.caret) break;
			const canvas = env.layoutOf(docOf(next));
			const at = locate(canvas, next.caret);
			if (at) next.viewport = positionAt(canvas, Math.max(0, at.row - Math.floor(env.height / 2)), 0) ?? next.viewport;
			break;
		}
		case "openSearch": {
			if (next.mode.kind !== "normal" && next.mode.kind !== "visual") break;
			next.mode = { kind: "search", prior: next.mode };
			effects.push({ type: "openSearch" });
			break;
		}
		case "searchSubmit": {
			const mode = next.mode;
			if (mode.kind !== "search") break;
			next.mode = mode.prior;
			const query = action.query;
			if (query.trim() === "" || !next.caret) break;
			const hit = findMatch(docOf(next), next.caret, query, 1);
			if (!hit) {
				next.message = { text: `not found: ${query}`, error: true };
				break;
			}
			next.caret = hit;
			next.lastSearch = { query, direction: 1 };
			expandTool(next, hit.itemId);
			next.goalX = columnX(env.layoutOf(docOf(next)), hit);
			break;
		}
		case "searchRepeat": {
			if (!next.lastSearch) {
				next.message = { text: "no previous search", error: true };
				break;
			}
			if (!next.caret) break;
			const direction = (action.reverse ? -next.lastSearch.direction : next.lastSearch.direction) as 1 | -1;
			const hit = findMatch(docOf(next), next.caret, next.lastSearch.query, direction);
			if (!hit) {
				next.message = { text: `not found: ${next.lastSearch.query}`, error: true };
				break;
			}
			next.caret = hit;
			expandTool(next, hit.itemId);
			next.goalX = columnX(env.layoutOf(docOf(next)), hit);
			break;
		}
		case "openHelp": {
			if (next.mode.kind === "normal" || next.mode.kind === "visual" || next.mode.kind === "list") next.mode = { kind: "help", back: next.mode, top: 0 };
			break;
		}
		case "helpScroll": {
			if (next.mode.kind !== "help") break;
			const top = next.mode.top + action.delta;
			next.mode = { ...next.mode, top: Math.max(0, Math.min(Math.max(0, helpRows().length - env.height), top)) };
			break;
		}
		case "openList": {
			if (next.mode.kind === "normal" || next.mode.kind === "visual") next.mode = { kind: "list", index: 0 };
			break;
		}
		case "listMove": {
			if (next.mode.kind !== "list") break;
			next.mode = { kind: "list", index: Math.max(0, Math.min(next.notes.length - 1, next.mode.index + action.delta)) };
			break;
		}
		case "listJump": {
			if (next.mode.kind !== "list") break;
			const note = next.notes[next.mode.index];
			if (!note) break;
			const item = itemOf(docOf(next), note.source.itemId);
			if (!item) {
				next.message = { text: "the note's source is gone", error: true };
				break;
			}
			next.caret = { itemId: item.id, offset: clampOffset(item.text, note.source.offset) };
			expandTool(next, item.id);
			next.mode = { kind: "normal", count: "", prefix: "" };
			break;
		}
		case "listEdit": {
			if (next.mode.kind !== "list") break;
			const note = next.notes[next.mode.index];
			if (!note) break;
			next.mode = { kind: "note", draft: { quote: note.quote, spans: note.spans, source: note.source, index: next.mode.index, from: next.mode } };
			effects.push({ type: "editNote", initialText: note.text });
			break;
		}
		case "listDelete": {
			if (next.mode.kind !== "list") break;
			const note = next.notes[next.mode.index];
			if (!note) break;
			next.notes = next.notes.filter((entry) => entry !== note);
			next.mode = { kind: "list", index: Math.max(0, Math.min(next.mode.index, next.notes.length - 1)) };
			next.message = { text: "deleted", error: false };
			break;
		}
		case "saveNote": {
			if (next.mode.kind !== "note") break;
			const draft = next.mode.draft;
			const text = action.text.trim();
			if (draft.index !== undefined && next.notes[draft.index]) {
				next.notes = next.notes.map((note, index) => (index === draft.index ? { ...note, text } : note));
				next.mode = draft.from;
			} else {
				next.notes = [...next.notes, { id: `note-${next.nextNote}`, quote: draft.quote, spans: draft.spans, source: draft.source, text }];
				next.nextNote += 1;
				next.mode = { kind: "normal", count: "", prefix: "" };
				next.message = { text: `added note ${next.notes.length}; press s to send, Tab to review`, error: false };
			}
			break;
		}
		case "cancelNote": {
			if (next.mode.kind === "note") next.mode = next.mode.draft.from;
			break;
		}
		case "send": {
			if (next.connection.status === "closed") {
				next.message = { text: next.connection.reason, error: true };
				break;
			}
			if (next.sending) break;
			if (next.notes.length === 0) {
				next.message = { text: "nothing to send; select text with v and press a", error: true };
				break;
			}
			next.sending = next.notes.map((note) => note.id);
			next.message = { text: "sending…", error: false };
			effects.push({ type: "send", notes: next.notes.map(({ quote, text }) => ({ quote, note: text })) });
			break;
		}
		case "sent": {
			const ids = new Set(action.ids);
			next.notes = next.notes.filter((note) => !ids.has(note.id));
			next.sending = undefined;
			next.seq = action.nextSeq;
			next.message = { text: `sent ${action.inserted} to the pi editor`, error: false };
			break;
		}
		case "conflict": {
			next.sending = undefined;
			next.seq = action.expectedSeq;
			next.message = { text: "another client sent first; your notes are kept, press s again", error: true };
			break;
		}
		case "rejected": {
			next.sending = undefined;
			next.message = { text: action.reason, error: true };
			break;
		}
		case "failed": {
			next.sending = undefined;
			next.connection = { status: "closed", reason: action.reason };
			next.message = { text: action.reason, error: true };
			break;
		}
		case "update": {
			applyUpdate(next, action);
			break;
		}
		case "disconnected": {
			next.connection = { status: "closed", reason: action.reason };
			next.message = { text: action.reason, error: true };
			break;
		}
		case "otherKey": {
			next.quitArmed = false;
			break;
		}
		case "quit": {
			if (next.notes.length > 0 && !next.quitArmed) {
				next.quitArmed = true;
				next.mode = resetBrowse(next.mode.kind === "search" ? next.mode.prior : next.mode);
				break;
			}
			effects.push({ type: "exit" });
			break;
		}
	}
	if (next.notes.length === 0) next.quitArmed = false;
	reveal(next, env.layoutOf(docOf(next)), env.height);
	return { model: next, effects };
}
