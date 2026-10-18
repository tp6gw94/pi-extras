import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { annotationsText } from "./quote.ts";
import { registryDir, removeEntry, writeEntry } from "./registry.ts";
import { type AnnotateServer, type SessionBinding, preferredPort, SessionSwitchedError, startAnnotateServer } from "./server.ts";
import { buildSnapshot } from "./snapshot.ts";

const STATUS_KEY = "annotation";
const ACTIVE = Symbol.for("tp6gw94.pi-extras.annotation.server");

type GlobalWithServer = typeof globalThis & {
	[ACTIVE]?: { server: AnnotateServer; handoff?: { adopt?: (server: AnnotateServer) => void } };
};
const store = globalThis as GlobalWithServer;

export async function newSessionWithAnnotation(
	ctx: ExtensionCommandContext,
	options?: Parameters<ExtensionCommandContext["newSession"]>[0],
): ReturnType<ExtensionCommandContext["newSession"]> {
	const slot = store[ACTIVE];
	if (!slot) return ctx.newSession(options);
	slot.handoff = {};
	slot.server.park();
	try {
		const result = await ctx.newSession(options);
		if (result.cancelled) slot.server.unpark();
		else if (slot.handoff.adopt) slot.handoff.adopt(slot.server);
		else slot.server.close("session");
		return result;
	} catch (error) {
		slot.server.close("session");
		throw error;
	} finally {
		delete slot.handoff;
	}
}

export function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && /ctx is stale/i.test(error.message);
}

export const BIN_PATH = fileURLToPath(new URL("./bin/pi-annotation.ts", import.meta.url));

export function attachCommand(sessionId: string): string {
	return `'${BIN_PATH.replaceAll("'", `'\\''`)}' ${sessionId}`;
}

export function liveNotice(sessionId: string, url: string, port: number, env: NodeJS.ProcessEnv, heading = `annotate: live on 127.0.0.1:${port}`): string {
	const lines = [heading, `Browser: ${url}`, `Terminal: ${attachCommand(sessionId)}`];
	if (env.SSH_CONNECTION) lines.push(`Over SSH, forward the port from your machine first: ssh -L ${port}:127.0.0.1:${port} <host>`);
	lines.push("Run /annotate again to stop it.");
	return lines.join("\n");
}

export function resolveTuiModule(): string | undefined {
	try {
		return createRequire(join(getPackageDir(), "package.json")).resolve("@earendil-works/pi-tui");
	} catch {
		return undefined;
	}
}

export interface AnnotationDeps {
	env?: NodeJS.ProcessEnv;
	longPollMs?: number;
	refreshDelayMs?: number;
	registryDir?: string;
}

export default function annotation(pi: ExtensionAPI, deps: AnnotationDeps = {}): void {
	const env = deps.env ?? process.env;
	const refreshDelayMs = deps.refreshDelayMs ?? 30;
	const sessionsDir = deps.registryDir ?? registryDir(getAgentDir());
	let mine: AnnotateServer | undefined;
	let starting: Promise<AnnotateServer> | undefined;
	let closeWhenStarted = false;

	const running = () => (mine && !mine.closed && store[ACTIVE]?.server === mine ? mine : undefined);

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

	const bind = (ctx: ExtensionContext): SessionBinding => {
		const sessionId = ctx.sessionManager.getSessionId();
		return {
			sessionId,
			items: buildSnapshot(ctx.sessionManager.getBranch()).items,
			isCurrent: () => {
				try {
					return ctx.sessionManager.getSessionId() === sessionId;
				} catch {
					return false;
				}
			},
			onSend: (items, _seq, delivery): number => {
				try {
					switch (delivery) {
						case "agent": {
							const text = annotationsText(items);
							if (text === undefined) throw new Error("nothing to submit");
							pi.sendUserMessage(text, { deliverAs: "followUp" });
							return items.length;
						}
						case "editor": {
							const current = ctx.ui.getEditorText();
							const text = annotationsText(items, current);
							if (text === undefined) throw new Error("nothing to insert");
							ctx.ui.setEditorText(current + text);
							ctx.ui.notify(`annotate: appended ${items.length} annotation${items.length === 1 ? "" : "s"} to the editor`, "info");
							return items.length;
						}
					}
				} catch (error) {
					if (isStaleContextError(error)) throw new SessionSwitchedError();
					throw error;
				}
			},
		};
	};

	const release = (server: AnnotateServer, ctx: ExtensionContext) => {
		removeEntry(sessionsDir, process.pid, server.token);
		if (mine === server) mine = undefined;
		if (store[ACTIVE]?.server === server) delete store[ACTIVE];
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {}
	};

	const publish = (server: AnnotateServer, ctx: ExtensionContext) => {
		writeEntry(sessionsDir, {
			sessionId: server.sessionId,
			port: server.port,
			token: server.token,
			pid: process.pid,
			cwd: ctx.cwd,
			startedAt: new Date().toISOString(),
			tuiModule: resolveTuiModule(),
		});
		try {
			ctx.ui.setStatus(STATUS_KEY, `annotate: live on 127.0.0.1:${server.port}`);
		} catch {}
	};

	const start = async (ctx: ExtensionContext): Promise<AnnotateServer> => {
		const previous = store[ACTIVE]?.server;
		if (previous && !previous.closed) previous.close("replaced");
		const server = await startAnnotateServer({
			...bind(ctx),
			onClose: () => release(server, ctx),
			port: preferredPort(env),
			longPollMs: deps.longPollMs,
		});
		mine = server;
		store[ACTIVE] = { server };
		publish(server, ctx);
		return server;
	};

	const closeNotice = (ctx: ExtensionContext, port: number) => {
		try {
			ctx.ui.notify(`annotate: closed, port ${port} released`, "info");
		} catch {}
	};

	pi.registerCommand("annotate", {
		description: "Toggle a live view of this conversation to quote parts of it with notes, in a browser page or a terminal view",
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
			ctx.ui.notify(liveNotice(started.sessionId, started.url, started.port, env), "info");
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

	pi.on("session_start", (_event, ctx) => {
		const handoff = store[ACTIVE]?.handoff;
		if (!handoff) return;
		handoff.adopt = (server) => {
			server.rebind({ ...bind(ctx), onClose: () => release(server, ctx) });
			mine = server;
			publish(server, ctx);
			ctx.ui.notify(liveNotice(server.sessionId, server.url, server.port, env, `annotate: followed to this session on 127.0.0.1:${server.port}`), "info");
		};
	});

	pi.on("session_shutdown", () => {
		if (starting) closeWhenStarted = true;
		const server = mine;
		mine = undefined;
		if (!server || server.closed) return;
		const slot = store[ACTIVE];
		if (slot?.server === server && slot.handoff) return;
		server.close("session");
	});
}
