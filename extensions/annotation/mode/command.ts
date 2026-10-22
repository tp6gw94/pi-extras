import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { annotationsText } from "../quote.ts";
import type { Notebook, Outcome } from "./data.ts";
import { attach, type BlockRegistry, isRefusal } from "./host.ts";
import { AnnotationDock } from "./shell.ts";

interface Session extends BlockRegistry {
	readonly sessionId: string;
	notebook: Notebook;
}

const EMPTY = { render: () => [], invalidate: () => {} };
const DESCRIPTION = "Annotate the fullscreen transcript, then append notes to the editor or submit them";

export function registerAnnotationMode(pi: ExtensionAPI): void {
	let session: Session | undefined;
	let run: AnnotationDock | undefined;
	let generation = 0;
	const abandon = (): void => {
		generation++;
		run?.dispose();
		run = undefined;
	};

	const interact = async (ctx: ExtensionContext, store: Session, current: number): Promise<void> => {
		const restoreDraft = ctx.ui.getEditorText();
		let dock: AnnotationDock | undefined;
		let outcome: Outcome | undefined;
		try {
			outcome = await ctx.ui.custom<Outcome | undefined>((tui, theme, _kb, done) => {
				const finish = (result: Outcome | undefined): void => {
					done(result);
					if (ctx.ui.getEditorText() !== restoreDraft) ctx.ui.setEditorText(restoreDraft);
				};
				dock = new AnnotationDock({ tui, theme, notebook: store.notebook, commit: (next) => { store.notebook = next; }, finish, isIdle: () => ctx.isIdle() });
				const result = attach(tui, store, dock.hooks());
				if (isRefusal(result)) {
					ctx.ui.notify(`annotation-mode: ${result.refused}`, "warning");
					finish(undefined);
					return EMPTY;
				}
				run = dock;
				if (!dock.bind(result)) {
					dock.dispose();
					ctx.ui.notify("annotation-mode: the conversation is empty", "warning");
					finish(undefined);
					return EMPTY;
				}
				return dock;
			}, { overlay: false });
			if (generation !== current || run !== dock) return;
		} finally {
			dock?.dispose();
			if (run === dock) run = undefined;
		}
		if (outcome?.kind === "detached") {
			ctx.ui.notify(`annotation-mode: ${outcome.reason}`, "warning");
			return;
		}
		if (outcome?.kind !== "append" && outcome?.kind !== "submit") return;
		try {
			const items = outcome.notes.map((note) => ({ quote: note.quote, note: note.text }));
			const draft = outcome.kind === "append" ? ctx.ui.getEditorText() : "";
			const text = annotationsText(items, draft);
			if (text === undefined) throw new Error("nothing to deliver");
			if (outcome.kind === "append") {
				ctx.ui.setEditorText(draft + text);
				ctx.ui.notify(`annotation-mode: appended ${items.length} annotation${items.length === 1 ? "" : "s"} to the editor`, "info");
			} else pi.sendUserMessage(text, { deliverAs: "followUp" });
			const delivered = new Set(outcome.notes.map((note) => note.id));
			store.notebook = { ...store.notebook, notes: store.notebook.notes.filter((note) => !delivered.has(note.id)) };
		} catch (error) {
			ctx.ui.notify(`annotation-mode: ${error instanceof Error ? error.message : String(error)}; notes kept`, "error");
		}
	};

	const open = (ctx: ExtensionContext): void => {
		abandon();
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify("annotation-mode needs the interactive terminal UI", "warning");
			return;
		}
		const sessionId = ctx.sessionManager.getSessionId();
		if (session?.sessionId !== sessionId) session = { sessionId, notebook: { sessionId, notes: [], nextId: 1 }, blocks: new WeakMap(), nextBlock: 1 };
		const current = generation;
		void interact(ctx, session, current).catch((error) => {
			if (generation === current) ctx.ui.notify(`annotation-mode: ${error instanceof Error ? error.message : String(error)}`, "error");
		});
	};

	pi.registerCommand("annotation-mode", {
		description: DESCRIPTION,
		handler: async (_args, ctx) => open(ctx),
	});

	pi.registerShortcut("ctrl+shift+a", { description: DESCRIPTION, handler: open });

	pi.on("session_shutdown", abandon);
}
