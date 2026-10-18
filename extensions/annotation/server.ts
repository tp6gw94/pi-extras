import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Annotation, AnnotationDelivery } from "./quote.ts";
import type { SnapshotItem } from "./snapshot.ts";

export const TOKEN_HEADER = "x-annotate-token";
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ITEMS = 500;
export const DEFAULT_PORT = 4747;
export const PORT_ATTEMPTS = 10;
export const MAX_LONG_POLLS = 4;
export const LONG_POLL_MS = 25_000;
export const MAX_UPDATES = 200;
export const SESSION_SWITCHED = "Session switched, run /annotate again.";

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

export interface AnnotateServerOptions {
	sessionId: string;
	items: SnapshotItem[];
	isCurrent(): boolean;
	onSend(items: Annotation[], seq: number, delivery: AnnotationDelivery): number;
	onClose?(reason: CloseReason): void;
	port?: number;
	longPollMs?: number;
	maxLongPolls?: number;
	maxBodyBytes?: number;
}

export interface AnnotateServer {
	readonly url: string;
	readonly port: number;
	readonly token: string;
	readonly sessionId: string;
	readonly closed: boolean;
	readonly version: number;
	update(items: SnapshotItem[]): Update | undefined;
	close(reason: CloseReason): void;
}

const PAGE = new URL("./page.html", import.meta.url);
const MARKDOWN = new URL("./markdown.js", import.meta.url);
const FRAME_PAGE = new URL("./frame.html", import.meta.url);
const FRAME_SCRIPT = new URL("./frame.js", import.meta.url);

export const PAGE_CSP = (nonce: string) =>
	`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export const FRAME_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";

export function mermaidPath(): string | undefined {
	try {
		return createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
	} catch {
		return undefined;
	}
}

export function pageTemplate(): string {
	const markdown = readFileSync(MARKDOWN, "utf8");
	if (/<\/script/i.test(markdown) || markdown.includes("__NONCE__")) throw new Error("annotate: markdown.js cannot be inlined");
	return readFileSync(PAGE, "utf8").replace("__MARKDOWN_JS__", () => markdown);
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

export function parseSend(body: unknown): { seq: number; items: Annotation[]; delivery: AnnotationDelivery } | string {
	const seq = (body as { seq?: unknown } | null)?.seq;
	if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return "seq must be a positive integer";
	const items = (body as { items?: unknown } | null)?.items;
	if (!Array.isArray(items) || items.length === 0) return "items must be a non-empty array";
	if (items.length > MAX_ITEMS) return `at most ${MAX_ITEMS} items`;
	const out: Annotation[] = [];
	for (const item of items) {
		const quote = (item as { quote?: unknown } | null)?.quote;
		const note = (item as { note?: unknown } | null)?.note ?? "";
		if (typeof quote !== "string" || quote.trim() === "") return "every item needs a non-empty quote";
		if (typeof note !== "string") return "note must be a string";
		out.push({ quote, note });
	}
	const delivery = (body as { delivery?: unknown }).delivery;
	if (delivery !== undefined && delivery !== "editor" && delivery !== "agent") return 'delivery must be "editor" or "agent"';
	return { seq, items: out, delivery: delivery ?? "editor" };
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
	const template = pageTemplate();
	const framePage = readFileSync(FRAME_PAGE, "utf8");
	const frameScript = readFileSync(FRAME_SCRIPT, "utf8");
	const token = randomBytes(24).toString("base64url");
	const sessionId = options.sessionId;
	const longPollMs = options.longPollMs ?? LONG_POLL_MS;
	const maxLongPolls = options.maxLongPolls ?? MAX_LONG_POLLS;
	const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
	let items = [...options.items];
	let version = 1;
	let updates: Update[] = [];
	let lastSeq = 0;
	let closed = false;
	let port = 0;
	const sockets = new Set<Socket>();
	const waiters = new Set<() => void>();

	const close = (reason: CloseReason) => {
		if (closed) return;
		closed = true;
		for (const wake of [...waiters]) wake();
		server.close();
		for (const socket of sockets) socket.destroy();
		options.onClose?.(reason);
	};

	const update = (next: SnapshotItem[]): Update | undefined => {
		if (closed) return undefined;
		const diff = diffItems(items, next);
		if (!diff) return undefined;
		items = [...next];
		version += 1;
		const entry: Update = { version, reset: diff.reset, items: diff.items };
		updates.push(entry);
		if (updates.length > MAX_UPDATES) updates = updates.slice(-MAX_UPDATES);
		for (const wake of [...waiters]) wake();
		return entry;
	};

	const changesAfter = (after: number): Update => {
		const pending = updates.filter((entry) => entry.version > after);
		const known = after >= 1 && after <= version && (after === version || (updates.length > 0 && updates[0]!.version <= after + 1));
		if (!known || pending.some((entry) => entry.reset)) return { version, reset: true, items };
		return { version, reset: false, items: pending.flatMap((entry) => entry.items) };
	};

	const servePage = (res: ServerResponse) => {
		const nonce = randomBytes(16).toString("base64");
		res.writeHead(200, {
			...baseHeaders(),
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": PAGE_CSP(nonce),
		});
		res.end(template.replaceAll("__NONCE__", nonce));
	};

	const frameHeaders = (type: string) => ({ ...baseHeaders(), "Content-Type": type, "X-Frame-Options": "SAMEORIGIN", "Content-Security-Policy": FRAME_CSP });

	const serveMermaid = (req: IncomingMessage, res: ServerResponse) => {
		const file = mermaidPath();
		if (!file) return sendJson(res, 404, { error: "mermaid is not installed" });
		const stat = statSync(file);
		const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
		const headers = { ...frameHeaders("text/javascript; charset=utf-8"), "Cache-Control": "no-cache", ETag: etag };
		if (req.headers["if-none-match"] === etag) {
			res.writeHead(304, headers);
			res.end();
			return;
		}
		res.writeHead(200, { ...headers, "Content-Length": String(stat.size) });
		const stream = createReadStream(file);
		stream.on("error", () => res.destroy());
		stream.pipe(res);
	};

	const serveFrame = (path: string, req: IncomingMessage, res: ServerResponse) => {
		req.resume();
		if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
		if (path === "/frame") {
			res.writeHead(200, frameHeaders("text/html; charset=utf-8"));
			res.end(framePage);
			return;
		}
		if (path === "/frame/frame.js") {
			res.writeHead(200, frameHeaders("text/javascript; charset=utf-8"));
			res.end(frameScript);
			return;
		}
		if (path === "/frame/mermaid.js") return serveMermaid(req, res);
		sendJson(res, 404, { error: "not found" });
	};

	const switchedPage = (res: ServerResponse) => {
		res.writeHead(410, { ...baseHeaders(), "Content-Type": "text/plain; charset=utf-8" });
		res.end(`${SESSION_SWITCHED}\n`);
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

	const handleSend = (req: IncomingMessage, res: ServerResponse) => {
		if (!isJson(req)) {
			sendJson(res, 415, { error: "Content-Type must be application/json" });
			req.resume();
			return;
		}
		readBody(req, res, (text) => {
			if (closed) return sendJson(res, 410, { error: SESSION_SWITCHED });
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return sendJson(res, 400, { error: "invalid JSON" });
			}
			const parsed = parseSend(body);
			if (typeof parsed === "string") return sendJson(res, 400, { error: parsed });
			if (!options.isCurrent()) return sendJson(res, 410, { error: SESSION_SWITCHED });
			if (parsed.seq !== lastSeq + 1) return sendJson(res, 409, { error: `expected seq ${lastSeq + 1}`, expectedSeq: lastSeq + 1 });
			let inserted: number;
			try {
				inserted = options.onSend(parsed.items, parsed.seq, parsed.delivery);
			} catch (error) {
				if (error instanceof SessionSwitchedError) return sendJson(res, 410, { error: SESSION_SWITCHED });
				return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
			lastSeq = parsed.seq;
			sendJson(res, 200, { ok: true, inserted, seq: parsed.seq, nextSeq: lastSeq + 1 });
		});
	};

	const handleEvents = (query: URLSearchParams, res: ServerResponse) => {
		const after = Number(query.get("after") ?? Number.NaN);
		if (!Number.isInteger(after) || after < 0) return sendJson(res, 400, { error: "after must be a version number" });
		if (after !== version) return sendJson(res, 200, changesAfter(after));
		if (waiters.size >= maxLongPolls) return sendJson(res, 429, { error: `at most ${maxLongPolls} live connections` });
		let timer: NodeJS.Timeout | undefined;
		const finish = guarded(res, () => {
			waiters.delete(finish);
			if (timer) clearTimeout(timer);
			if (closed) return;
			if (!options.isCurrent()) return sendJson(res, 410, { error: SESSION_SWITCHED });
			sendJson(res, 200, changesAfter(after));
		});
		waiters.add(finish);
		timer = setTimeout(finish, longPollMs);
		res.on("close", () => {
			if (waiters.delete(finish) && timer) clearTimeout(timer);
		});
	};

	const route = (req: IncomingMessage, res: ServerResponse) => {
		if (closed) {
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
		const { path, parts, query } = target;
		if (path === "/frame" || path.startsWith("/frame/")) return serveFrame(path, req, res);
		if (parts.length === 0 || parts.length === 2 || parts.length > 3 || (parts.length === 3 && parts[1] !== "api")) {
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
		if (parts.length === 1) {
			if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			if (pathSession !== sessionId || !options.isCurrent()) return switchedPage(res);
			return servePage(res);
		}
		const endpoint = parts[2];
		if (endpoint !== "snapshot" && endpoint !== "events" && endpoint !== "send") {
			sendJson(res, 404, { error: "not found" });
			req.resume();
			return;
		}
		if (pathSession !== sessionId || !options.isCurrent()) {
			sendJson(res, 410, { error: SESSION_SWITCHED });
			req.resume();
			return;
		}
		const given = req.headers[TOKEN_HEADER];
		if (!sameToken(Array.isArray(given) ? given[0] : given, token)) {
			sendJson(res, 403, { error: "missing or wrong X-Annotate-Token" });
			req.resume();
			return;
		}
		if (endpoint === "send") {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "method not allowed" });
				req.resume();
				return;
			}
			return handleSend(req, res);
		}
		if (req.method !== "GET") {
			sendJson(res, 405, { error: "method not allowed" });
			req.resume();
			return;
		}
		if (endpoint === "snapshot") return sendJson(res, 200, { sessionId, version, nextSeq: lastSeq + 1, items });
		return handleEvents(query, res);
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
		url: `http://127.0.0.1:${port}/${encodeURIComponent(sessionId)}#t=${token}`,
		port,
		token,
		sessionId,
		get closed() {
			return closed;
		},
		get version() {
			return version;
		},
		update,
		close,
	};
}
