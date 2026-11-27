import assert from "node:assert/strict";
import test from "node:test";
import {
	applyUpdate,
	branchNotes,
	composerDraftKey,
	connectionFrom,
	deliverRequest,
	deliverableNotes,
	encodeComposerDraft,
	hasRunningTurn,
	notePhase,
	offBranchCount,
	parseComposerDraft,
	parseReplyDraft,
	parseReview,
	parseSnapshot,
	parseUpdate,
	replyDraftKey,
	replyRequest,
	saveRequest,
	startRequest,
} from "../../herdr-mod/model.js";

const snapshotItem = (id, text, kind = "assistant", label = "Assistant") => ({ id, kind, label, text });
const anchor = (itemId, start, end, quote) => ({ itemId, start, end, quote });
const note = (id, itemId, status, extra = {}) => ({ id, anchor: anchor(itemId, 0, 4, "text"), text: `note ${id}`, status, ...(status === "pending" ? { version: `version of ${id}` } : {}), ...extra });

test("connection files are bound to the tab's Pi session", () => {
	const raw = JSON.stringify({ sessionId: "session-a", port: 4747, token: "secret" });
	assert.deepEqual(connectionFrom(raw, "session-a"), { sessionId: "session-a", port: 4747, token: "secret" });
	assert.throws(() => connectionFrom(raw, "session-b"), /different Pi session/);
	assert.throws(() => connectionFrom(JSON.stringify({ sessionId: "session-a", port: 0, token: "secret" }), "session-a"), /loopback port/);
	assert.throws(() => connectionFrom(JSON.stringify({ sessionId: "session-a", port: 4747, token: "" }), "session-a"), /access token/);
	assert.throws(() => connectionFrom(null, "session-a"), /No annotation connection/);
});

test("snapshot updates append only new items and resets replace the branch", () => {
	const snapshot = parseSnapshot({ sessionId: "s", version: 4, nextSeq: 2, items: [snapshotItem("a", "A"), snapshotItem("b", "B")] }, "s");
	assert.deepEqual(snapshot, { version: 4, items: [snapshotItem("a", "A"), snapshotItem("b", "B")] });
	const appended = applyUpdate(snapshot, parseUpdate({ version: 5, reset: false, items: [snapshotItem("c", "C")] }));
	assert.deepEqual(appended, { version: 5, items: [snapshotItem("a", "A"), snapshotItem("b", "B"), snapshotItem("c", "C")] });
	const reset = applyUpdate(appended, parseUpdate({ version: 6, reset: true, items: [snapshotItem("z", "Z")] }));
	assert.deepEqual(reset, { version: 6, items: [snapshotItem("z", "Z")] });
	assert.throws(() => applyUpdate(reset, parseUpdate({ version: 5, reset: false, items: [] })), /older/);
});

test("branch notes follow transcript order and the delivery batch only carries pending notes", () => {
	const items = [snapshotItem("b", "text B"), snapshotItem("a", "text A")];
	const notes = [
		note("a-pending", "a", "pending"),
		note("b-thread", "b", "thread", { turns: [{ id: "t1", text: "ask", status: "completed", reply: "ok" }] }),
		note("b-pending", "b", "pending"),
		note("old", "off-branch", "pending"),
	];
	assert.deepEqual(branchNotes(notes, items).map((value) => value.id), ["b-thread", "b-pending", "a-pending"]);
	assert.equal(offBranchCount(notes, items), 1);
	assert.deepEqual(deliverableNotes(notes, items).map((value) => value.id), ["b-pending", "a-pending"]);
});

test("note phases expose every turn outcome", () => {
	assert.equal(notePhase(note("p", "a", "pending")), "pending");
	assert.equal(notePhase(note("a", "a", "appended")), "appended");
	assert.equal(notePhase(note("r", "a", "thread", { turns: [{ id: "1", text: "ask", status: "running" }] })), "running");
	assert.equal(notePhase(note("c", "a", "thread", { turns: [{ id: "1", text: "ask", status: "completed", reply: "ok" }] })), "completed");
	assert.equal(notePhase(note("f", "a", "thread", { turns: [{ id: "1", text: "ask", status: "failed", error: "no" }] })), "failed");
	assert.equal(notePhase(note("i", "a", "thread", { turns: [{ id: "1", text: "ask", status: "interrupted", error: "stopped" }] })), "interrupted");
	assert.equal(hasRunningTurn(note("r", "a", "thread", { turns: [{ id: "1", text: "ask", status: "running" }] })), true);
	assert.equal(hasRunningTurn(note("c", "a", "thread", { turns: [{ id: "1", text: "ask", status: "completed", reply: "ok" }] })), false);
});

test("review payloads preserve the native anchor and reject blank input", () => {
	const selected = anchor("item-1", 3, 9, "quote");
	const createId = "316e05f4-6e3f-4e18-83b4-3e839e23a7a4";
	assert.deepEqual(saveRequest(selected, "why", { createId }), { action: "save", createId, anchor: selected, text: "why" });
	assert.deepEqual(saveRequest(selected, "why", { noteId: "note-1", expectedText: "before" }), {
		action: "save", noteId: "note-1", expectedText: "before", anchor: selected, text: "why",
	});
	assert.equal(saveRequest(selected, "   ", { createId }), null);
	assert.equal(saveRequest(anchor("item-1", 9, 3, "quote"), "why", { createId }), null);
	assert.deepEqual(startRequest("note-1"), { action: "start", noteId: "note-1" });
	const requestId = "082f1c3b-7cc2-41e9-a18e-1a72d868226c";
	assert.deepEqual(replyRequest("note-1", "more", requestId), { action: "reply", noteId: "note-1", text: "more", requestId });
	assert.equal(replyRequest("note-1", "\n", requestId), null);
	assert.deepEqual(deliverRequest(["b", "a", "b"]), { action: "deliver", noteIds: ["b", "a"] });
	assert.equal(deliverRequest([]), null);
});

test("review parsing keeps stable ids and rejects invalid turn data", () => {
	const review = parseReview({
		notes: [
			note("p", "a", "pending"),
			note("t", "a", "thread", { turns: [{ id: "turn-1", text: "ask", status: "interrupted", error: "parent stopped" }] }),
		],
	});
	assert.equal(review.notes[1].turns[0].error, "parent stopped");
	assert.throws(() => parseReview({ notes: [note("t", "a", "thread", { turns: [{ id: "turn-1", text: "ask", status: "completed" }] })] }), /invalid/);
	assert.throws(() => parseReview({ notes: [note("same", "a", "pending"), note("same", "a", "pending")] }), /repeats/);
});

test("composer and reply drafts recover per source", () => {
	assert.equal(composerDraftKey("s1"), "pi-annotate.composer:s1");
	assert.equal(replyDraftKey("s1", "n1"), "pi-annotate.reply:s1:n1");
	const selected = anchor("item-1", 0, 4, "text");
	const edit = { noteId: "n1", anchor: selected, text: "draft", expectedText: "original" };
	const create = { noteId: null, anchor: selected, text: "draft", createId: "316e05f4-6e3f-4e18-83b4-3e839e23a7a4", createText: "first attempt" };
	assert.deepEqual(parseComposerDraft(encodeComposerDraft(edit)), edit);
	assert.deepEqual(parseComposerDraft(encodeComposerDraft(create)), create);
	assert.equal(parseComposerDraft("{"), null);
	assert.equal(parseComposerDraft(JSON.stringify({ anchor: anchor("x", 4, 2, "q"), text: "draft" })), null);
	assert.equal(parseReplyDraft("kept"), "kept");
	assert.equal(parseReplyDraft(null), "");
});
