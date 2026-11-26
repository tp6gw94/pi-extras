import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as client from "../../herdr-mod/client.js";
import * as model from "../../herdr-mod/model.js";

const source = (await readFile(new URL("../../herdr-mod/main.js", import.meta.url), "utf8"))
	.replace(/^import (\{[^}]+\}) from ("[^"]+");/gm, "const $1 = modules[$2];")
	.replace("export default class", "class");
const sessionId = "source";
const anchor = { itemId: "item", start: 0, end: 5, quote: "Quote" };
const pending = (id, text) => ({ id, status: "pending", anchor, text });
const thread = { id: "thread", status: "thread", anchor, text: "Existing comment", turns: [] };
const response = (body, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });

function element(id) {
	const node = { elementId: id, nodes: [], handlers: {}, highlights: [], position: {} };
	const proxy = new Proxy(node, {
		get(target, key) {
			if (key === "id") return (value) => { node.elementId = value; return proxy; };
			if (key === "child" || key === "content") return (child) => { node.nodes.push(child); return proxy; };
			if (key === "children") return (children) => { node.nodes.push(...children); return proxy; };
			if (key === "when") return (condition, apply) => condition ? apply(proxy) : proxy;
			if (key === "highlight_range") return (start, end, color) => { node.highlights.push({ start, end, color }); return proxy; };
			if (key === "selectable") return (value) => { node.selectableState = value; return proxy; };
			if (key.startsWith("on_")) return (...args) => { node.handlers[key] = args.at(-1); return proxy; };
			if (key === "left" || key === "top") return (position) => { node.position[key] = position; return proxy; };
			return key in target ? target[key] : () => proxy;
		},
	});
	return proxy;
}

function flatten(node) {
	return typeof node === "object" ? [node, ...node.nodes.flatMap(flatten)] : [node];
}

async function open(t, notes = [], nextReview, drafts = new Map(), setValueEmitsChange = false, transcript = {}) {
	let port = 1234;
	const oldEvents = Promise.withResolvers();
	const updates = Array.from({ length: transcript.updates ?? 0 }, () => Promise.withResolvers());
	let updateIndex = 0;
	let eventIndex = 0;
	const posts = [];
	const inputs = new Map();
	const overlays = new Map();
	let overlayId = 0;
	let currentProps = { sessionId, connectionFile: "connection.json" };
	let activeTab = "source-tab";
	let focusedInput;
	let pollReview;
	const idle = new Promise(() => {});
	const cx = {
		notify() {},
		stop_propagation() {},
		spawn(run) { void run(cx); return { cancel() {} }; },
		sleep: () => idle,
		timer: { every(_interval, run) {
			pollReview = () => run(cx);
			return { cancel() {} };
		} },
	};
	const fetch = async (url, init) => {
		const address = new URL(url);
		const target = Number(address.port);
		const route = address.pathname.split("/").at(-1);
		if (route === "events") {
			if (transcript.updates === undefined) return target === 1234 ? oldEvents.promise : idle;
			const update = updates[updateIndex];
			if (!update) return idle;
			updateIndex += 1;
			return update.promise;
		}
		assert.equal(target, port);
		assert.equal(init.headers["x-annotate-token"], `token-${port}`);
		if (route === "snapshot") {
			const items = transcript.items ?? [
				{ id: "item", kind: "user", label: "You", text: `Quote from port ${target}` },
			];
			return response({ sessionId, version: 1, items });
		}
		if (init.method === "GET") {
			const result = nextReview ?? response({ notes });
			nextReview = undefined;
			return result;
		}
		const post = { ...Promise.withResolvers(), body: JSON.parse(init.body) };
		posts.push(post);
		const result = await post.promise;
		if (result.ok && target === port) notes = JSON.parse(await result.text()).notes;
		return result;
	};
	const modules = {
		crypto: { randomUUID },
		"gpui-kit": { View: class {}, div: () => element() },
		"gpui-base": {
			h_flex: () => element(), v_flex: () => element(), Button: { new: element }, Popup: { new: element },
			TextView: { markdown: (id, text) => element(id).child(text) },
			Textarea: { new: () => element() },
			TextareaState: { new({ placeholder, value = "" }) {
				const handlers = {};
				let selection;
				const state = { on: (name, handler) => { handlers[name] = handler; }, value: () => value,
					selected_range: () => selection ?? { start: value.length, end: value.length },
					set_value(text) { value = text; if (setValueEmitsChange) handlers.change({}, cx); },
					focus() { focusedInput = placeholder; }, blur() { focusedInput = undefined; }, release() {} };
				const edit = (text) => { value = text; handlers.change({}, cx); };
				inputs.set(placeholder, { edit, value: state.value, submit(event, insertedText = "", range) {
					if (insertedText) {
						const { start, end } = range ?? state.selected_range();
						const caret = start + insertedText.length;
						selection = { start: caret, end: caret };
						edit(value.slice(0, start) + insertedText + value.slice(end));
					}
					handlers.submit(event, cx);
					selection = undefined;
				} });
				return state;
			} },
		},
		herdr: {
			checking: () => false, window: () => ({ visible: true }), theme: () => ({}),
			props: () => currentProps,
			focused: () => ({ tab: activeTab }),
			settings: () => ({ zoom: 2 }),
			openOverlay(spec) {
				const id = `overlay-${++overlayId}`;
				const popup = new View();
				const previousProps = currentProps;
				currentProps = { ...spec.props, overlay: id };
				popup.init(currentProps, cx);
				currentProps = previousProps;
				overlays.set(id, { spec, popup });
				return id;
			},
			closeOverlay(id) {
				const overlay = overlays.get(id);
				overlays.delete(id);
				overlay?.popup.close();
			},
			readTextFile: async () => JSON.stringify({ sessionId, port, token: `token-${port}` }),
		},
		"./model.js": model,
		"./client.js": Object.fromEntries(["fetchEvents", "fetchReview", "fetchSnapshot", "postReview"]
			.map((name) => [name, (connection, arg) => name === "fetchEvents" || name === "postReview"
				? client[name](connection, arg, fetch) : client[name](connection, fetch)])),
	};
	const localStorage = { getItem: (key) => drafts.get(key) ?? null, setItem: (key, value) => drafts.set(key, value),
		removeItem: (key) => drafts.delete(key), flush: () => transcript.flush?.() ?? Promise.resolve() };
	const View = runInNewContext(`${source}\nPiAnnotate`, { modules, localStorage });
	const view = new View();
	t.after(() => view.close());
	view.init({}, cx);
	const tree = () => flatten(view.render(cx));
	const node = (id) => tree().find((child) => child.elementId === id);
	const click = (id) => node(id).handlers.on_click({}, cx);
	const popup = () => [...overlays.values()].at(-1);
	const commentInput = () => inputs.get("Write a comment on the selected text");
	const replyInput = () => inputs.get("Reply to the background Pi thread");
	await setImmediate();
	return {
		click, drafts, posts, node, text: () => tree().filter((child) => typeof child === "string").join("\n"),
		popup: () => popup()?.spec,
		popupClick: (id) => flatten(popup().popup.render(cx)).find((child) => child.elementId === id).handlers.on_click({}, cx),
		dismissPopup: () => modules.herdr.closeOverlay([...overlays.keys()].at(-1)),
		elementEvent: (id, name, event) => node(id).handlers[name](event, cx),
		focusedInput: () => focusedInput,
		selectTab: (id) => { activeTab = id; },
		commentInput, replyInput,
		editComment: (text) => commentInput().edit(text),
		editReply: (text) => replyInput().edit(text),
		event: (update) => updates[eventIndex++].resolve(response(update)),
		select: (id, selection) => node(id).handlers.on_selection_change(selection, cx),
		transcriptViewport() {
			const onSizeChange = node("pi-transcript-scroll").handlers.on_size_change;
			return (size) => onSizeChange?.(size, cx);
		},
		addComment() {
			node("pi-markdown-item").handlers.on_selection_change({ text: anchor.quote, range: { start: 0, end: 5 } }, cx);
			click("pi-add-comment");
		},
		pollReview: () => pollReview(),
		restart(currentNotes = notes, firstReview) {
			port = 2345;
			notes = currentNotes;
			nextReview = firstReview;
			oldEvents.reject(new Error("Connection refused"));
		},
	};
}

test("a note shows its quote and comment once when collapsed, expanded, and collapsed again", async (t) => {
	const note = pending("preview", "A comment on the quote");
	const app = await open(t, [note]);
	const assertNoteText = (state, expanded) => {
		const card = flatten(app.node("pi-note-card-preview"));
		assert.equal(card.includes("Edit comment"), expanded, `${state} body visibility`);
		assert.deepEqual({
			quote: card.filter((text) => text === note.anchor.quote).length,
			comment: card.filter((text) => text === note.text).length,
		}, { quote: 1, comment: 1 }, `${state} text counts`);
	};

	assertNoteText("collapsed", false);
	app.click("pi-note-preview");
	assertNoteText("expanded", true);
	app.click("pi-note-preview");
	assertNoteText("re-collapsed", false);
});

for (const status of [200, 409, 0]) {
	test(`reconnect refreshes current notes after the old save settles (${status})`, async (t) => {
		const app = await open(t);
		app.addComment();
		app.editComment("Keep this draft");
		app.click("pi-save-comment");
		const saved = pending("saved", "Keep this draft");
		const current = pending("current", "Current review");
		app.restart(status === 200 ? [saved, current] : [current]);
		await setImmediate();
		assert.match(app.text(), /Could not reach.*1234/);
		app.click("pi-reconnect");
		await setImmediate();
		assert.match(app.text(), /Quote from port 2345/);
		assert.equal(app.node("pi-save-comment").handlers.on_click, undefined);
		if (status === 0) app.posts[0].reject(new Error("Native fetch timed out"));
		else {
			const result = status === 200
				? { notes: [saved, pending("old", "Stale review")], noteId: saved.id }
				: { error: "Old server rejected this save" };
			app.posts[0].resolve(response(result, status));
		}
		await setImmediate();
		const key = model.composerDraftKey(sessionId);
		if (status === 200) {
			assert.equal(app.drafts.has(key), false);
			assert.equal(app.node("pi-save-comment"), undefined);
			assert.ok(app.node("pi-note-saved"));
		} else {
			assert.equal(JSON.parse(app.drafts.get(key)).text, "Keep this draft");
			assert.ok(app.node("pi-save-comment").handlers.on_click);
		}
		assert.ok(app.node("pi-note-current"));
		assert.equal(app.node("pi-note-old"), undefined);
		assert.doesNotMatch(app.text(), /Old server rejected this save/);
		assert.equal(app.posts.length, 1);
	});
}

test("reconnect keeps stale note actions disabled until the new review succeeds", async (t) => {
	const note = pending("note", "Old comment");
	const app = await open(t, [note, thread]);
	app.click("pi-note-note");
	const firstReview = Promise.withResolvers();
	app.restart([pending(note.id, "Updated comment"), thread], firstReview.promise);
	await setImmediate();
	app.click("pi-reconnect");
	await setImmediate();
	assert.match(app.text(), /Quote from port 2345/);
	const actions = ["pi-deliver", "pi-start-note", "pi-edit-note", "pi-delete-note"];
	for (const id of actions) assert.equal(app.node(id).handlers.on_click, undefined, id);
	firstReview.resolve(response({ error: "Review unavailable" }, 503));
	await setImmediate();
	assert.match(app.text(), /Review unavailable/);
	for (const id of actions) assert.equal(app.node(id).handlers.on_click, undefined, id);
	app.click("pi-note-thread");
	app.editReply("Draft reply");
	assert.equal(app.node("pi-reply-thread").handlers.on_click, undefined);
	app.replyInput().submit({ secondary: true, shift: false }, "\n");
	assert.deepEqual(app.posts, []);
	app.pollReview();
	await setImmediate();
	assert.match(app.text(), /Updated comment/);
	assert.ok(app.node("pi-reply-thread").handlers.on_click);
	app.click("pi-note-note");
	for (const id of actions) assert.ok(app.node(id).handlers.on_click, id);
});

test("editing before the initial review loads updates the new note, not an older identical note", async (t) => {
	const older = pending("older", "Original draft");
	const initialReview = Promise.withResolvers();
	const app = await open(t, [older], initialReview.promise);
	app.addComment();
	app.editComment("Original draft");
	app.click("pi-save-comment");
	app.editComment("Newer draft");
	assert.equal(app.node("pi-save-comment").handlers.on_click, undefined);
	const original = pending("first", "Original draft");
	app.posts[0].resolve(response({ notes: [older, original], noteId: original.id }));
	initialReview.resolve(response({ notes: [older] }));
	await setImmediate();
	const key = model.composerDraftKey(sessionId);
	assert.deepEqual(JSON.parse(app.drafts.get(key)), { noteId: original.id, anchor, text: "Newer draft", expectedText: "Original draft" });
	app.click("pi-save-comment");
	const update = app.posts[1];
	assert.deepEqual(update.body, { action: "save", anchor, noteId: original.id, expectedText: "Original draft", text: "Newer draft" });
	app.editComment("Final draft");
	update.resolve(response({ notes: [older, pending(original.id, "Newer draft")], noteId: original.id }));
	await setImmediate();
	app.click("pi-save-comment");
	assert.deepEqual(app.posts[2].body, { action: "save", anchor, noteId: original.id, expectedText: "Newer draft", text: "Final draft" });
	app.posts[2].resolve(response({ notes: [older, pending(original.id, "Final draft")], noteId: original.id }));
	await setImmediate();
	assert.equal(app.drafts.has(key), false);
	assert.equal(app.node("pi-save-comment"), undefined);
	assert.match(app.text(), /2 on this branch/);
	assert.match(app.text(), /Final draft/);
	assert.match(app.text(), /Original draft/);
});

for (const timing of ["before saving", "while saving"]) {
	test(`an unchanged saved comment closes without removing another view's draft written ${timing}`, async (t) => {
		const app = await open(t);
		app.addComment();
		app.editComment("Original draft");
		if (timing === "while saving") app.click("pi-save-comment");
		const other = await open(t, [], undefined, app.drafts);
		other.editComment("Draft from another view");
		const key = model.composerDraftKey(sessionId);
		const replacement = app.drafts.get(key);
		if (timing === "before saving") app.click("pi-save-comment");
		app.posts[0].resolve(response({ notes: [pending("saved", "Original draft")], noteId: "saved" }));
		await setImmediate();
		assert.equal(app.drafts.get(key), replacement);
		assert.equal(app.node("pi-save-comment"), undefined);
		assert.ok(app.node("pi-note-saved"));
	});
}

test("an edited comment updates its acknowledged note without replacing another view's draft", async (t) => {
	const app = await open(t);
	app.addComment();
	app.editComment("Original draft");
	app.click("pi-save-comment");
	app.editComment("Edited while saving");
	const other = await open(t, [], undefined, app.drafts);
	other.editComment("Draft from another view");
	const key = model.composerDraftKey(sessionId);
	const replacement = app.drafts.get(key);
	app.posts[0].resolve(response({ notes: [pending("saved", "Original draft")], noteId: "saved" }));
	await setImmediate();
	assert.equal(app.drafts.get(key), replacement);
	app.click("pi-save-comment");
	const update = app.posts[1];
	assert.equal(update.body.noteId, "saved");
	assert.equal(update.body.text, "Edited while saving");
	update.resolve(response({ notes: [pending("saved", update.body.text)], noteId: "saved" }));
	await setImmediate();
	assert.equal(app.drafts.get(key), replacement);
	assert.equal(app.node("pi-save-comment"), undefined);
	assert.match(app.text(), /1 on this branch/);
});

test("cancel closes this composer without removing another view's draft", async (t) => {
	const app = await open(t);
	app.addComment();
	app.editComment("Original draft");
	const other = await open(t, [], undefined, app.drafts);
	other.editComment("Draft from another view");
	const key = model.composerDraftKey(sessionId);
	const replacement = app.drafts.get(key);
	app.click("pi-cancel-comment");
	assert.equal(app.node("pi-save-comment"), undefined);
	assert.equal(app.drafts.get(key), replacement);
});

test("a failed save is visible after editing the same draft", async (t) => {
	const app = await open(t);
	app.addComment();
	app.editComment("Original draft");
	app.click("pi-save-comment");
	app.editComment("Newer draft");
	app.posts[0].resolve(response({ error: "Save rejected" }, 409));
	await setImmediate();
	assert.match(app.text(), /Save rejected/);
	assert.ok(app.node("pi-save-comment").handlers.on_click);
	assert.equal(JSON.parse(app.drafts.get(model.composerDraftKey(sessionId))).text, "Newer draft");
});

for (const status of [200, 409]) {
	test(`a canceled save does not affect a replacement draft with identical text (${status})`, async (t) => {
		const app = await open(t);
		app.addComment();
		app.editComment("Same draft text");
		app.click("pi-save-comment");
		app.click("pi-cancel-comment");
		app.addComment();
		app.editComment("Same draft text");
		const result = status === 200 ? { notes: [pending("first", "Same draft text")], noteId: "first" } : { error: "Canceled save rejected" };
		app.posts[0].resolve(response(result, status));
		await setImmediate();
		const draft = JSON.parse(app.drafts.get(model.composerDraftKey(sessionId)));
		assert.equal(draft.text, "Same draft text");
		assert.notEqual(draft.createId, app.posts[0].body.createId);
		assert.doesNotMatch(app.text(), /Canceled save rejected/);
		app.click("pi-save-comment");
		assert.equal(app.posts[1].body.createId, draft.createId);
	});
}

test("a stale restored edit is rejected without overwriting the saved note or discarding the draft", async (t) => {
	const original = pending("note", "Original comment");
	const newer = pending(original.id, "Saved by another view");
	const first = await open(t, [original]);
	first.click("pi-note-note");
	first.click("pi-edit-note");
	first.editComment("My local edit");
	const restored = await open(t, [newer], undefined, first.drafts);
	restored.click("pi-save-comment");
	const { body, resolve } = restored.posts[0];
	assert.deepEqual(body, { action: "save", noteId: original.id, expectedText: original.text, anchor, text: "My local edit" });
	resolve(body.expectedText === newer.text
		? response({ notes: [pending(newer.id, body.text)], noteId: newer.id })
		: response({ error: "This comment was changed by another view." }, 409));
	await setImmediate();
	assert.match(restored.text(), /This comment was changed by another view/);
	assert.match(restored.text(), /Saved by another view/);
	assert.equal(JSON.parse(restored.drafts.get(model.composerDraftKey(sessionId))).text, "My local edit");
	assert.ok(restored.node("pi-save-comment").handlers.on_click);
});

test("a legacy edit draft without original text is kept but cannot overwrite a saved note", async (t) => {
	const key = model.composerDraftKey(sessionId);
	const draft = JSON.stringify({ noteId: "note", anchor, text: "Legacy draft" });
	const app = await open(t, [pending("note", "Current saved text")], undefined, new Map([[key, draft]]));
	assert.match(app.text(), /This draft has no original comment text/);
	assert.equal(app.node("pi-save-comment").handlers.on_click, undefined);
	assert.equal(app.drafts.get(key), draft);
});

test("a committed create with a lost response is deduplicated after reconnect and draft restore", async (t) => {
	const first = await open(t);
	first.addComment();
	first.editComment("Original draft");
	first.click("pi-save-comment");
	const initial = first.posts[0];
	assert.match(initial.body.createId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
	assert.deepEqual(initial.body, { action: "save", createId: initial.body.createId, anchor, text: "Original draft" });
	const committed = new Map();
	const create = (body) => {
		if (!committed.has(body.createId)) committed.set(body.createId, pending(`note-${committed.size + 1}`, body.text));
		return { notes: [...committed.values()], noteId: committed.get(body.createId).id };
	};
	const saved = create(initial.body);
	initial.reject(new Error("Native fetch timed out"));
	await setImmediate();
	assert.match(first.text(), /Could not reach.*1234/);
	first.editComment("Newer draft");
	first.restart(saved.notes);
	await setImmediate();
	first.click("pi-reconnect");
	await setImmediate();
	first.click("pi-save-comment");
	assert.deepEqual(first.posts[1].body, initial.body);
	first.posts[1].reject(new Error("Native fetch timed out"));
	await setImmediate();
	const restored = await open(t, saved.notes, undefined, first.drafts);
	restored.click("pi-save-comment");
	const retry = restored.posts[0];
	assert.deepEqual(retry.body, initial.body);
	retry.resolve(response(create(retry.body)));
	await setImmediate();
	assert.match(restored.text(), /1 on this branch/);
	restored.click("pi-save-comment");
	assert.deepEqual(restored.posts[1].body, {
		action: "save", noteId: saved.noteId, expectedText: "Original draft", anchor, text: "Newer draft",
	});
});

test("reopening after a lost acknowledgment retries exactly the previous reply and keeps newer edits", async (t) => {
	const first = await open(t, [thread]);
	first.click("pi-note-thread");
	first.editReply("Original reply");
	first.click("pi-reply-thread");
	await setImmediate();
	const sent = first.posts[0].body;
	assert.match(sent.requestId, /^[0-9a-f-]{36}$/i);
	first.posts[0].reject(new Error("Lost acknowledgment"));
	await setImmediate();

	const turn = { id: sent.requestId, text: sent.text, status: "completed", reply: "Pi reply" };
	const saved = { ...thread, turns: [turn] };
	const restored = await open(t, [saved], undefined, first.drafts);
	restored.click("pi-note-thread");
	assert.match(restored.text(), /Retry previous reply/);
	restored.editReply("New draft");
	restored.replyInput().submit({ secondary: true, shift: false }, "\n");
	await setImmediate();
	assert.deepEqual(restored.posts[0].body, sent);
	restored.posts[0].resolve(response({ notes: [saved] }));
	await setImmediate();
	assert.equal(restored.replyInput().value(), "New draft\n");
	restored.click("pi-reply-thread");
	await setImmediate();
	assert.equal(restored.posts[1].body.text, "New draft\n");
	assert.notEqual(restored.posts[1].body.requestId, sent.requestId);
});

for (const end of [3, 11]) {
	test(`the retry shortcut acknowledges a running turn and ${end === 3 ? "clears just the unchanged draft" : "keeps changes from replacing a selection"}`, async (t) => {
		const drafts = new Map();
		const requestId = randomUUID();
		const body = { action: "reply", noteId: thread.id, text: "中🦀Existing reply", requestId };
		drafts.set(model.replyDraftKey(sessionId, thread.id), body.text);
		drafts.set(model.replyAttemptKey(sessionId, thread.id), JSON.stringify(body));
		const running = { ...thread, turns: [{ id: requestId, status: "running", text: body.text }] };
		const app = await open(t, [running], undefined, drafts);
		app.click("pi-note-thread");
		app.replyInput().submit({ secondary: true, shift: false }, "\n", { start: 3, end });
		await setImmediate();
		assert.deepEqual(app.posts[0].body, body);
		app.posts[0].resolve(response({ notes: [running] }));
		await setImmediate();
		assert.equal(app.replyInput().value(), end === 3 ? "" : "中🦀\n reply");
		assert.equal(app.node("pi-reply-thread").handlers.on_click, undefined);
	});
}

test("a rejected attempt leaves edited text available for a new submission", async (t) => {
	const app = await open(t, [thread]);
	app.click("pi-note-thread");
	app.editReply("Original reply");
	app.click("pi-reply-thread");
	await setImmediate();
	app.editReply("New draft");
	app.posts[0].resolve(response({ error: "A turn is already running." }, 409));
	await setImmediate();
	assert.match(app.text(), /A turn is already running/);
	app.click("pi-reply-thread");
	await setImmediate();
	assert.notEqual(app.posts[1].body.requestId, app.posts[0].body.requestId);
	assert.equal(app.posts[1].body.text, "New draft");
});

test("a corrupt retry record never posts and does not prevent sending the current draft", async (t) => {
	const drafts = new Map([[model.replyAttemptKey(sessionId, thread.id), "{"]]);
	const app = await open(t, [thread], undefined, drafts);
	app.click("pi-note-thread");
	app.editReply("My draft");
	app.click("pi-reply-thread");
	await setImmediate();
	assert.deepEqual(app.posts, []);
	assert.match(app.text(), /could not be recovered/);
	assert.equal(app.replyInput().value(), "My draft");
	app.click("pi-reply-thread");
	await setImmediate();
	assert.equal(app.posts[0].body.text, "My draft");
});

test("a reply is not posted before its retry identity is flushed", async (t) => {
	const flush = Promise.withResolvers();
	const app = await open(t, [thread], undefined, new Map(), false, { flush: () => flush.promise });
	app.click("pi-note-thread");
	app.editReply("Keep this draft");
	app.click("pi-reply-thread");
	try {
		await setImmediate();
		assert.deepEqual(app.posts, []);
	} finally {
		flush.resolve();
	}
	await setImmediate();
	assert.equal(app.posts[0].body.text, "Keep this draft");
});

test("a reply acknowledged after reconnect is not left ready to resend", async (t) => {
	const app = await open(t, [thread]);
	app.click("pi-note-thread");
	const sent = `${"Long reply ".repeat(50)}\n\nTail after 420 characters`;
	app.editReply(sent);
	app.click("pi-reply-thread");
	await setImmediate();
	assert.equal(app.posts[0].body.text, sent);
	const turn = { id: "turn", text: sent, status: "completed", reply: "Pi reply" };
	const savedThread = { ...thread, turns: [turn] };
	app.restart([savedThread]);
	await setImmediate();
	app.click("pi-reconnect");
	await setImmediate();
	app.posts[0].resolve(response({ notes: [savedThread] }));
	await setImmediate();
	assert.equal(app.drafts.has(model.replyDraftKey(sessionId, thread.id)), false);
	assert.match(app.text(), /Pi reply/);
	assert.ok(app.text().includes(sent));
	assert.equal(app.node("pi-reply-thread").handlers.on_click, undefined);
	assert.equal(app.posts.length, 1);
});

for (const timing of ["before sending", "while sending"]) {
	test(`an acknowledged reply cannot be resent and preserves another view's draft written ${timing}`, async (t) => {
		const app = await open(t, [thread], undefined, new Map(), true);
		app.click("pi-note-thread");
		app.editReply("Original reply");
		if (timing === "while sending") app.click("pi-reply-thread");
		const other = await open(t, [thread], undefined, app.drafts);
		other.click("pi-note-thread");
		other.editReply("Reply from another view");
		if (timing === "before sending") app.click("pi-reply-thread");
		await setImmediate();
		const turn = { id: "turn", text: "Original reply", status: "completed", reply: "Pi reply" };
		app.posts[0].resolve(response({ notes: [{ ...thread, turns: [turn] }] }));
		await setImmediate();
		assert.match(app.text(), /Pi reply/);
		assert.equal(app.drafts.get(model.replyDraftKey(sessionId, thread.id)), "Reply from another view");
		assert.equal(app.node("pi-reply-thread").handlers.on_click, undefined);
		app.replyInput().submit({ secondary: true, shift: false }, "\n");
		assert.equal(app.posts.length, 1);
	});
}

test("an in-flight reply preserves newer reply text", async (t) => {
	const app = await open(t, [thread]);
	app.click("pi-note-thread");
	app.editReply("Original reply");
	app.click("pi-reply-thread");
	app.editReply("Newer reply");
	await setImmediate();
	const turn = { id: "turn", text: "Original reply", status: "running" };
	app.posts[0].resolve(response({ notes: [{ ...thread, turns: [turn] }] }));
	await setImmediate();
	assert.equal(app.drafts.get(model.replyDraftKey(sessionId, thread.id)), "Newer reply");
});

for (const action of ["save", "reply"]) {
	test(`only Cmd/Ctrl+Enter can ${action} from the textarea`, async (t) => {
		const app = await open(t, [thread]);
		if (action === "save") app.addComment();
		else app.click("pi-note-thread");
		const input = action === "save" ? app.commentInput() : app.replyInput();
		const button = action === "save" ? "pi-save-comment" : "pi-reply-thread";
		input.edit("First line");
		input.submit({ secondary: false, shift: false }, "\n");
		assert.deepEqual(app.posts, []);
		assert.equal(input.value(), "First line\n");
		input.edit(`${input.value()}Second line`);
		input.submit({ secondary: false, shift: true }, "\n");
		assert.deepEqual(app.posts, []);
		assert.equal(input.value(), "First line\nSecond line\n");
		input.submit({ secondary: true, shift: true });
		assert.deepEqual(app.posts, []);
		assert.equal(input.value(), "First line\nSecond line\n");
		assert.ok(app.node(button).handlers.on_click);
		input.edit(`${input.value()}Third line`);
		input.submit({ secondary: true, shift: false }, "\n");
		await setImmediate();
		assert.equal(app.posts.length, 1);
		const { body } = app.posts[0];
		assert.equal(body.action, action);
		assert.equal(body.text, "First line\nSecond line\nThird line\n");
		if (action === "save") assert.deepEqual(body.anchor, anchor);
		else assert.equal(body.noteId, thread.id);
	});
}

test("clicking Add comment opens only the textarea at the selection and focuses it when mounted", async (t) => {
	const app = await open(t);
	const position = { x: 280, y: 160 };
	app.elementEvent("pi-transcript", "on_window_mouse_up", { bounds: { x: 100, y: 40, width: 700, height: 550 } });
	app.select("pi-markdown-item", { text: "Quote", range: { start: 0, end: 5 }, position });
	assert.equal(app.popup()?.kind, "popup");
	assert.deepEqual(app.popup().at, position);
	assert.equal(app.node("pi-save-comment"), undefined);
	app.select("pi-markdown-item", null);
	app.popupClick("pi-add-selection-comment");
	await setImmediate();
	assert.equal(app.popup(), undefined);
	const composer = app.node("pi-local-composer");
	assert.deepEqual(composer.position, { left: 90, top: 60 });
	assert.ok(flatten(composer).some((child) => child.elementId === "pi-save-comment"));
	assert.equal(app.text().match(/Save comment/g)?.length, 1);
	assert.equal(app.focusedInput(), undefined);
	app.elementEvent("pi-local-composer-card", "on_size_change", { width: 350, height: 260 });
	assert.equal(app.focusedInput(), "Write a comment on the selected text");
	app.editComment("Here is a comment");
	app.click("pi-save-comment");
	assert.deepEqual(app.posts[0].body.anchor, anchor);
	app.posts[0].resolve(response({ notes: [pending("saved", "Here is a comment")], noteId: "saved" }));
	await setImmediate();
	assert.equal(app.node("pi-local-composer"), undefined);
	assert.ok(app.node("pi-note-saved"));
});

test("closing the local textarea preserves the draft and allows saving it from the sidebar", async (t) => {
	const app = await open(t);
	app.select("pi-markdown-item", { text: "Quote", range: { start: 0, end: 5 }, position: { x: 280, y: 160 } });
	app.popupClick("pi-add-selection-comment");
	await setImmediate();
	app.editComment("Keep this draft");
	app.elementEvent("pi-local-composer-card", "on_key_down", { key: "escape" });
	assert.equal(app.node("pi-local-composer"), undefined);
	assert.equal(app.posts.length, 0);
	app.click("pi-save-comment");
	assert.equal(app.posts[0].body.text, "Keep this draft");
	assert.deepEqual(app.posts[0].body.anchor, anchor);
});

test("dismissing the selection popup or selecting without a pointer keeps the sidebar action", async (t) => {
	const app = await open(t);
	const selection = { text: "Quote", range: { start: 0, end: 5 } };
	app.select("pi-markdown-item", { ...selection, position: { x: 280, y: 160 } });
	app.dismissPopup();
	await setImmediate();
	assert.equal(app.node("pi-save-comment"), undefined);
	app.select("pi-markdown-item", selection);
	assert.equal(app.popup(), undefined);
	app.click("pi-add-comment");
	assert.equal(app.focusedInput(), "Write a comment on the selected text");
});

test("resizing the transcript viewport dismisses the selection popup and keeps the sidebar action", async (t) => {
	const app = await open(t);
	const resize = app.transcriptViewport();
	resize({ width: 640, height: 480 });
	app.select("pi-markdown-item", { text: "Quote", range: { start: 0, end: 5 }, position: { x: 280, y: 160 } });
	assert.equal(app.popup()?.kind, "popup");
	resize({ width: 640, height: 440 });
	assert.equal(app.popup(), undefined);
	assert.equal(app.focusedInput(), undefined);
	app.click("pi-add-comment");
	assert.equal(app.focusedInput(), "Write a comment on the selected text");
});

test("a selection popup cannot open an editor in a tab that is no longer shown", async (t) => {
	const app = await open(t);
	app.select("pi-markdown-item", { text: "Quote", range: { start: 0, end: 5 }, position: { x: 280, y: 160 } });
	app.selectTab("another-tab");
	app.popupClick("pi-add-selection-comment");
	await setImmediate();
	assert.equal(app.popup(), undefined);
	assert.equal(app.node("pi-save-comment"), undefined);
});

test("tool output starts as a summary and expands into selectable content that can be commented on", async (t) => {
	const items = [
		{ id: "user", kind: "user", label: "You", text: "User history stays visible" },
		{ id: "assistant", kind: "assistant", label: "Assistant", text: "Assistant history stays visible" },
		{ id: "tool", kind: "tool", label: "Tool bash ls · 2 lines", text: "Tool output Alpha\nTool output Beta" },
	];
	const app = await open(t, [], undefined, new Map(), false, { items });
	assert.match(app.text(), /User history stays visible/);
	assert.match(app.text(), /Assistant history stays visible/);
	assert.match(app.text(), /^Tool bash ls · 2 lines$/m);
	assert.doesNotMatch(app.text(), /Tool output Alpha/);
	assert.equal(app.node("pi-markdown-tool"), undefined);
	assert.match(app.text(), /Show output/);
	app.click("pi-tool-toggle-tool");
	assert.match(app.text(), /Tool output Alpha/);
	assert.match(app.text(), /Hide output/);
	assert.equal(app.node("pi-markdown-tool").selectableState, true);
	app.select("pi-markdown-tool", { text: "Tool output Alpha", range: { start: 0, end: 17 } });
	assert.match(app.text(), /Selection/);
	app.click("pi-add-comment");
	app.editComment("Comment from tool output");
	app.click("pi-save-comment");
	assert.equal(app.posts.length, 1);
	assert.deepEqual(app.posts[0].body.anchor, { itemId: "tool", start: 0, end: 17, quote: "Tool output Alpha" });
	assert.equal(app.posts[0].body.text, "Comment from tool output");
});

test("a saved comment's highlight appears on a collapsed tool row only after it expands", async (t) => {
	const note = { ...pending("saved", "Look here"), anchor: { itemId: "tool", start: 5, end: 11, quote: "output" } };
	const app = await open(t, [note], undefined, new Map(), false, {
		items: [{ id: "tool", kind: "tool", label: "bash", text: "Tool output Alpha\nTool output Beta" }],
	});
	assert.ok(app.node("pi-note-saved"));
	assert.equal(app.node("pi-markdown-tool"), undefined);
	assert.doesNotMatch(app.text(), /Tool output Alpha/);
	app.click("pi-note-saved");
	assert.deepEqual(app.node("pi-markdown-tool").highlights.map(({ start, end }) => ({ start, end })), [{ start: 5, end: 11 }]);
	app.click("pi-tool-toggle-tool");
	assert.doesNotMatch(app.text(), /Tool output Alpha/);
	assert.ok(app.node("pi-note-saved"));
	app.click("pi-tool-toggle-tool");
	assert.deepEqual(app.node("pi-markdown-tool").highlights.map(({ start, end }) => ({ start, end })), [{ start: 5, end: 11 }]);
});

test("an appended tool row starts collapsed and leaves an earlier expanded row open", async (t) => {
	const first = { id: "first", kind: "tool", label: "bash", text: "First tool output" };
	const second = { id: "second", kind: "tool", label: "edit", text: "Second tool output" };
	const app = await open(t, [], undefined, new Map(), false, { items: [first], updates: 1 });
	app.click("pi-tool-toggle-first");
	assert.match(app.text(), /First tool output/);
	app.event({ version: 2, reset: false, items: [second] });
	await setImmediate();
	assert.match(app.text(), /First tool output/);
	assert.doesNotMatch(app.text(), /Second tool output/);
	assert.ok(app.node("pi-markdown-first"));
	assert.equal(app.node("pi-markdown-second"), undefined);
	assert.ok(app.node("pi-tool-toggle-second"));
});

test("a reset drops expansion so a returning tool row starts collapsed", async (t) => {
	const tool = { id: "tool", kind: "tool", label: "bash", text: "Tool output Alpha" };
	const app = await open(t, [], undefined, new Map(), false, { items: [tool], updates: 2 });
	app.click("pi-tool-toggle-tool");
	assert.match(app.text(), /Tool output Alpha/);
	app.event({ version: 2, reset: true, items: [{ id: "user", kind: "user", label: "You", text: "Replacement history" }] });
	await setImmediate();
	assert.equal(app.node("pi-markdown-tool"), undefined);
	app.event({ version: 3, reset: false, items: [tool] });
	await setImmediate();
	assert.equal(app.node("pi-markdown-tool"), undefined);
	assert.doesNotMatch(app.text(), /Tool output Alpha/);
	assert.match(app.text(), /Show output/);
});
