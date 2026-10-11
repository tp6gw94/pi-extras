import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AnnotationBox, boxHeight, type BoxResult } from "./box.ts";
import { boxPlacement, boxWidth } from "./position.ts";
import { annotationText } from "./quote.ts";
import { bindSelectionHook, type SelectionEnd, type SelectionHook } from "./selection-hook.ts";

const PROBE_KEY = "annotation:probe";

function captureTui(ctx: ExtensionContext): unknown {
	let captured: unknown;
	ctx.ui.setWidget(PROBE_KEY, (tui) => {
		captured = tui;
		return { render: () => [], invalidate: () => {} };
	});
	ctx.ui.setWidget(PROBE_KEY, undefined);
	return captured;
}

export function overlayOptionsFor(end: SelectionEnd, screen: { columns: number; rows: number } | undefined) {
	const width = boxWidth(screen?.columns ?? 80);
	if (!end.point || !screen) return { width, anchor: "bottom-center" as const };
	const { row, col } = boxPlacement(end.point, { width, height: boxHeight(end.text) }, screen);
	return { width, row, col };
}

export default function annotation(pi: ExtensionAPI): void {
	let ctxRef: ExtensionContext | undefined;
	let tui: unknown;
	let hook: SelectionHook | undefined;
	let boxOpen = false;
	let warned = false;
	let unsubscribe: (() => void) | undefined;

	const unbind = () => {
		hook?.release();
		hook = undefined;
	};

	const ensureBound = () => {
		if (!tui || hook?.isCurrent()) return;
		unbind();
		const result = bindSelectionHook(tui, (end) => void openBox(end));
		if (result.kind === "bound") hook = result.hook;
		else if (result.kind === "missing" && !warned) {
			warned = true;
			ctxRef?.ui.notify(
				`annotation: turned off. This pi's fullscreen TUI has no ${result.members.join(", ")}, so selections cannot be annotated. Everything else in pi works as usual.`,
				"warning",
			);
		}
	};

	const openBox = async (end: SelectionEnd) => {
		const ctx = ctxRef;
		const current = hook;
		if (boxOpen || !ctx || !current) return;
		boxOpen = true;
		try {
			const result = await ctx.ui.custom<BoxResult>((_tui, theme, _kb, done) => new AnnotationBox(theme, end.text, done), {
				overlay: true,
				overlayOptions: overlayOptionsFor(end, current.screen()),
			});
			if (result.kind === "insert") {
				const text = annotationText(end.text, result.note, ctx.ui.getEditorText());
				if (text !== undefined) ctx.ui.pasteToEditor(text);
			}
		} finally {
			boxOpen = false;
			current.clear();
		}
	};

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		unsubscribe?.();
		unsubscribe = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		tui = captureTui(ctx);
		ensureBound();
		unsubscribe = ctx.ui.onTerminalInput(() => {
			ensureBound();
			return undefined;
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		unbind();
		tui = undefined;
		ctxRef = undefined;
	});
}
