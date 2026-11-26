const ITEM_KINDS = new Set(["user", "assistant", "tool"]);
const NOTE_STATUSES = new Set(["pending", "sent", "appended", "thread"]);
const TURN_STATUSES = new Set(["running", "completed", "failed", "interrupted"]);

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function connectionFrom(raw, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") throw new Error("This tab has no Pi session. Reopen it from Pi with /annotate-herdr.");
	if (typeof raw !== "string") throw new Error("No annotation connection was published for this Pi session. Run /annotate-herdr in Pi.");
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error("The annotation connection file is not valid JSON. Run /annotate-herdr again.");
	}
	if (!isObject(value) || value.sessionId !== sessionId) throw new Error("This connection belongs to a different Pi session. Reopen the tab from its Pi session.");
	if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("The annotation connection has an invalid loopback port.");
	if (typeof value.token !== "string" || value.token === "") throw new Error("The annotation connection has no access token.");
	return { sessionId, port: value.port, token: value.token };
}

function isAnchor(value) {
	return isObject(value)
		&& typeof value.itemId === "string" && value.itemId !== ""
		&& Number.isInteger(value.start) && Number.isInteger(value.end)
		&& value.start >= 0 && value.end > value.start
		&& typeof value.quote === "string" && value.quote.trim() !== ""
		&& (value.sourceText === undefined || typeof value.sourceText === "string" && value.sourceText.length === value.end - value.start);
}

function copyAnchor(anchor) {
	return { itemId: anchor.itemId, start: anchor.start, end: anchor.end, quote: anchor.quote, ...(anchor.sourceText === undefined ? {} : { sourceText: anchor.sourceText }) };
}

function isItem(value) {
	return isObject(value)
		&& typeof value.id === "string" && value.id !== ""
		&& ITEM_KINDS.has(value.kind)
		&& typeof value.label === "string"
		&& typeof value.text === "string";
}

function copyItem(item) {
	return { id: item.id, kind: item.kind, label: item.label, text: item.text };
}

function uniqueIds(values) {
	return new Set(values).size === values.length;
}

export function parseSnapshot(value, sessionId) {
	if (!isObject(value) || value.sessionId !== sessionId) throw new Error("The Pi snapshot belongs to a different session.");
	if (!Number.isInteger(value.version) || value.version < 0) throw new Error("The Pi snapshot has no valid version.");
	if (!Array.isArray(value.items) || !value.items.every(isItem)) throw new Error("The Pi snapshot has invalid transcript items.");
	if (!uniqueIds(value.items.map((item) => item.id))) throw new Error("The Pi snapshot repeats a transcript item id.");
	return { version: value.version, items: value.items.map(copyItem) };
}

export function parseUpdate(value) {
	if (!isObject(value)) throw new Error("The Pi transcript update is invalid.");
	if (!Number.isInteger(value.version) || value.version < 0) throw new Error("The Pi transcript update has no valid version.");
	if (typeof value.reset !== "boolean" || !Array.isArray(value.items) || !value.items.every(isItem)) throw new Error("The Pi transcript update has invalid items.");
	if (!uniqueIds(value.items.map((item) => item.id))) throw new Error("The Pi transcript update repeats an item id.");
	return { version: value.version, reset: value.reset, items: value.items.map(copyItem) };
}

export function applyUpdate(current, update) {
	if (update.version < current.version) throw new Error("The Pi transcript update is older than the current view.");
	return {
		version: update.version,
		items: update.reset ? update.items : [...current.items, ...update.items],
	};
}

function isTurn(value) {
	if (!isObject(value)) return false;
	if (typeof value.id !== "string" || value.id === "" || typeof value.text !== "string") return false;
	if (!TURN_STATUSES.has(value.status)) return false;
	if (value.status === "completed") return typeof value.reply === "string";
	if (value.status === "failed" || value.status === "interrupted") return typeof value.error === "string";
	return true;
}

function copyTurn(turn) {
	const base = { id: turn.id, text: turn.text, status: turn.status };
	if (turn.status === "completed") return { ...base, reply: turn.reply };
	if (turn.status === "failed" || turn.status === "interrupted") return { ...base, error: turn.error };
	return base;
}

function isNote(value) {
	if (!isObject(value) || typeof value.id !== "string" || value.id === "" || typeof value.text !== "string") return false;
	if (value.anchor !== null && !isAnchor(value.anchor)) return false;
	if (!NOTE_STATUSES.has(value.status)) return false;
	if (value.status === "pending") return typeof value.version === "string";
	if (value.status !== "thread") return true;
	if (!Array.isArray(value.turns) || !value.turns.every(isTurn)) return false;
	return uniqueIds(value.turns.map((turn) => turn.id));
}

function copyNote(note) {
	const base = { id: note.id, anchor: note.anchor === null ? null : copyAnchor(note.anchor), text: note.text };
	if (note.status === "pending") return { ...base, status: "pending", version: note.version };
	if (note.status !== "thread") return { ...base, status: note.status };
	return { ...base, status: "thread", turns: note.turns.map(copyTurn) };
}

export function parseReview(value) {
	if (!isObject(value) || !Array.isArray(value.notes) || !value.notes.every(isNote)) throw new Error("The Pi review state is invalid.");
	if (!uniqueIds(value.notes.map((note) => note.id))) throw new Error("The Pi review state repeats a note id.");
	return { notes: value.notes.map(copyNote) };
}

export function branchNotes(notes, items) {
	const order = new Map(items.map((item, index) => [item.id, index]));
	return notes
		.filter((note) => note.anchor === null || order.has(note.anchor.itemId))
		.sort((left, right) => {
			if (left.anchor === null || right.anchor === null) {
				if (left.anchor === null && right.anchor === null) return 0;
				return left.anchor === null ? 1 : -1;
			}
			const itemOrder = order.get(left.anchor.itemId) - order.get(right.anchor.itemId);
			return itemOrder || left.anchor.start - right.anchor.start || left.anchor.end - right.anchor.end;
		});
}

export function offBranchCount(notes, items) {
	const ids = new Set(items.map((item) => item.id));
	return notes.filter((note) => note.anchor !== null && !ids.has(note.anchor.itemId)).length;
}

export function panelNotes(notes, items, panel) {
	const visible = branchNotes(notes, items);
	return panel === "background"
		? visible.filter((note) => note.status === "thread")
		: visible.filter((note) => note.status !== "thread");
}

export function deliverableNotes(notes, items) {
	const textById = new Map(items.map((item) => [item.id, item.text]));
	return branchNotes(notes, items).filter((note) => {
		const anchor = note.anchor;
		if (note.status !== "pending") return false;
		if (!anchor) return true;
		const text = textById.get(anchor.itemId);
		return anchor.end <= text.length && text.slice(anchor.start, anchor.end) === (anchor.sourceText ?? anchor.quote);
	});
}

export function hasRunningTurn(note) {
	return note.status === "thread" && note.turns.some((turn) => turn.status === "running");
}

export function completedTurns(note) {
	return note.status === "thread" ? note.turns.filter((turn) => turn.status === "completed").length : 0;
}

export function notePhase(note) {
	if (note.status !== "thread") return note.status;
	if (hasRunningTurn(note)) return "running";
	const last = note.turns.at(-1);
	return last ? last.status : "thread";
}

export function saveRequest(anchor, text, { noteId, expectedText, createId }) {
	if (text.trim() === "" || (!(noteId && anchor === null) && !isAnchor(anchor))) return null;
	return {
		action: "save",
		...(noteId ? { noteId, expectedText } : { createId }),
		anchor: anchor === null ? null : copyAnchor(anchor),
		text,
	};
}

export function deliverRequest(noteIds) {
	const ids = [...new Set(noteIds)];
	return ids.length === 0 ? null : { action: "deliver", noteIds: ids };
}

export function sendRequest(versions, text, requestId) {
	if (versions.size === 0 && text.trim() === "") return null;
	return { action: "send", requestId, noteIds: [...versions.keys()], noteVersions: [...versions.values()], text };
}

export function startRequest(noteId) {
	return { action: "start", noteId };
}

export function startCreateRequest(createId, text) {
	if (text.trim() === "") return null;
	return { action: "start", createId, text };
}

export function replyRequest(noteId, text, requestId) {
	if (text.trim() === "") return null;
	return { action: "reply", noteId, text, requestId };
}

export function copyRequest(noteId, createId) {
	return { action: "copy", noteId, createId };
}

export function deleteRequest(noteId) {
	return { action: "delete", noteId };
}

export function composerDraftKey(sessionId) {
	return `pi-annotate.composer:${sessionId}`;
}

export function mainDraftKey(sessionId) {
	return `pi-annotate.main:${sessionId}`;
}

export function replyDraftKey(sessionId, noteId) {
	return `pi-annotate.reply:${sessionId}:${noteId}`;
}

export function replyAttemptKey(sessionId, noteId) {
	return `${replyDraftKey(sessionId, noteId)}:attempt`;
}

export function startAttemptKey(sessionId) {
	return `pi-annotate.start:${sessionId}`;
}

export function sendAttemptKey(sessionId) {
	return `pi-annotate.send:${sessionId}`;
}

export function copyAttemptKey(sessionId, noteId) {
	return `pi-annotate.copy:${sessionId}:${noteId}`;
}

export function isUuid(value) {
	return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
}

export function parseReplyAttempt(raw, noteId) {
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isObject(body) || body.action !== "reply" || body.noteId !== noteId || typeof body.text !== "string") return null;
	if (!isUuid(body.requestId)) return null;
	return replyRequest(noteId, body.text, body.requestId);
}

export function parseStartAttempt(raw) {
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isObject(body) || typeof body.text !== "string") return null;
	if (!isUuid(body.createId)) return null;
	return startCreateRequest(body.createId, body.text);
}

export function parseSendAttempt(raw) {
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isObject(body) || !isUuid(body.requestId)) return null;
	if (body.action === "check-send") return { action: body.action, requestId: body.requestId };
	if (body.action !== "send" || typeof body.text !== "string") return null;
	if (!Array.isArray(body.noteIds) || !body.noteIds.every((id) => typeof id === "string")) return null;
	if (new Set(body.noteIds).size !== body.noteIds.length) return null;
	if (body.noteIds.length === 0 && body.text.trim() === "") return null;
	if (body.noteVersions !== undefined && (!Array.isArray(body.noteVersions) || body.noteVersions.length !== body.noteIds.length || !body.noteVersions.every((version) => typeof version === "string"))) return null;
	return body;
}

export function encodeComposerDraft(draft) {
	return JSON.stringify({
		noteId: draft.noteId ?? null,
		anchor: draft.anchor === null ? null : copyAnchor(draft.anchor),
		text: draft.text,
		...(draft.noteId ? { expectedText: draft.expectedText } : { createId: draft.createId, createText: draft.createText }),
	});
}

export function parseComposerDraft(raw) {
	if (typeof raw !== "string" || raw === "") return null;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isObject(value) || typeof value.text !== "string") return null;
	if (!(value.noteId && value.anchor === null) && !isAnchor(value.anchor)) return null;
	if (value.noteId !== null && value.noteId !== undefined && (typeof value.noteId !== "string" || value.noteId === "")) return null;
	return {
		noteId: value.noteId ?? null,
		anchor: value.anchor === null ? null : copyAnchor(value.anchor),
		text: value.text,
		...(value.noteId
			? { expectedText: typeof value.expectedText === "string" ? value.expectedText : undefined }
			: { createId: value.createId, createText: value.createText }),
	};
}

export function parseReplyDraft(raw) {
	return typeof raw === "string" ? raw : "";
}
