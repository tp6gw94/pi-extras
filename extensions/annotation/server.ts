import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { ReviewError } from "./review.ts";
import type { SnapshotItem } from "./snapshot.ts";

export const TOKEN_HEADER = "x-annotate-token";
export const MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_PORT = 4747;
export const PORT_ATTEMPTS = 10;
export const MAX_LONG_POLLS = 4;
export const LONG_POLL_MS = 25_000;
export const MAX_UPDATES = 200;
export const SESSION_SWITCHED = "Session switched, run /annotate-herdr again.";

export type CloseReason = "end" | "session" | "replaced";

export class SessionSwitchedError extends Error {
	constructor() {
		super(SESSION_SWITCHED);
	}
}

export interface Update {
	version: number;
	reset: boolean;
	items: SnapshotItem[];
}

export interface SessionBinding {
	sessionId: string;
	items: SnapshotItem[];
	isCurrent(): boolean;
	onClose?(reason: CloseReason): void;
}

type Phase = "bound" | "parked" | "closed";

interface Current {
	binding: SessionBinding;
	token: string;
	items: SnapshotItem[];
	updates: Update[];
}

export interface AnnotateServerOptions extends SessionBinding {
	port?: number;
	longPollMs?: number;
	maxLongPolls?: number;
	maxBodyBytes?: number;
}

export interface AnnotateServer {
	readonly port: number;
	readonly token: string;
	readonly sessionId: string;
	readonly closed: boolean;
	readonly version: number;
	enableReview(sessionId: string, request: (body?: unknown) => unknown): string;
	disableReview(): void;
	update(items: SnapshotItem[]): Update | undefined;
	close(reason: CloseReason): void;
	park(): void;
	unpark(): void;
	rebind(binding: SessionBinding): void;
}

export function preferredPort(env: NodeJS.ProcessEnv): number {
	const raw = env.PI_ANNOTATE_PORT?.trim();
	if (!raw || !/^\d+$/.test(raw)) return DEFAULT_PORT;
	const port = Number(raw);
	return port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

export function diffItems(previous: readonly SnapshotItem[], next: readonly SnapshotItem[]): { reset: boolean; items: SnapshotItem[] } | undefined {
	const prefix = previous.length <= next.length && previous.every((item, index) => item.id === next[index]!.id && item.text === next[index]!.text);
	if (!prefix) return { reset: true, items: [...next] };
	if (next.length === previous.length) return undefined;
	return { reset: false, items: next.slice(previous.length) };
}

function sameToken(given: string | undefined, token: string): boolean {
	if (typeof given !== "string") return false;
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

export function classify(
	phase: Exclude<Phase, "closed">,
	current: { sessionId: string; token: string; isCurrent(): boolean },
	retired: ReadonlyMap<string, string>,
	pathSession: string,
	token: string | undefined,
): "current" | "hold" | "successor" | "switched" | "forbidden" {
	if (pathSession === current.sessionId) {
		if (!sameToken(token, current.token)) return "forbidden";
		if (phase === "parked") return "hold";
		return current.isCurrent() ? "current" : "switched";
	}
	if (token !== undefined && retired.get(token) === pathSession) return phase === "parked" ? "hold" : "successor";
	return "switched";
}

function baseHeaders(): Record<string, string> {
	return {
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy": "no-referrer",
		"X-Frame-Options": "DENY",
	};
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
	if (res.headersSent || res.destroyed) return;
	res.writeHead(status, { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8", ...extra });
	res.end(JSON.stringify(body));
}

function failed(res: ServerResponse): void {
	try {
		if (!res.headersSent && !res.destroyed) {
			sendJson(res, 500, { error: "internal error" }, { Connection: "close" });
			return;
		}
		res.destroy();
	} catch {
		res.destroy();
	}
}

function guarded<T extends unknown[]>(res: ServerResponse, fn: (...args: T) => void): (...args: T) => void {
	return (...args: T) => {
		try {
			fn(...args);
		} catch {
			failed(res);
		}
	};
}

export function decodePathPart(part: string): string | undefined {
	try {
		return decodeURIComponent(part);
	} catch {
		return undefined;
	}
}

export function splitTarget(target: string): { path: string; parts: string[]; query: URLSearchParams } | undefined {
	const at = target.indexOf("?");
	const path = at < 0 ? target : target.slice(0, at);
	if (!path.startsWith("/")) return undefined;
	return { path, parts: path.split("/").filter((part) => part !== ""), query: new URLSearchParams(at < 0 ? "" : target.slice(at + 1)) };
}

function isJson(req: IncomingMessage): boolean {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

function listen(server: Server, port: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException) => {
			server.off("listening", onListening);
			if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
			else reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve(true);
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});
}

export async function startAnnotateServer(options: AnnotateServerOptions): Promise<AnnotateServer> {
	const longPollMs = options.longPollMs ?? LONG_POLL_MS;
	const maxLongPolls = options.maxLongPolls ?? MAX_LONG_POLLS;
	const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
	const fresh = (binding: SessionBinding): Current => ({
		binding,
		token: randomBytes(24).toString("base64url"),
		items: [...binding.items],
		updates: [],
	});
	let current = fresh(options);
	let native: { token: string; request(body?: unknown): unknown } | undefined;
	let version = 1;
	let phase: Phase = "bound";
	let port = 0;
	const retired = new Map<string, string>();
	const sockets = new Set<Socket>();
	const waiters = new Set<() => void>();
	const held = new Set<() => void>();

	const close = (reason: CloseReason) => {
		if (phase === "closed") return;
		phase = "closed";
		native = undefined;
		for (const wake of [...waiters, ...held]) wake();
		server.close();
		for (const socket of sockets) socket.destroy();
		current.binding.onClose?.(reason);
	};

	const park = () => {
		if (phase === "bound") phase = "parked";
	};

	const unpark = () => {
		if (phase !== "parked") return;
		phase = "bound";
		for (const wake of [...held]) wake();
	};

	const rebind = (binding: SessionBinding) => {
		if (phase !== "parked") return;
		retired.set(current.token, current.binding.sessionId);
		native = undefined;
		current = fresh(binding);
		version += 1;
		phase = "bound";
		for (const wake of [...waiters, ...held]) wake();
	};

	const hold = (res: ServerResponse, resume: () => void) => {
		const cancel = () => held.delete(wake);
		const wake = guarded(res, () => {
			held.delete(wake);
			res.off("close", cancel);
			resume();
		});
		held.add(wake);
		res.once("close", cancel);
	};

	const withCurrent = (req: IncomingMessage, res: ServerResponse, pathSession: string, token: string | undefined, proceed: () => void): void => {
		if (phase === "closed") return;
		const nativeAccess = native !== undefined && sameToken(token, native.token) && pathSession === current.binding.sessionId;
		const decision = nativeAccess && phase === "parked"
			? "switched"
			: classify(phase, { sessionId: current.binding.sessionId, token: current.token, isCurrent: () => current.binding.isCurrent() }, retired, pathSession, nativeAccess ? current.token : token);
		if (decision === "current") return proceed();
		if (decision === "hold") return hold(res, () => withCurrent(req, res, pathSession, token, proceed));
		req.resume();
		if (decision === "forbidden") return sendJson(res, 403, { error: "missing or wrong X-Annotate-Token" });
		if (decision === "successor") return sendJson(res, 410, { error: SESSION_SWITCHED, successor: { sessionId: current.binding.sessionId, token: current.token } });
		sendJson(res, 410, { error: SESSION_SWITCHED });
	};

	const update = (next: SnapshotItem[]): Update | undefined => {
		if (phase === "closed") return undefined;
		const diff = diffItems(current.items, next);
		if (!diff) return undefined;
		current.items = [...next];
		version += 1;
		const entry: Update = { version, reset: diff.reset, items: diff.items };
		current.updates.push(entry);
		if (current.updates.length > MAX_UPDATES) current.updates = current.updates.slice(-MAX_UPDATES);
		for (const wake of [...waiters]) wake();
		return entry;
	};

	const changesAfter = (after: number): Update => {
		const { items, updates } = current;
		const pending = updates.filter((entry) => entry.version > after);
		const known = after >= 1 && after <= version && (after === version || (updates.length > 0 && updates[0]!.version <= after + 1));
		if (!known || pending.some((entry) => entry.reset)) return { version, reset: true, items };
		return { version, reset: false, items: pending.flatMap((entry) => entry.items) };
	};

	const readBody = (req: IncomingMessage, res: ServerResponse, done: (text: string) => void) => {
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > maxBodyBytes) {
			sendJson(res, 413, { error: "body too large" }, { Connection: "close" });
			req.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let rejected = false;
		req.on("data", guarded(res, (chunk: Buffer) => {
			if (rejected) return;
			size += chunk.length;
			if (size > maxBodyBytes) {
				rejected = true;
				sendJson(res, 413, { error: "body too large" }, { Connection: "close" });
				return;
			}
			chunks.push(chunk);
		}));
		req.on("end", guarded(res, () => {
			if (!rejected) done(Buffer.concat(chunks).toString("utf8"));
		}));
	};

	const handleReview = (req: IncomingMessage, res: ServerResponse, token: string | undefined): void => {
		const apply = async (body?: unknown) => {
			if (!native || !sameToken(token, native.token) || phase !== "bound" || !current.binding.isCurrent()) {
				return sendJson(res, 410, { error: SESSION_SWITCHED });
			}
			try {
				sendJson(res, 200, await native.request(body));
			} catch (error) {
				if (error instanceof ReviewError) return sendJson(res, 409, { error: error.message, pendingSendRequestId: error.pendingSendRequestId });
				failed(res);
			}
		};
		if (req.method === "GET") return void apply().catch(() => failed(res));
		if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
		if (!isJson(req)) return sendJson(res, 415, { error: "Expected JSON." });
		readBody(req, res, (text) => {
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return sendJson(res, 400, { error: "Invalid JSON." });
			}
			void apply(body).catch(() => failed(res));
		});
	};

	const handleEvents = (query: URLSearchParams, req: IncomingMessage, res: ServerResponse, pathSession: string, token: string | undefined) => {
		const after = Number(query.get("after") ?? Number.NaN);
		if (!Number.isInteger(after) || after < 0) return sendJson(res, 400, { error: "after must be a version number" });
		if (after !== version) return sendJson(res, 200, changesAfter(after));
		if (waiters.size >= maxLongPolls) return sendJson(res, 429, { error: `at most ${maxLongPolls} live connections` });
		let timer: NodeJS.Timeout | undefined;
		const finish = guarded(res, () => {
			waiters.delete(finish);
			if (timer) clearTimeout(timer);
			withCurrent(req, res, pathSession, token, () => sendJson(res, 200, changesAfter(after)));
		});
		waiters.add(finish);
		timer = setTimeout(finish, longPollMs);
		res.on("close", () => {
			if (waiters.delete(finish) && timer) clearTimeout(timer);
		});
	};

	const route = (req: IncomingMessage, res: ServerResponse) => {
		if (phase === "closed") {
			res.writeHead(503, { ...baseHeaders(), Connection: "close" });
			res.end();
			return;
		}
		if (req.headers.host !== `127.0.0.1:${port}`) {
			sendJson(res, 403, { error: "bad Host" });
			req.resume();
			return;
		}
		const target = splitTarget(req.url ?? "/");
		if (!target) {
			sendJson(res, 400, { error: "bad request target" });
			req.resume();
			return;
		}
		const { parts, query } = target;
		if (parts.length !== 3 || parts[1] !== "api") {
			sendJson(res, 404, { error: "not found" });
			req.resume();
			return;
		}
		const pathSession = decodePathPart(parts[0]!);
		if (pathSession === undefined) {
			sendJson(res, 400, { error: "malformed path" });
			req.resume();
			return;
		}
		const endpoint = parts[2];
		const known = endpoint === "snapshot" || endpoint === "events" || (endpoint === "review" && native !== undefined);
		if (!known) {
			sendJson(res, 404, { error: "not found" });
			req.resume();
			return;
		}
		const given = req.headers[TOKEN_HEADER];
		const token = Array.isArray(given) ? given[0] : given;
		if (endpoint === "review") {
			const nativeAccess = native !== undefined && sameToken(token, native.token) && pathSession === current.binding.sessionId;
			const sameOrigin = req.headers.origin === undefined || req.headers.origin === `http://127.0.0.1:${port}`;
			if (!nativeAccess || !sameOrigin) return sendJson(res, 403, { error: "Invalid capability." });
			return withCurrent(req, res, pathSession, token, () => handleReview(req, res, token));
		}
		withCurrent(req, res, pathSession, token, () => {
			if (req.method !== "GET") {
				sendJson(res, 405, { error: "method not allowed" });
				req.resume();
				return;
			}
			if (endpoint === "snapshot") return sendJson(res, 200, { sessionId: current.binding.sessionId, version, items: current.items });
			return handleEvents(query, req, res, pathSession, token);
		});
	};

	const server = createServer((req, res) => {
		req.on("error", () => res.destroy());
		res.on("error", () => res.destroy());
		Promise.resolve()
			.then(() => route(req, res))
			.catch(() => failed(res));
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.unref();
		socket.on("close", () => sockets.delete(socket));
	});

	const first = options.port ?? DEFAULT_PORT;
	let bound = false;
	for (let candidate = first; candidate < first + PORT_ATTEMPTS && candidate <= 65535 && !bound; candidate++) {
		bound = await listen(server, candidate);
	}
	if (!bound && !(await listen(server, 0))) throw new Error("annotate: could not bind a port on 127.0.0.1");
	server.unref();
	port = (server.address() as AddressInfo).port;

	return {
		port,
		get token() {
			return current.token;
		},
		get sessionId() {
			return current.binding.sessionId;
		},
		get closed() {
			return phase === "closed";
		},
		get version() {
			return version;
		},
		enableReview(sessionId, request) {
			if (phase !== "bound" || sessionId !== current.binding.sessionId || !current.binding.isCurrent()) throw new SessionSwitchedError();
			native ??= { token: randomBytes(24).toString("base64url"), request };
			return native.token;
		},
		disableReview() {
			native = undefined;
		},
		update,
		close,
		park,
		unpark,
		rebind,
	};
}
