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

export type LiveEvent =
	| { type: "update"; version: number; reset: boolean; items: SnapshotItem[] }
	| { type: "moved"; snapshot: InitialSnapshot };

export type SendOutcome =
	| { ok: true; inserted: number; nextSeq: number }
	| { ok: false; kind: "conflict"; expectedSeq: number }
	| { ok: false; kind: "rejected"; reason: string }
	| { ok: false; kind: "moved"; snapshot?: InitialSnapshot };

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
	readonly sessionId: string;
	snapshot(): Promise<InitialSnapshot>;
	watch(after: number, signal: AbortSignal): Promise<LiveEvent>;
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

function successorOf(body: Record<string, unknown>): { sessionId: string; token: string } | undefined {
	const next = body.successor;
	if (next === null || typeof next !== "object") return undefined;
	const successor = next as Record<string, unknown>;
	if (typeof successor.sessionId !== "string" || typeof successor.token !== "string") return undefined;
	return { sessionId: successor.sessionId, token: successor.token };
}

export function createClient(target: AttachTarget, fetchImpl: typeof fetch = fetch): AnnotateClient {
	let current: AttachTarget = target;
	let reported: AttachTarget = target;
	const snapshots = new Map<AttachTarget, Promise<InitialSnapshot | undefined>>();

	async function call(requested: AttachTarget, endpoint: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown>; moved: boolean }> {
		let response: Response;
		try {
			response = await fetchImpl(`http://127.0.0.1:${requested.port}/${encodeURIComponent(requested.sessionId)}/api/${endpoint}`, {
				...init,
				headers: { ...(init.headers as Record<string, string>), [TOKEN_HEADER]: requested.token },
			});
		} catch (error) {
			throw new ProtocolError("unreachable", error instanceof Error ? error.message : String(error));
		}
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		const successor = response.status === 410 ? successorOf(body) : undefined;
		if (successor && (successor.sessionId !== current.sessionId || successor.token !== current.token)) {
			current = { port: current.port, ...successor };
		}
		return { status: response.status, body, moved: successor !== undefined };
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

	function snapshotOf(target: AttachTarget): Promise<InitialSnapshot | undefined> {
		let snapshot = snapshots.get(target);
		if (!snapshot) {
			snapshot = call(target, "snapshot").then((result) => {
				if (result.moved) return undefined;
				if (result.status !== 200) throw failure(result.status, result.body);
				return { version: numberField(result.body, "version"), nextSeq: numberField(result.body, "nextSeq"), items: parseItems(result.body.items) };
			});
			snapshots.set(target, snapshot);
		}
		return snapshot;
	}

	async function headSnapshot(): Promise<InitialSnapshot> {
		while (true) {
			const target = current;
			const snapshot = await snapshotOf(target);
			if (snapshot && current === target) return snapshot;
		}
	}

	return {
		get sessionId() {
			return current.sessionId;
		},
		async snapshot() {
			const result = await headSnapshot();
			reported = current;
			return result;
		},
		async watch(after, signal) {
			while (true) {
				if (current !== reported) {
					const snapshot = await headSnapshot();
					after = snapshot.version;
					if (current === reported) continue;
					reported = current;
					return { type: "moved", snapshot };
				}
				const result = await call(current, `events?after=${after}`, { signal });
				if (result.moved) continue;
				if (result.status !== 200) throw failure(result.status, result.body);
				return { type: "update", version: numberField(result.body, "version"), reset: result.body.reset === true, items: parseItems(result.body.items) };
			}
		},
		async send(seq, items, delivery) {
			const result = await call(current, "send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ seq, delivery, items: items.map(({ quote, note }) => ({ quote, note })) }),
			});
			if (result.moved) {
				const snapshot = current !== reported ? await headSnapshot() : undefined;
				reported = current;
				return { ok: false, kind: "moved", snapshot };
			}
			if (result.status === 409 && typeof result.body.expectedSeq === "number") return { ok: false, kind: "conflict", expectedSeq: result.body.expectedSeq };
			if (result.status === 403 || result.status === 410) throw failure(result.status, result.body);
			if (result.status !== 200) return { ok: false, kind: "rejected", reason: errorText(result.status, result.body) };
			return { ok: true, inserted: numberField(result.body, "inserted"), nextSeq: numberField(result.body, "nextSeq") };
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
