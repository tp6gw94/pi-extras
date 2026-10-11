import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { annotationsText, type Annotation } from "./quote.ts";
import { type AnnotateServer, type CloseReason, SessionSwitchedError, startAnnotateServer } from "./server.ts";
import { buildSnapshot } from "./snapshot.ts";

const STATUS_KEY = "annotation";
const ACTIVE = Symbol.for("tp6gw94.pi-extras.annotation.server");

type GlobalWithServer = typeof globalThis & { [ACTIVE]?: AnnotateServer };

export function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && /ctx is stale/i.test(error.message);
}

function sessionKey(ctx: ExtensionCommandContext): string {
	return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}

export function browserCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
	if (env.SSH_CONNECTION) return undefined;
	if (platform === "darwin") return "open";
	if (platform === "linux") return "xdg-open";
	return undefined;
}

export function annotateNotice(url: string, port: number, env: NodeJS.ProcessEnv): string {
	const lines = [`annotate: open ${url}`];
	if (env.SSH_CONNECTION) lines.push(`Over SSH, forward the port from your machine first: ssh -L ${port}:127.0.0.1:${port} <host>`);
	return lines.join("\n");
}

export interface AnnotationDeps {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	idleMs?: number;
}

export default function annotation(pi: ExtensionAPI, deps: AnnotationDeps = {}): void {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const store = globalThis as GlobalWithServer;
	let mine: AnnotateServer | undefined;

	const clearStatus = (ctx: ExtensionCommandContext) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {}
	};

	const openBrowser = (url: string) => {
		const command = browserCommand(platform, env);
		if (!command) return;
		pi.exec(command, [url], { timeout: 10_000 }).catch(() => {});
	};

	const show = (ctx: ExtensionCommandContext, server: AnnotateServer) => {
		openBrowser(server.url);
		ctx.ui.notify(annotateNotice(server.url, server.port, env), "info");
	};

	pi.registerCommand("annotate", {
		description: "Quote parts of this conversation with notes in a browser page; Send puts them into the editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const snapshot = buildSnapshot(ctx.sessionManager.getBranch());
			if (mine && !mine.closed && store[ACTIVE] === mine) {
				mine.setSnapshot(snapshot);
				show(ctx, mine);
				return;
			}
			const previous = store[ACTIVE];
			if (previous && !previous.closed) previous.close("replaced");
			const key = sessionKey(ctx);
			const server = await startAnnotateServer({
				snapshot,
				idleMs: deps.idleMs,
				isCurrent: () => {
					try {
						return sessionKey(ctx) === key;
					} catch {
						return false;
					}
				},
				onSend: (items: Annotation[]) => {
					try {
						const text = annotationsText(items, ctx.ui.getEditorText());
						if (text === undefined) throw new Error("nothing to insert");
						ctx.ui.pasteToEditor(text);
						ctx.ui.setStatus(STATUS_KEY, undefined);
						ctx.ui.notify(`annotate: inserted ${items.length} annotation${items.length === 1 ? "" : "s"} into the editor`, "info");
						return items.length;
					} catch (error) {
						if (isStaleContextError(error)) throw new SessionSwitchedError();
						throw error;
					}
				},
				onClose: (reason: CloseReason) => {
					if (mine === server) mine = undefined;
					if (store[ACTIVE] === server) delete store[ACTIVE];
					clearStatus(ctx);
					if (reason === "idle") {
						try {
							ctx.ui.notify("annotate: page closed after 30 minutes idle", "info");
						} catch {}
					}
				},
			});
			mine = server;
			store[ACTIVE] = server;
			ctx.ui.setStatus(STATUS_KEY, "annotate: page open");
			show(ctx, server);
		},
	});

	pi.on("session_shutdown", () => {
		const server = mine;
		mine = undefined;
		if (server && !server.closed) server.close("session");
	});
}
