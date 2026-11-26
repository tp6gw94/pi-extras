import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { childTurn, launchTab } from "./native.ts";
import { annotationsText, type Annotation } from "./quote.ts";
import { openReview, publishJson, ReviewError } from "./review.ts";
import { type AnnotateServer, type SessionBinding, preferredPort, SessionSwitchedError, startAnnotateServer } from "./server.ts";
import { buildSnapshot } from "./snapshot.ts";

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

export interface AnnotationDeps {
	env?: NodeJS.ProcessEnv;
	longPollMs?: number;
	refreshDelayMs?: number;
	sendReceiptTimeoutMs?: number;
	annotationDir?: string;
}

export default function annotation(pi: ExtensionAPI, deps: AnnotationDeps = {}): void {
	const env = deps.env ?? process.env;
	const refreshDelayMs = deps.refreshDelayMs ?? 30;
	const annotationDir = deps.annotationDir ?? join(getAgentDir(), "annotation");
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

	const prepareEditorAppend = (ctx: ExtensionContext, items: Annotation[]) => {
		const current = ctx.ui.getEditorText();
		const text = annotationsText(items, current);
		if (text === undefined) throw new Error("nothing to insert");
		return () => {
			ctx.ui.setEditorText(current + text);
			try {
				ctx.ui.notify(`annotate: appended ${items.length} annotation${items.length === 1 ? "" : "s"} to the editor`, "info");
			} catch {}
		};
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
		};
	};

	const release = (server: AnnotateServer) => {
		if (mine === server) mine = undefined;
		if (store[ACTIVE]?.server === server) delete store[ACTIVE];
	};

	const start = async (ctx: ExtensionContext): Promise<AnnotateServer> => {
		const previous = store[ACTIVE]?.server;
		if (previous && !previous.closed) previous.close("replaced");
		const server = await startAnnotateServer({
			...bind(ctx),
			onClose: () => release(server),
			port: preferredPort(env),
			longPollMs: deps.longPollMs,
		});
		mine = server;
		store[ACTIVE] = { server };
		return server;
	};

	type NativeSource = {
		sessionId: string;
		controller: AbortController;
		owner?: ReturnType<typeof openReview>;
		launching?: Promise<void>;
	};
	type MainDispatch = { source: NativeSource; text: string; accept?: () => void };
	const mainDispatch = new AsyncLocalStorage<MainDispatch>();
	let nativeSource: NativeSource | undefined;
	pi.registerCommand("annotate-herdr", {
		description: "Review this conversation in a local Herdr tab",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (env.SSH_CONNECTION || env.SSH_TTY) return ctx.ui.notify("Herdr review requires a local Pi session.", "error");
			const sessionId = ctx.sessionManager.getSessionId();
			const source: NativeSource = nativeSource ??= { sessionId, controller: new AbortController() };
			if (source.sessionId !== sessionId) throw new SessionSwitchedError();
			const signal = source.controller.signal;
			source.launching ??= (async () => {
				let server = running();
				if (!server && !starting) {
					closeWhenStarted = false;
					starting = start(ctx).finally(() => {
						starting = undefined;
					});
				}
				server ??= await starting!;
				if (closeWhenStarted) {
					server.close("end");
					return;
				}
				if (signal.aborted || server.closed) return;
				if (server.sessionId !== sessionId) throw new SessionSwitchedError();
				const digest = createHash("sha256").update(sessionId).digest("hex");
				const dir = join(annotationDir, "herdr", digest);
				const ui = ctx.ui;
				source.owner ??= openReview(dir, {
					items: () => buildSnapshot(ctx.sessionManager.getBranch()).items,
					prepareDelivery: (items) => prepareEditorAppend(ctx, items),
					prepareSend: (text) => {
						if (signal.aborted || running()?.sessionId !== sessionId || ctx.sessionManager.getSessionId() !== sessionId) throw new ReviewError("Source session changed.");
						if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new ReviewError("Main Pi is busy.");
						return receiptSignal => {
							const dispatch: MainDispatch = { source, text };
							let cleanup!: () => void;
							const accepted = new Promise<void>((resolve, reject) => {
								const abort = () => {
									cleanup();
									reject(receiptSignal.reason);
								};
								cleanup = () => {
									delete dispatch.accept;
									receiptSignal.removeEventListener("abort", abort);
								};
								receiptSignal.addEventListener("abort", abort, { once: true });
								dispatch.accept = () => {
									cleanup();
									resolve();
								};
							});
							try {
								mainDispatch.run(dispatch, () => pi.sendUserMessage(text, { expandPromptTemplates: false }));
							} catch (error) {
								cleanup();
								throw error;
							}
							return accepted;
						};
					},
					sendReceiptTimeoutMs: deps.sendReceiptTimeoutMs,
					model: () => ctx.model,
					run: (...args) => childTurn(ctx, ...args),
					reportPersistenceError: (message) => {
						try {
							ui.notify(message, "error");
						} catch {}
					},
				});
				const connectionFile = join(dir, "connection.json");
				publishJson(connectionFile, { sessionId, port: server.port, token: server.enableReview(sessionId, source.owner.handle) });
				const tabFile = join(dir, "tab.json");
				let tab: string | undefined;
				try {
					const saved: unknown = JSON.parse(readFileSync(tabFile, "utf8"));
					if (typeof saved === "string") tab = saved;
				} catch (error) {
					if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const selected = await launchTab(pi, sessionId, connectionFile, signal, env.HC_TERMINAL_ID, tab);
				if (selected && !signal.aborted) publishJson(tabFile, selected);
			})().catch((error) => {
				if (!signal.aborted) throw error;
			}).finally(() => {
				source.launching = undefined;
			});
			await source.launching;
		},
	});

	pi.on("message_end", (event, ctx) => {
		const dispatch = mainDispatch.getStore();
		if (dispatch?.accept && dispatch.source === nativeSource && event.message.role === "user" && ctx.sessionManager.getSessionId() === dispatch.source.sessionId) {
			const accept = dispatch.accept;
			const content = event.message.content;
			let text: string | undefined;
			if (typeof content === "string") text = content;
			else if (content.length === 1 && content[0]?.type === "text") text = content[0].text;
			if (text === dispatch.text) {
				delete dispatch.accept;
				accept();
			}
		}
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
			server.rebind({ ...bind(ctx), onClose: () => release(server) });
			mine = server;
		};
	});

	pi.on("session_shutdown", async () => {
		const source = nativeSource;
		nativeSource = undefined;
		source?.controller.abort();
		const opening = starting;
		if (opening) closeWhenStarted = true;
		const server = mine;
		mine = undefined;
		if (source && server?.sessionId === source.sessionId) server.disableReview();
		const slot = store[ACTIVE];
		if (server && !server.closed && !(slot?.server === server && slot.handoff)) server.close("session");
		await Promise.all([source?.owner?.close(), source?.launching, opening?.catch(() => {})]);
	});
}
