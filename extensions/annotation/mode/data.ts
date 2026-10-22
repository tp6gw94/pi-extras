declare const blockBrand: unique symbol;
export type BlockId = number & { readonly [blockBrand]: true };

export interface Block {
	readonly id: BlockId;
	readonly start: number;
	readonly height: number;
}

export interface Place {
	readonly block: BlockId;
	readonly line: number;
	readonly char: number;
}

export interface RowText {
	readonly text: string;
	readonly glyphs: readonly string[];
	readonly x: readonly number[];
	readonly firstNonBlank: number;
}

export interface RowChar {
	readonly row: number;
	readonly char: number;
}

export interface RowSpan {
	readonly row: number;
	readonly from: number;
	readonly to: number;
}

export interface Unit {
	readonly block: BlockId;
	readonly firstRow: number;
	readonly lastRow: number;
}

export interface CodeRegion {
	readonly lang: string;
	readonly openRow: number;
	readonly closeRow: number | undefined;
	readonly prefix: string;
}

export type Shape = "char" | "line";

export interface Selection {
	readonly shape: Shape;
	readonly anchor: Place;
}

export interface Mark {
	readonly block: BlockId;
	readonly line: number;
	readonly from: number;
	readonly to: number;
	readonly text: string;
}

export interface Note {
	readonly id: number;
	readonly quote: string;
	readonly text: string;
	readonly marks: readonly Mark[];
}

export interface Notebook {
	readonly sessionId: string;
	readonly notes: readonly Note[];
	readonly nextId: number;
}

export type Prefix = "" | "g";
export type GoalX = number | "eol";

export interface Browse {
	readonly kind: "normal";
	readonly count: string;
	readonly prefix: Prefix;
}

export interface Visual {
	readonly kind: "visual";
	readonly selection: Selection;
	readonly count: string;
	readonly prefix: Prefix;
}

export interface ListView {
	readonly kind: "list";
	readonly index: number;
}

export type Resting = Browse | Visual | ListView;

export interface Draft {
	readonly quote: string;
	readonly marks: readonly Mark[];
	readonly editing: number | undefined;
	readonly back: Resting;
}

export type Mode =
	| Browse
	| Visual
	| { readonly kind: "note"; readonly draft: Draft }
	| ListView
	| { readonly kind: "help"; readonly back: Resting; readonly top: number };

export type ModeKind = Mode["kind"];

export interface Message {
	readonly text: string;
	readonly error: boolean;
}

export interface State {
	readonly caret: Place;
	readonly goalX: GoalX;
	readonly mode: Mode;
	readonly notebook: Notebook;
	readonly quitArmed: boolean;
	readonly message: Message | undefined;
}

export interface Viewport {
	readonly top: number;
	readonly height: number;
}

export type Motion =
	| "left"
	| "right"
	| "down"
	| "up"
	| "wordForward"
	| "wordBackward"
	| "wordEnd"
	| "lineStart"
	| "firstNonBlank"
	| "lineEnd"
	| "docStart"
	| "docEnd"
	| "unitNext"
	| "unitPrevious"
	| "halfPageDown"
	| "halfPageUp"
	| "pageDown"
	| "pageUp";

export type Action =
	| { readonly type: "move"; readonly motion: Motion }
	| { readonly type: "count"; readonly digit: string }
	| { readonly type: "prefix"; readonly prefix: Prefix }
	| { readonly type: "visual"; readonly shape: Shape }
	| { readonly type: "swapEnds" }
	| { readonly type: "annotate"; readonly scope: "selectionOrLine" | "unit" }
	| { readonly type: "saveNote"; readonly text: string }
	| { readonly type: "back" }
	| { readonly type: "openList" }
	| { readonly type: "listMove"; readonly delta: 1 | -1 }
	| { readonly type: "listEdit" }
	| { readonly type: "listDelete" }
	| { readonly type: "openHelp" }
	| { readonly type: "helpScroll"; readonly delta: 1 | -1 }
	| { readonly type: "deliver"; readonly delivery: "editor" | "agent" }
	| { readonly type: "quit" }
	| { readonly type: "otherKey" }
	| { readonly type: "docChanged" };

export type Outcome =
	| { readonly kind: "quit" }
	| { readonly kind: "append"; readonly notes: readonly Note[] }
	| { readonly kind: "submit"; readonly notes: readonly Note[] }
	| { readonly kind: "detached"; readonly reason: string };

export type Effect =
	| { readonly type: "editNote"; readonly initialText: string }
	| { readonly type: "scroll"; readonly top: number }
	| { readonly type: "exit"; readonly outcome: Outcome };

export interface Transition {
	readonly state: State;
	readonly effects: readonly Effect[];
}

export interface Decorations {
	readonly caret: RowChar | undefined;
	readonly selected: readonly RowSpan[];
	readonly noted: readonly RowSpan[];
}

export interface Capture {
	readonly width: number;
	readonly rows: readonly string[];
	readonly blocks: readonly { readonly id: BlockId; readonly height: number }[];
}
