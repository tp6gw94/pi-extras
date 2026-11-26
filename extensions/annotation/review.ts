import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { Annotation } from "./quote.ts";
import type { SnapshotItem } from "./snapshot.ts";

type Anchor = { itemId: string; start: number; end: number; quote: string };
type Turn = { id: string; text: string } & (
	| { status: "running" }
	| { status: "completed"; reply: string }
	| { status: "interrupted" | "failed"; error: string }
);
type Note = { id: string; anchor: Anchor; text: string } & (
	| { status: "pending" | "appended" }
	| { status: "thread"; turns: Turn[]; model: Model; childCreated?: true }
);

type StoredNote = Note | { id: string; status: "deleted" };

export type Model = { provider: string; id: string };
export type ThreadPrompt = { original: string; reply?: string };

export type ChildPublicationAttempt = { recordIntent(): void; clearUnpublishedIntent(): void };

export class ReviewError extends Error {}

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

export function openReview(
	dir: string,
	deps: {
		items(): SnapshotItem[];
		prepareDelivery(items: Annotation[]): () => void;
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

	const commitRequest = (next: StoredNote[]) => {
		try {
			publishJson(file, next);
		} catch (error) {
			reportPersistenceError(error);
			throw new ReviewError("Herdr review could not save the change.");
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

	const request = (body?: unknown) => {
		const items = new Map(deps.items().map((item) => [item.id, item.text]));
		const visible = () => notes.filter((entry): entry is Note => entry.status !== "deleted" && items.has(entry.anchor.itemId));
		const current = (noteId?: string) => {
			const publicNotes = visible().map((note) => {
				if (note.status !== "thread") return note;
				const { model, childCreated, ...publicNote } = note;
				return publicNote;
			});
			return { notes: publicNotes, ...(noteId === undefined ? {} : { noteId }) };
		};
		let noteId: string | undefined;
		if (body !== undefined) {
			requireValue(body && typeof body === "object", "Expected a review action.");
			const payload = body as Record<string, unknown>;
			const note = visible().find((entry) => entry.id === payload.noteId);
			if (payload.action === "save") {
				let createId: string | undefined;
				if (payload.noteId !== undefined) {
					requireValue(note?.status === "pending", "Only current pending notes can be edited.");
					requireValue(payload.expectedText === note.text, "This note changed since you opened it. Reopen it before saving.");
				} else if (payload.createId !== undefined) {
					requireValue(typeof payload.createId === "string" && uuid.test(payload.createId), "Expected a UUID for the new note.");
					createId = payload.createId;
				}
				if (createId && notes.some((entry) => entry.id === createId)) {
					noteId = createId;
				} else {
					const given = payload.anchor as Anchor;
					const item = given ? items.get(given.itemId) : undefined;
					requireValue(
						item !== undefined && Number.isInteger(given.start) && Number.isInteger(given.end) && given.start >= 0 && given.end > given.start && given.end <= item.length && nonblank(given.quote) && nonblank(payload.text),
						"Select a current range and enter a comment.",
					);
					const anchor = { itemId: given.itemId, start: given.start, end: given.end, quote: given.quote };
					const saved: Note = { id: note?.id ?? createId ?? randomUUID(), status: "pending", anchor, text: payload.text };
					commitRequest(note ? notes.map((entry) => entry === note ? saved : entry) : [...notes, saved]);
					noteId = saved.id;
				}
			} else if (payload.action === "deliver") {
				const ids = payload.noteIds;
				requireValue(Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length, "Select distinct pending notes.");
				const batch = ids.map((id) => visible().find((entry) => entry.id === id));
				requireValue(batch.every((entry) => entry?.status === "pending"), "Only current pending notes can be appended.");
				const append = deps.prepareDelivery(batch.map((entry) => ({ quote: entry!.anchor.quote, note: entry!.text })));
				commitRequest(notes.map((entry) => entry.status !== "deleted" && batch.includes(entry) ? { ...entry, status: "appended" } : entry));
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
				commitRequest(notes.map((entry) => entry === note ? thread : entry));
				const setChildIntent = (childCreated: true | undefined) => {
					controller.signal.throwIfAborted();
					commitRequest(notes.map((entry) => entry.status === "thread" && entry.turns === turns ? { ...entry, childCreated } : entry));
				};
				const publication = { recordIntent: () => setChildIntent(true), clearUnpublishedIntent: () => setChildIntent(undefined) };
				const prompt = { original: `${note.anchor.quote}\n\n${note.text}`, reply: first ? undefined : text };
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

	return {
		request,
		async close() {
			controller.abort();
			try {
				interrupt();
			} catch (error) {
				reportPersistenceError(error);
			} finally {
				await Promise.allSettled(jobs);
				lock.close();
			}
		},
	};
}
