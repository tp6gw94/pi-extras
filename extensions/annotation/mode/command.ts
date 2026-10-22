import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { annotationsText } from "../quote.ts";
import type { Notebook, Outcome } from "./data.ts";
import { attach, type BlockRegistry, isRefusal } from "./host.ts";
import { AnnotationDock } from "./shell.ts";

interface Session extends BlockRegistry {
	readonly sessionId: string;
	notebook: Notebook;
}

const EMPTY = { render: () => [], invalidate: () => {} };

export function registerAnnotationMode(pi: ExtensionAPI): void {
	let session: Session | undefined;
	let run: AnnotationDock | undefined;
	const abandon = (): void => {
		run?.dispose();
		run = undefined;
	};

	pi.registerCommand("annotation-mode", {
		description: "Annotate the fullscreen transcript, then append notes to the editor or submit them",
		handler: async (_args, ctx) => {
			abandon();
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("annotation-mode needs the interactive terminal UI", "warning");
				return;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			if (session?.sessionId !== sessionId) session = { sessionId, notebook: { sessionId, notes: [], nextId: 1 }, blocks: new WeakMap(), nextBlock: 1 };
			const store = session;
			let dock: AnnotationDock | undefined;
			let outcome: Outcome | undefined;
			try {
				outcome = await ctx.ui.custom<Outcome | undefined>((tui, theme, _kb, done) => {
					dock = new AnnotationDock({ tui, theme, notebook: store.notebook, commit: (next) => { store.notebook = next; }, finish: done, isIdle: () => ctx.isIdle() });
					const result = attach(tui, store, dock.hooks());
					if (isRefusal(result)) {
						ctx.ui.notify(`annotation-mode: ${result.refused}`, "warning");
						done(undefined);
						return EMPTY;
					}
					run = dock;
					if (!dock.bind(result)) {
						dock.dispose();
						ctx.ui.notify("annotation-mode: the conversation is empty", "warning");
						done(undefined);
						return EMPTY;
					}
					return dock;
				}, { overlay: false });
				if (run !== dock) return;
			} catch (error) {
				ctx.ui.notify(`annotation-mode: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
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
				const current = outcome.kind === "append" ? ctx.ui.getEditorText() : "";
				const text = annotationsText(items, current);
				if (text === undefined) throw new Error("nothing to deliver");
				if (outcome.kind === "append") {
					ctx.ui.setEditorText(current + text);
					ctx.ui.notify(`annotation-mode: appended ${items.length} annotation${items.length === 1 ? "" : "s"} to the editor`, "info");
				} else pi.sendUserMessage(text, { deliverAs: "followUp" });
				const delivered = new Set(outcome.notes.map((note) => note.id));
				store.notebook = { ...store.notebook, notes: store.notebook.notes.filter((note) => !delivered.has(note.id)) };
			} catch (error) {
				ctx.ui.notify(`annotation-mode: ${error instanceof Error ? error.message : String(error)}; notes kept`, "error");
			}
		},
	});

	pi.on("session_shutdown", abandon);
}
