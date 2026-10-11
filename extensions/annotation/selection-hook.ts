import type { ReleasePoint } from "./position.ts";

/**
 * Members of pi-tui's TuiAltScreen that annotation needs. The first three are private, so a pi
 * update can rename them; test/tui-members.test.ts checks them against the installed pi-tui.
 */
export const REQUIRED_MEMBERS = [
	"copySelectionToClipboard",
	"getActiveSelectionText",
	"clearTextSelection",
	"getCopyOnSelect",
	"setCopyOnSelect",
	"requestRender",
] as const;

/** Private member wrapped only to learn where the mouse was released. Without it the box opens at the bottom. */
export const POSITION_MEMBER = "handleSelectionMouseEvent";

export const PRIVATE_MEMBERS = ["copySelectionToClipboard", "getActiveSelectionText", "clearTextSelection", POSITION_MEMBER] as const;

export interface SelectionEnd {
	text: string;
	point?: ReleasePoint;
}

export interface SelectionHook {
	isCurrent(): boolean;
	clear(): void;
	screen(): { columns: number; rows: number } | undefined;
	release(): void;
}

export type BindResult = { kind: "bound"; hook: SelectionHook } | { kind: "not-fullscreen" } | { kind: "missing"; members: string[] };

type Fn = (this: unknown, ...args: any[]) => any;
type Obj = Record<PropertyKey, any>;

/**
 * pi hands extensions a proxy that forwards to the current renderer and calls methods with that
 * renderer as `this`. An own method that returns `this` therefore reveals the renderer itself.
 */
function rendererOf(tui: Obj): Obj | undefined {
	const probe = Symbol("annotation.renderer");
	try {
		tui[probe] = function (this: Obj) {
			return this;
		};
		const renderer = tui[probe]();
		if (renderer && typeof renderer === "object") {
			delete renderer[probe];
			return renderer;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function missingMembers(target: unknown, names: readonly string[]): string[] {
	const obj = target as Obj | undefined;
	return names.filter((name) => typeof obj?.[name] !== "function");
}

/**
 * Hooks the end of a fullscreen mouse selection. TuiAltScreen keeps its selection private and only
 * calls copySelectionToClipboard when the mouse is released after a selection, and only while
 * copy-on-select is on. So the hook keeps the renderer's copy-on-select on, remembers the user's
 * setting behind getCopyOnSelect/setCopyOnSelect, copies only when the user wants that, and then
 * reports the selection.
 */
export function bindSelectionHook(tui: unknown, onEnd: (end: SelectionEnd) => void): BindResult {
	const proxy = tui as Obj | undefined;
	if (!proxy || proxy.mode !== "fullscreen") return { kind: "not-fullscreen" };
	const missing = missingMembers(proxy, REQUIRED_MEMBERS);
	if (missing.length > 0) return { kind: "missing", members: missing };
	const renderer = rendererOf(proxy);
	if (!renderer) return { kind: "missing", members: ["(renderer)"] };

	const token = Symbol("annotation.bound");
	const restores: Array<() => void> = [];
	const patch = (name: string, make: (previous: Fn) => Fn) => {
		const hadOwn = Object.prototype.hasOwnProperty.call(renderer, name);
		const own = renderer[name];
		const replacement = make(renderer[name] as Fn);
		renderer[name] = replacement;
		restores.push(() => {
			if (renderer[name] !== replacement) return;
			if (hadOwn) renderer[name] = own;
			else delete renderer[name];
		});
	};

	const getText = renderer.getActiveSelectionText as Fn;
	const setCopy = renderer.setCopyOnSelect as Fn;
	let userCopyOnSelect = Boolean((renderer.getCopyOnSelect as Fn).call(renderer));
	let pressY: number | undefined;
	let point: ReleasePoint | undefined;

	patch("getCopyOnSelect", () => () => userCopyOnSelect);
	patch("setCopyOnSelect", (previous) =>
		function (this: unknown, enabled: unknown) {
			userCopyOnSelect = Boolean(enabled);
			return previous.call(this, true);
		},
	);
	setCopy.call(renderer, true);

	if (typeof renderer[POSITION_MEMBER] === "function") {
		patch(POSITION_MEMBER, (previous) =>
			function (this: unknown, event: any, ...rest: unknown[]) {
				if (event && Number.isFinite(event.x) && Number.isFinite(event.y)) {
					if (event.release) point = { x: event.x, y: event.y, pressY };
					else if ((Number(event.button) & 35) === 0) {
						pressY = event.y;
						point = undefined;
					}
				}
				return previous.call(this, event, ...rest);
			},
		);
	}

	patch("copySelectionToClipboard", (previous) =>
		function (this: unknown, ...args: unknown[]) {
			const text = getText.call(this);
			const end = point;
			point = undefined;
			const copied = userCopyOnSelect ? previous.apply(this, args) : Promise.resolve(false);
			if (typeof text === "string" && text.trim() !== "") queueMicrotask(() => onEnd({ text, point: end }));
			return copied;
		},
	);

	renderer[token] = true;
	return {
		kind: "bound",
		hook: {
			isCurrent: () => proxy[token] === true,
			clear: () => {
				(renderer.clearTextSelection as Fn).call(renderer);
				(renderer.requestRender as Fn).call(renderer);
			},
			screen: () => {
				const columns = renderer.terminal?.columns;
				const rows = renderer.terminal?.rows;
				return Number.isInteger(columns) && Number.isInteger(rows) && columns > 0 && rows > 0 ? { columns, rows } : undefined;
			},
			release: () => {
				for (const restore of restores.reverse()) restore();
				restores.length = 0;
				delete renderer[token];
				setCopy.call(renderer, userCopyOnSelect);
			},
		},
	};
}
