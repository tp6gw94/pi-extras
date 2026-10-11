import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Annotation } from "./quote.ts";
import type { Snapshot } from "./snapshot.ts";

export const TOKEN_HEADER = "x-annotate-token";
export const MAX_BODY_BYTES = 1024 * 1024;
export const IDLE_MS = 30 * 60 * 1000;
export const MAX_ITEMS = 500;
export const SESSION_SWITCHED = "Session switched, run /annotate again.";

export type CloseReason = "sent" | "idle" | "session" | "replaced";

export class SessionSwitchedError extends Error {
	constructor() {
		super(SESSION_SWITCHED);
	}
}

export interface AnnotateServerOptions {
	snapshot: Snapshot;
	isCurrent(): boolean;
	onSend(items: Annotation[]): number;
	onClose?(reason: CloseReason): void;
	idleMs?: number;
	closeDelayMs?: number;
	maxBodyBytes?: number;
}

export interface AnnotateServer {
	readonly url: string;
	readonly port: number;
	readonly token: string;
	readonly closed: boolean;
	setSnapshot(snapshot: Snapshot): void;
	close(reason: CloseReason): void;
}

const PAGE = new URL("./page.html", import.meta.url);

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
	res.writeHead(status, { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8", ...extra });
	res.end(JSON.stringify(body));
}

export function parseItems(body: unknown): Annotation[] | string {
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
	return out;
}

function isJson(req: IncomingMessage): boolean {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.split(";")[0]!.trim().toLowerCase() === "application/json";
}

export async function startAnnotateServer(options: AnnotateServerOptions): Promise<AnnotateServer> {
	const template = readFileSync(PAGE, "utf8");
	const token = randomBytes(24).toString("base64url");
	const idleMs = options.idleMs ?? IDLE_MS;
	const closeDelayMs = options.closeDelayMs ?? 250;
	const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
	let snapshot = options.snapshot;
	let used = false;
	let closed = false;
	let port = 0;
	let idleTimer: NodeJS.Timeout | undefined;
	const sockets = new Set<Socket>();

	const touch = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => close("idle"), idleMs);
		idleTimer.unref?.();
	};

	const close = (reason: CloseReason) => {
		if (closed) return;
		closed = true;
		if (idleTimer) clearTimeout(idleTimer);
		server.close();
		for (const socket of sockets) socket.destroy();
		options.onClose?.(reason);
	};

	const servePage = (res: ServerResponse) => {
		const nonce = randomBytes(16).toString("base64");
		res.writeHead(200, {
			...baseHeaders(),
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		});
		res.end(template.replaceAll("__NONCE__", nonce));
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
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			size += chunk.length;
			if (size > maxBodyBytes) {
				rejected = true;
				sendJson(res, 413, { error: "body too large" }, { Connection: "close" });
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!rejected) done(Buffer.concat(chunks).toString("utf8"));
		});
	};

	const handleSend = (req: IncomingMessage, res: ServerResponse) => {
		if (!isJson(req)) {
			sendJson(res, 415, { error: "Content-Type must be application/json" });
			req.resume();
			return;
		}
		readBody(req, res, (text) => {
			if (used || closed) return sendJson(res, 410, { error: "this page was already sent; run /annotate again" });
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return sendJson(res, 400, { error: "invalid JSON" });
			}
			const items = parseItems(body);
			if (typeof items === "string") return sendJson(res, 400, { error: items });
			if (!options.isCurrent()) return sendJson(res, 409, { error: SESSION_SWITCHED });
			let inserted: number;
			try {
				inserted = options.onSend(items);
			} catch (error) {
				if (error instanceof SessionSwitchedError) return sendJson(res, 409, { error: SESSION_SWITCHED });
				return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			}
			used = true;
			sendJson(res, 200, { ok: true, inserted });
			setTimeout(() => close("sent"), closeDelayMs).unref?.();
		});
	};

	const server = createServer((req, res) => {
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
		touch();
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		if (url.pathname === "/") {
			if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
			if (used || !sameToken(url.searchParams.get("token") ?? undefined, token)) return sendJson(res, 403, { error: "bad or expired token" });
			return servePage(res);
		}
		if (url.pathname === "/api/snapshot" || url.pathname === "/api/send") {
			const given = req.headers[TOKEN_HEADER];
			if (!sameToken(Array.isArray(given) ? given[0] : given, token)) {
				sendJson(res, 403, { error: "missing or wrong X-Annotate-Token" });
				req.resume();
				return;
			}
			if (used) {
				sendJson(res, 410, { error: "this page was already sent; run /annotate again" });
				req.resume();
				return;
			}
			if (url.pathname === "/api/snapshot") {
				if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
				if (!options.isCurrent()) return sendJson(res, 409, { error: SESSION_SWITCHED });
				return sendJson(res, 200, snapshot);
			}
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "method not allowed" });
				req.resume();
				return;
			}
			return handleSend(req, res);
		}
		sendJson(res, 404, { error: "not found" });
		req.resume();
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	server.unref();
	port = (server.address() as AddressInfo).port;
	touch();

	return {
		url: `http://127.0.0.1:${port}/?token=${token}`,
		port,
		token,
		get closed() {
			return closed;
		},
		setSnapshot(next) {
			snapshot = next;
			touch();
		},
		close,
	};
}
