import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { annotationsText, type Annotation } from "./quote.ts";
import type { SnapshotItem } from "./snapshot.ts";

type Anchor = { itemId: string; start: number; end: number; quote: string; sourceText?: string };
type Turn = { id: string; text: string } & (
	| { status: "running" }
	| { status: "completed"; reply: string }
	| { status: "interrupted" | "failed"; error: string }
);
type Note = { id: string; anchor: Anchor | null; text: string } & (
	| { status: "pending" | "appended" | "sent" }
	| { status: "thread"; turns: Turn[]; model: Model; childCreated?: true }
);

const noteVersion = (note: Note) => createHash("sha256").update(JSON.stringify([note.text, note.anchor])).digest("base64url");

type SendOutcome = "sent" | "not-sent";
type Receipt = { id: string; status: "receipt"; digest: string } & (
	| { confirmed: false; noteIds: string[] }
	| { confirmed: true; abandoned?: true }
);
type SendAttempt = { controller: AbortController; active: boolean; outcome?: SendOutcome };
type StoredNote = Receipt | Note | { id: string; status: "deleted" };

export type Model = { provider: string; id: string };
export type ThreadPrompt = { original: string; reply?: string };

export type ChildPublicationAttempt = { recordIntent(): void; clearUnpublishedIntent(): void };

export class ReviewError extends Error {
	readonly pendingSendRequestId?: string;

	constructor(message: string, pendingSendRequestId?: string) {
		super(message);
		this.pendingSendRequestId = pendingSendRequestId;
	}
}

export function publishJson(file: string, value: unknown) {
	const staged = `${file}.tmp`;
	writeFileSync(staged, JSON.stringify(value), { mode: 0o600 });
	renameSync(staged, file);
}

function requireValue(test: unknown, message: string): asserts test {
	if (!test) throw new ReviewError(message);
}

const nonblank = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_RECEIPT_TIMEOUT_MS = 8000;
const RECEIPT_UNKNOWN = "Receipt unknown. Check the source conversation before sending again.";
const LIVE_RECEIPT_UNKNOWN = "Receipt unknown. Main Pi may still deliver this message. Check again or confirm it was sent if you see it.";
const SEND_ACTIVE = "Main Pi send is still in progress.";
const NOT_SENT = "This request was not sent. Start a new send.";
const ACCEPTED_SAVE_FAILED = "Main Pi accepted the message, but the receipt could not be saved. Retry this request to save the receipt.";

export function openReview(
	dir: string,
	deps: {
		items(): SnapshotItem[];
		prepareDelivery(items: Annotation[]): () => void;
		prepareSend?(text: string): (signal: AbortSignal) => Promise<void>;
		sendReceiptTimeoutMs?: number;
		model(): Model | undefined;
		run(file: string, model: Model, create: boolean, prompt: ThreadPrompt, signal: AbortSignal, publication: ChildPublicationAttempt): Promise<string>;
		reportPersistenceError(message: string): void;
	},
) {
	let sqlite: typeof import("node:sqlite");
	try {
		sqlite = createRequire(import.meta.url)("node:sqlite");
	} catch {
		throw new ReviewError("Herdr review requires a Node runtime with node:sqlite.");
	}
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const lock = new sqlite.DatabaseSync(join(dir, "owner.sqlite"));
	try {
		lock.exec("BEGIN EXCLUSIVE");
	} catch (error) {
		lock.close();
		const { code, errstr } = error as { code?: string; errstr?: string };
		if (code === "ERR_SQLITE_ERROR" && (errstr === "database is locked" || errstr === "database table is locked")) {
			throw new ReviewError("This source already has a review owner.");
		}
		throw error;
	}
	const file = join(dir, "notes.json");
	let notes: StoredNote[];
	try {
		notes = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
	} catch (error) {
		lock.close();
		throw error;
	}
	const commit = () => publishJson(file, notes);
	const reportPersistenceError = (error: unknown) => {
		const code = (error as NodeJS.ErrnoException).code;
		deps.reportPersistenceError(`Herdr review could not save notes${code ? ` (${code})` : ""}.`);
	};

	const commitRequest = (next: StoredNote[], errorMessage = "Herdr review could not save the change.") => {
		try {
			publishJson(file, next);
		} catch (error) {
			reportPersistenceError(error);
			throw new ReviewError(errorMessage);
		}
		notes = next;
	};
	const interrupt = () => {
		let changed = false;
		for (const note of notes) {
			if (note.status !== "thread") continue;
			note.turns = note.turns.map((turn) => {
				if (turn.status !== "running") return turn;
				changed = true;
				return { ...turn, status: "interrupted", error: "Source stopped. Send a new reply to continue." };
			});
		}
		if (changed) commit();
	};
	try {
		interrupt();
	} catch (error) {
		lock.close();
		throw error;
	}

	const controller = new AbortController();
	const jobs = new Set<Promise<void>>();
	const sends = new Map<string, SendAttempt>();

	const request = (body?: unknown) => {
		const items = new Map(deps.items().map((item) => [item.id, item.text]));
		const visible = () => notes.filter((entry): entry is Note => entry.status !== "receipt" && entry.status !== "deleted" && (!entry.anchor || items.has(entry.anchor.itemId)));
		const current = (noteId?: string) => {
			const publicNotes = visible().map((note) => {
				if (note.status !== "thread") return note.status === "pending" ? { ...note, version: noteVersion(note) } : note;
				const { model, childCreated, ...publicNote } = note;
				return publicNote;
			});
			return { notes: publicNotes, ...(noteId === undefined ? {} : { noteId }) };
		};
		let noteId: string | undefined;
		if (body !== undefined) {
			requireValue(body && typeof body === "object", "Expected a review action.");
			const payload = body as Record<string, unknown>;
			let note = visible().find((entry) => entry.id === payload.noteId);
			const reserved = notes.flatMap(entry => entry.status === "receipt" && !entry.confirmed ? entry.noteIds : []);
			if ((note && reserved.includes(note.id)) || payload.action === "deliver" && Array.isArray(payload.noteIds) && payload.noteIds.some(id => reserved.includes(id))) {
				throw new ReviewError("Receipt unknown for a selected note.");
			}
			if (payload.action === "copy") {
				const source = notes.find(entry => entry.id === payload.noteId && entry.status === "thread");
				requireValue(source?.status === "thread", "Select a thread to copy.");
				requireValue(typeof payload.createId === "string" && uuid.test(payload.createId), "Expected a UUID for the copy.");
				noteId = payload.createId;
				if (!notes.some(entry => entry.status !== "receipt" && entry.id === noteId)) {
					const original = source.anchor;
					const item = original ? items.get(original.itemId) : undefined;
					const anchor = original && item !== undefined && original.end <= item.length
						&& item.slice(original.start, original.end) === (original.sourceText ?? original.quote) ? original : null;
					const parts = [!anchor && original ? original.quote : "", source.text];
					for (const [i, turn] of source.turns.entries()) {
						if (turn.status === "completed") parts.push(...(i ? [turn.text] : []), turn.reply);
					}
					commitRequest([...notes, { id: noteId, status: "pending", text: parts.filter(Boolean).join("\n\n"), anchor }]);
				}
			} else if (payload.action === "save") {
				let createId: string | undefined;
				if (payload.noteId !== undefined) {
					requireValue(note?.status === "pending", "Only current pending notes can be edited.");
					requireValue(payload.expectedText === note.text, "This note changed since you opened it. Reopen it before saving.");
				} else if (payload.createId !== undefined) {
					requireValue(typeof payload.createId === "string" && uuid.test(payload.createId), "Expected a UUID for the new note.");
					createId = payload.createId;
				}
				if (createId && notes.some((entry) => entry.status !== "receipt" && entry.id === createId)) {
					noteId = createId;
				} else {
					const given = payload.anchor as Anchor | null;
					if (note && !note.anchor && given === null && nonblank(payload.text)) {
						const saved = { ...note, text: payload.text };
						commitRequest(notes.map(entry => entry === note ? saved : entry));
						return current(saved.id);
					}
					const item = given ? items.get(given.itemId) : undefined;
					requireValue(
						given && item !== undefined && Number.isInteger(given.start) && Number.isInteger(given.end) && given.start >= 0 && given.end > given.start && given.end <= item.length && nonblank(given.quote) && nonblank(payload.text),
						"Select a current range and enter a comment.",
					);
					const { itemId, start, end, quote, sourceText } = given;
					requireValue(sourceText === undefined || sourceText === item.slice(start, end), "The selected source text changed. Select it again before saving.");
					const anchor = { itemId, start, end, quote, ...(sourceText === undefined ? {} : { sourceText }) };
					const saved: Note = { id: note?.id ?? createId ?? randomUUID(), status: "pending", anchor, text: payload.text };
					commitRequest(note ? notes.map((entry) => entry === note ? saved : entry) : [...notes, saved]);
					noteId = saved.id;
				}
			} else if (payload.action === "deliver") {
				const ids = payload.noteIds;
				requireValue(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length, "Select distinct pending notes.");
				const batch = ids.map((id) => visible().find((entry) => entry.id === id));
				requireValue(batch.every((entry) => entry?.status === "pending"), "Only current pending notes can be appended.");
				const append = deps.prepareDelivery(batch.map((entry) => ({ quote: entry!.anchor?.quote ?? null, note: entry!.text })));
				commitRequest(notes.map((entry) => entry.status !== "receipt" && entry.status !== "deleted" && batch.includes(entry) ? { ...entry, status: "appended" } : entry));
				try {
					append();
				} catch {
					throw new ReviewError("Could not confirm the editor append. The batch was consumed; check the editor before copying it manually.");
				}
			} else if (payload.action === "delete") {
				requireValue(note?.status === "pending", "Only current pending notes can be deleted.");
				commitRequest(notes.map((entry) => entry === note ? { id: note.id, status: "deleted" } : entry));
			} else {
				const first = payload.action === "start";
				const fresh = first && payload.noteId === undefined;
				if (fresh) {
					requireValue(typeof payload.createId === "string" && uuid.test(payload.createId) && nonblank(payload.text), "Enter a question and a creation UUID.");
					noteId = payload.createId;
					const prior = notes.find(entry => entry.status !== "receipt" && entry.id === noteId);
					if (prior) {
						requireValue(prior.status === "thread" && prior.anchor === null && prior.text === payload.text, "Creation ID already used.");
						return current(noteId);
					}
					note = { id: noteId, status: "pending", anchor: null, text: payload.text };
				}
				requireValue(note && (first ? note.status === "pending" : payload.action === "reply" && note.status === "thread" && nonblank(payload.text)), "Action unavailable for this note.");
				const model = note.status === "thread" ? note.model : deps.model();
				requireValue(model, "No model selected.");
				const history = note.status === "thread" ? note.turns : [];
				const text = first ? note.text : payload.text as string;
				const requestId = first ? undefined : payload.requestId;
				if (requestId !== undefined) {
					requireValue(typeof requestId === "string" && uuid.test(requestId), "Expected a UUID for the reply.");
					const replay = history.find(turn => turn.id === requestId);
					if (replay) {
						requireValue(replay.text === text, "This request ID was used with different text.");
						return current();
					}
				}
				requireValue(!history.some((turn) => turn.status === "running"), "A turn is already running.");
				const threadFile = join(dir, `${note.id}.jsonl`);
				const create = !existsSync(threadFile);
				const mustReuseChild = note.status === "thread" && (note.childCreated || history.some((turn) => turn.status === "completed"));
				requireValue(!create || !mustReuseChild, "The original child session is unavailable.");
				const turn: Turn = { id: requestId ?? randomUUID(), text, status: "running" };
				const turns = [...history, turn];
				const thread: Note = { ...note, status: "thread", model: { provider: model.provider, id: model.id }, turns, childCreated: create ? undefined : true };
				commitRequest(fresh ? [...notes, thread] : notes.map((entry) => entry === note ? thread : entry));
				const setChildIntent = (childCreated: true | undefined) => {
					controller.signal.throwIfAborted();
					commitRequest(notes.map((entry) => entry.status === "thread" && entry.turns === turns ? { ...entry, childCreated } : entry));
				};
				const publication = { recordIntent: () => setChildIntent(true), clearUnpublishedIntent: () => setChildIntent(undefined) };
				const prompt = { original: note.anchor ? `${note.anchor.quote}\n\n${note.text}` : note.text, reply: first ? undefined : text };
				const job = deps
					.run(threadFile, model, create, prompt, controller.signal, publication)
					.then(
						(reply) => ({ ...turn, status: "completed" as const, reply }),
						(error) => ({ ...turn, status: "failed" as const, error: error instanceof ReviewError ? error.message : "Background Pi could not complete this turn." }),
					)
					.then((result) => {
						if (controller.signal.aborted) return;
						const index = turns.length - 1;
						turns[index] = result;
						try {
							commit();
						} catch (error) {
							turns[index] = { ...turn, status: "failed", error: "Could not save the background turn result. Send a new reply to continue." };
							reportPersistenceError(error);
						}
					})
					.finally(() => jobs.delete(job));
				jobs.add(job);
			}
		}
		return current(noteId);
	};

	const settleReceipt = (receipt: Receipt, outcome: SendOutcome) => {
		const { id, digest } = receipt;
		if (receipt.confirmed) {
			requireValue(outcome === (receipt.abandoned ? "not-sent" : "sent"), "This receipt already has a different outcome.");
			return;
		}
		const attempt = sends.get(id);
		requireValue(!attempt?.outcome || attempt.outcome === outcome, "This receipt already has a different outcome.");
		const terminal: Receipt = { id, digest, status: "receipt", confirmed: true, ...(outcome === "not-sent" ? { abandoned: true } : {}) };
		commitRequest(notes.map(entry => {
			if (entry === receipt) return terminal;
			if (outcome === "sent" && entry.status === "pending" && receipt.noteIds.includes(entry.id)) return { ...entry, status: "sent" };
			return entry;
		}), attempt?.outcome === "sent" ? ACCEPTED_SAVE_FAILED : undefined);
		sends.delete(id);
		attempt?.controller.abort();
	};

	const checkReceipt = (receipt: Receipt, attempt: SendAttempt | undefined) => {
		requireValue(!attempt?.active, SEND_ACTIVE);
		let outcome = attempt?.outcome;
		if (receipt.confirmed) outcome = receipt.abandoned ? "not-sent" : "sent";
		requireValue(outcome, attempt ? LIVE_RECEIPT_UNKNOWN : RECEIPT_UNKNOWN);
		if (!receipt.confirmed) settleReceipt(receipt, outcome);
		requireValue(outcome === "sent", NOT_SENT);
		return { ...request(), sentRequestId: receipt.id };
	};

	const handle = async (body?: unknown) => {
		if (!body || typeof body !== "object" || !("action" in body) || (body.action !== "send" && body.action !== "resolve-send" && body.action !== "check-send")) return request(body);
		const { requestId, noteIds, noteVersions, text, outcome } = body as Record<string, unknown>;
		requireValue(typeof requestId === "string" && uuid.test(requestId), "Expected a UUID for the send receipt.");
		const prior = notes.find((entry): entry is Receipt => entry.status === "receipt" && entry.id === requestId);
		const attempt = sends.get(requestId);
		const pending = notes.find((entry): entry is Receipt => entry.status === "receipt" && !entry.confirmed);
		if (body.action === "check-send") {
			if (!prior) {
				commitRequest([...notes, { id: requestId, status: "receipt", digest: "", confirmed: true, abandoned: true }]);
				throw new ReviewError(NOT_SENT, pending?.id);
			}
			return checkReceipt(prior, attempt);
		}
		if (body.action === "resolve-send") {
			requireValue(outcome === "sent" || outcome === "not-sent", "Specify whether the message was sent.");
			requireValue(prior, "No saved receipt for this request.");
			requireValue(!attempt?.active, SEND_ACTIVE);
			requireValue(outcome !== "not-sent" || !attempt || attempt.outcome, LIVE_RECEIPT_UNKNOWN);
			settleReceipt(prior, outcome);
			return { ...request(), ...(outcome === "sent" ? { sentRequestId: requestId } : { resolvedRequestId: requestId }) };
		}
		requireValue(Array.isArray(noteIds) && noteIds.every(id => typeof id === "string") && new Set(noteIds).size === noteIds.length && typeof text === "string" && (noteIds.length || text.trim()), "Select pending notes or enter a message.");
		requireValue(Array.isArray(noteVersions) && noteVersions.length === noteIds.length && noteVersions.every(version => typeof version === "string"), "Expected an observed version for each selected note.");
		const digest = createHash("sha256").update(JSON.stringify([noteIds, noteVersions, text])).digest("hex");
		if (prior) {
			if (prior.confirmed && prior.abandoned && prior.digest === "") throw new ReviewError(NOT_SENT, pending?.id);
			requireValue(prior.digest === digest, "Request ID already used with a different message.");
			return checkReceipt(prior, attempt);
		}
		if (pending) {
			const sending = sends.get(pending.id);
			throw new ReviewError(sending?.active ? SEND_ACTIVE : sending ? LIVE_RECEIPT_UNKNOWN : RECEIPT_UNKNOWN, pending.id);
		}
		const items = new Map(deps.items().map(item => [item.id, item.text]));
		const batch = noteIds.map((id, index) => {
			const note = notes.find(entry => entry.id === id);
			requireValue(note?.status === "pending", "Only current pending notes can be sent.");
			requireValue(noteVersion(note) === noteVersions[index], "A selected note changed. Review the notes before sending again.");
			if (note.anchor) {
				const { itemId, start, end, sourceText, quote } = note.anchor;
				const item = items.get(itemId);
				requireValue(item !== undefined && end <= item.length && item.slice(start, end) === (sourceText ?? quote), "Only current pending notes can be sent.");
			}
			return { quote: note.anchor?.quote ?? null, note: note.text };
		});
		const message = [annotationsText(batch)?.trimEnd(), text].filter(Boolean).join("\n\n");
		const dispatch = deps.prepareSend?.(message);
		requireValue(dispatch, "Main Pi send unavailable.");
		const receipt: Receipt = { id: requestId, status: "receipt", digest, noteIds, confirmed: false };
		commitRequest([...notes, receipt]);
		const sending: SendAttempt = { controller: new AbortController(), active: true };
		sends.set(requestId, sending);
		let acceptance: Promise<void>;
		try {
			acceptance = dispatch(sending.controller.signal);
		} catch {
			sending.active = false;
			sending.outcome = "not-sent";
			settleReceipt(receipt, sending.outcome);
			throw new ReviewError(NOT_SENT);
		}
		const confirmed = acceptance.then(() => {
			if (sending.controller.signal.aborted) throw new ReviewError(RECEIPT_UNKNOWN);
			sending.outcome = "sent";
			settleReceipt(receipt, sending.outcome);
		}, () => {
			throw new ReviewError(sending.controller.signal.aborted ? RECEIPT_UNKNOWN : LIVE_RECEIPT_UNKNOWN);
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new ReviewError(LIVE_RECEIPT_UNKNOWN)), deps.sendReceiptTimeoutMs ?? SEND_RECEIPT_TIMEOUT_MS);
		});
		try {
			await Promise.race([confirmed, timeout]);
		} finally {
			clearTimeout(timer);
			sending.active = false;
		}
		return { ...request(), sentRequestId: requestId };
	};

	return {
		handle,
		request,
		async close() {
			controller.abort();
			try {
				interrupt();
			} catch (error) {
				reportPersistenceError(error);
			} finally {
				await Promise.allSettled(jobs);
				for (const attempt of sends.values()) attempt.controller.abort();
				lock.close();
			}
		},
	};
}
