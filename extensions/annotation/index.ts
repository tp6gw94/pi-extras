import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { annotationsText, type Annotation } from "./quote.ts";
import { type AnnotateServer, type CloseReason, preferredPort, SessionSwitchedError, startAnnotateServer } from "./server.ts";
import { buildSnapshot } from "./snapshot.ts";

const STATUS_KEY = "annotation";
const ACTIVE = Symbol.for("tp6gw94.pi-extras.annotation.server");

type GlobalWithServer = typeof globalThis & { [ACTIVE]?: AnnotateServer };

export function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && /ctx is stale/i.test(error.message);
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
	lines.push("Run /annotate again to stop it.");
	return lines.join("\n");
}

export interface AnnotationDeps {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	longPollMs?: number;
	refreshDelayMs?: number;
}

export default function annotation(pi: ExtensionAPI, deps: AnnotationDeps = {}): void {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const refreshDelayMs = deps.refreshDelayMs ?? 30;
	const store = globalThis as GlobalWithServer;
	let mine: AnnotateServer | undefined;
	let starting: Promise<AnnotateServer> | undefined;
	let closeWhenStarted = false;

	const running = () => (mine && !mine.closed && store[ACTIVE] === mine ? mine : undefined);

	const openBrowser = (url: string) => {
		const command = browserCommand(platform, env);
		if (!command) return;
		pi.exec(command, [url], { timeout: 10_000 }).catch(() => {});
	};

	const show = (ctx: ExtensionContext, server: AnnotateServer) => {
		openBrowser(server.url);
		ctx.ui.notify(annotateNotice(server.url, server.port, env), "info");
	};

	const refresh = (ctx: ExtensionContext) => {
		const server = running();
		if (!server) return;
		try {
			if (ctx.sessionManager.getSessionId() !== server.sessionId) return;
			server.update(buildSnapshot(ctx.sessionManager.getBranch()).items);
		} catch {}
	};

	const refreshSoon = (ctx: ExtensionContext) => {
		if (!running()) return;
		setTimeout(() => refresh(ctx), refreshDelayMs).unref?.();
	};

	const start = async (ctx: ExtensionCommandContext): Promise<AnnotateServer> => {
		const previous = store[ACTIVE];
		if (previous && !previous.closed) previous.close("replaced");
		const sessionId = ctx.sessionManager.getSessionId();
		const server = await startAnnotateServer({
			sessionId,
			items: buildSnapshot(ctx.sessionManager.getBranch()).items,
			port: preferredPort(env),
			longPollMs: deps.longPollMs,
			isCurrent: () => {
				try {
					return ctx.sessionManager.getSessionId() === sessionId;
				} catch {
					return false;
				}
			},
			onSend: (items: Annotation[]) => {
				try {
					const current = ctx.ui.getEditorText();
					const text = annotationsText(items, current);
					if (text === undefined) throw new Error("nothing to insert");
					ctx.ui.setEditorText(current + text);
					ctx.ui.notify(`annotate: appended ${items.length} annotation${items.length === 1 ? "" : "s"} to the editor`, "info");
					return items.length;
				} catch (error) {
					if (isStaleContextError(error)) throw new SessionSwitchedError();
					throw error;
				}
			},
			onClose: (_reason: CloseReason) => {
				if (mine === server) mine = undefined;
				if (store[ACTIVE] === server) delete store[ACTIVE];
				try {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				} catch {}
			},
		});
		mine = server;
		store[ACTIVE] = server;
		try {
			ctx.ui.setStatus(STATUS_KEY, `annotate: live on 127.0.0.1:${server.port}`);
		} catch {}
		return server;
	};

	const closeNotice = (ctx: ExtensionContext, port: number) => {
		try {
			ctx.ui.notify(`annotate: closed, port ${port} released`, "info");
		} catch {}
	};

	pi.registerCommand("annotate", {
		description: "Toggle a live browser page of this conversation to quote parts of it with notes; Send appends them to the editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (starting) {
				closeWhenStarted = true;
				return;
			}
			const server = running();
			if (server && server.sessionId === ctx.sessionManager.getSessionId()) {
				const port = server.port;
				server.close("end");
				closeNotice(ctx, port);
				return;
			}
			if (server) server.close("replaced");
			closeWhenStarted = false;
			const current = start(ctx).finally(() => {
				starting = undefined;
			});
			starting = current;
			const started = await current;
			if (closeWhenStarted) {
				closeWhenStarted = false;
				const port = started.port;
				if (!started.closed) started.close("end");
				closeNotice(ctx, port);
				return;
			}
			show(ctx, started);
		},
	});

	pi.on("message_end", (_event, ctx) => {
		refreshSoon(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		refreshSoon(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		refreshSoon(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		refreshSoon(ctx);
	});

	pi.on("session_shutdown", () => {
		if (starting) closeWhenStarted = true;
		const server = mine;
		mine = undefined;
		if (server && !server.closed) server.close("session");
	});
}
