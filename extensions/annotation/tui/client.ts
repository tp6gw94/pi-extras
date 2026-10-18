import type { Annotation, AnnotationDelivery } from "../quote.ts";
import type { SnapshotItem } from "../snapshot.ts";
import { TOKEN_HEADER } from "../server.ts";

export interface AttachTarget {
	sessionId: string;
	port: number;
	token: string;
}

export interface InitialSnapshot {
	version: number;
	nextSeq: number;
	items: SnapshotItem[];
}

export interface LiveUpdate {
	version: number;
	reset: boolean;
	items: SnapshotItem[];
}

export type SendOutcome =
	| { ok: true; inserted: number; nextSeq: number }
	| { ok: false; kind: "conflict"; expectedSeq: number }
	| { ok: false; kind: "rejected"; reason: string };

export type ProtocolCode = "unreachable" | "unauthorized" | "switched" | "busy" | "http";

export class ProtocolError extends Error {
	readonly code: ProtocolCode;
	readonly status: number | undefined;

	constructor(code: ProtocolCode, message: string, status?: number) {
		super(message);
		this.name = "ProtocolError";
		this.code = code;
		this.status = status;
	}
}

export interface AnnotateClient {
	snapshot(): Promise<InitialSnapshot>;
	watch(after: number, signal: AbortSignal): Promise<LiveUpdate>;
	send(seq: number, items: readonly Annotation[], delivery: AnnotationDelivery): Promise<SendOutcome>;
}

function parseItems(value: unknown): SnapshotItem[] {
	if (!Array.isArray(value)) throw new ProtocolError("http", "snapshot has no items");
	return value.map((raw) => {
		const item = raw as Partial<SnapshotItem>;
		if (typeof item?.id !== "string" || (item.kind !== "user" && item.kind !== "assistant" && item.kind !== "tool") || typeof item.label !== "string" || typeof item.text !== "string") {
			throw new ProtocolError("http", "snapshot item is malformed");
		}
		return { id: item.id, kind: item.kind, label: item.label, text: item.text };
	});
}

function numberField(body: Record<string, unknown>, key: string): number {
	const value = body[key];
	if (typeof value !== "number") throw new ProtocolError("http", `snapshot has no ${key}`);
	return value;
}

export function createClient(target: AttachTarget, fetchImpl: typeof fetch = fetch): AnnotateClient {
	const base = `http://127.0.0.1:${target.port}/${encodeURIComponent(target.sessionId)}/api`;

	async function call(endpoint: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
		let response: Response;
		try {
			response = await fetchImpl(`${base}/${endpoint}`, {
				...init,
				headers: { ...(init.headers as Record<string, string>), [TOKEN_HEADER]: target.token },
			});
		} catch (error) {
			throw new ProtocolError("unreachable", error instanceof Error ? error.message : String(error));
		}
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: response.status, body };
	}

	function errorText(status: number, body: Record<string, unknown>): string {
		return typeof body.error === "string" ? body.error : `HTTP ${status}`;
	}

	function failure(status: number, body: Record<string, unknown>): ProtocolError {
		if (status === 403) return new ProtocolError("unauthorized", "token rejected", status);
		if (status === 410) return new ProtocolError("switched", "session switched", status);
		if (status === 429) return new ProtocolError("busy", "too many live connections", status);
		return new ProtocolError("http", errorText(status, body), status);
	}

	return {
		async snapshot() {
			const { status, body } = await call("snapshot");
			if (status !== 200) throw failure(status, body);
			return { version: numberField(body, "version"), nextSeq: numberField(body, "nextSeq"), items: parseItems(body.items) };
		},
		async watch(after, signal) {
			const { status, body } = await call(`events?after=${after}`, { signal });
			if (status !== 200) throw failure(status, body);
			return { version: numberField(body, "version"), reset: body.reset === true, items: parseItems(body.items) };
		},
		async send(seq, items, delivery) {
			const { status, body } = await call("send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ seq, delivery, items: items.map(({ quote, note }) => ({ quote, note })) }),
			});
			if (status === 409 && typeof body.expectedSeq === "number") return { ok: false, kind: "conflict", expectedSeq: body.expectedSeq };
			if (status === 403 || status === 410) throw failure(status, body);
			if (status !== 200) return { ok: false, kind: "rejected", reason: errorText(status, body) };
			return { ok: true, inserted: numberField(body, "inserted"), nextSeq: numberField(body, "nextSeq") };
		},
	};
}

export function disconnectReason(error: unknown): string {
	if (error instanceof ProtocolError) {
		if (error.code === "switched") return "pi switched session; run /annotate and attach again";
		if (error.code === "unauthorized") return "token rejected; attach to the new session";
		if (error.code === "unreachable") return "annotate server closed; run /annotate in pi and attach again";
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}
