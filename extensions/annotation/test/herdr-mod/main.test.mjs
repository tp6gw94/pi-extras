import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as client from "../../herdr-mod/client.js";
import * as keyboard from "../../herdr-mod/keyboard.js";
import * as model from "../../herdr-mod/model.js";

const source = (await readFile(new URL("../../herdr-mod/main.js", import.meta.url), "utf8"))
	.replace(/^import (\{[^}]+\}) from ("[^"]+");/gm, "const $1 = modules[$2];")
	.replace("export default class", "class");
const sessionId = "source";
const anchor = { itemId: "item", start: 0, end: 5, quote: "Quote", sourceText: "Quote" };
const pending = (id, text) => ({ id, status: "pending", anchor, text, version: `version of ${text}` });
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
			if (key === "track_focus") return (handle) => { handle.id = node.elementId === "pi-transcript" ? "Transcript" : node.elementId; return proxy; };
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
	const controls = [];
	const overlays = new Map();
	let overlayId = 0;
	let currentProps = { sessionId, connectionFile: "connection.json" };
	let activeTab = "source-tab";
	let focusedInput;
	let blurInput;
	const focus = (id, onBlur) => {
		if (focusedInput === id) return;
		blurInput?.();
		focusedInput = id;
		blurInput = onBlur;
	};
	let scrollTop = 0;
	let pollReview;
	const idle = new Promise(() => {});
	const cx = {
		notify() {},
		stop_propagation() {},
		focus_handle: () => ({
			id: "Transcript",
			focus() { focus(this.id); },
			is_focused() { return focusedInput === this.id; },
			release() {},
		}),
		spawn(run) { void run(cx); return { cancel() {} }; },
		sleep: (ms) => ms === 0 ? setImmediate() : idle,
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
			Scrollbar: { vertical: () => element() },
			ScrollHandle: { new: () => ({
				offset: () => ({ y: scrollTop }), viewport_size: () => ({ height: 132 }),
				scroll_to_item(row) { scrollTop = row; }, release() {},
			}) },
			TextareaState: { new({ placeholder, value = "" }) {
				const handlers = {};
				let selection;
				const state = { on: (name, handler) => { handlers[name] = handler; }, value: () => value,
					selected_range: () => selection ?? { start: value.length, end: value.length },
					set_selected_range(range) { selection = range; },
					set_value(text) { value = text; if (setValueEmitsChange) handlers.change({}, cx); },
					focus() {
						focus(placeholder, () => handlers.blur?.({}, cx));
						handlers.focus?.({}, cx);
					},
					blur() { if (focusedInput === placeholder) focus(undefined); },
					release() {} };
				const edit = (text) => { value = text; handlers.change({}, cx); };
				const control = { edit, value: state.value, select(range) { selection = range; }, submit(event, insertedText = "", range) {
					if (insertedText) {
						const { start, end } = range ?? state.selected_range();
						const caret = start + insertedText.length;
						selection = { start: caret, end: caret };
						edit(value.slice(0, start) + insertedText + value.slice(end));
					}
					handlers.submit(event, cx);
					selection = undefined;
				} };
				inputs.set(placeholder, control);
				controls.push({ placeholder, control });
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
		"./keyboard.js": keyboard,
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
	const click = (id) => {
		if (id === "pi-save-comment" || id.startsWith("pi-note-")) focus(id);
		node(id).handlers.on_click({}, cx);
	};
	const popup = () => [...overlays.values()].at(-1);
	const commentInput = () => inputs.get("Write a comment on the selected text");
	const replyInput = (index = -1) => controls.filter(({ placeholder }) => placeholder === "Reply to the background Pi thread").at(index).control;
	await setImmediate();
	return {
		click, drafts, posts, node, text: () => tree().filter((child) => typeof child === "string").join("\n"),
		popup: () => popup()?.spec,
		popupClick: (id) => flatten(popup().popup.render(cx)).find((child) => child.elementId === id).handlers.on_click({}, cx),
		dismissPopup: () => modules.herdr.closeOverlay([...overlays.keys()].at(-1)),
		elementEvent: (id, name, event) => node(id).handlers[name](event, cx),
		focusedInput: () => focusedInput,
		focusTranscript: () => focus("Transcript"),
		scrollTop: () => scrollTop,
		scrollTo: (offset) => { scrollTop = offset; },
		key: (keystroke, event = {}) => node("pi-transcript").handlers.on_key_down({ keystroke, ...event }, cx),
		selectTab: (id) => { activeTab = id; },
		commentInput, replyInput,
		mainInput: () => inputs.get("Write to main Pi, or add context to the pending comments"),
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

test("Vim motion and Visual selection open a local draft with the exact transcript anchor", async (t) => {
	const first = { id: "first", kind: "user", label: "You", text: "Ignore" };
	const text = "head\nx\nrow2\nrow3\n甲😀丙\nDone\nrow6\nrow7";
	const second = { id: "second", kind: "assistant", label: "Assistant", text };
	const app = await open(t, [], undefined, new Map(), false, { items: [first, second] });
	app.click("pi-keyboard-toggle");
	assert.equal(app.focusedInput(), "Transcript");
	assert.match(app.text(), /NORMAL/);
	app.key("c");
	assert.equal(app.drafts.size, 0);
	app.key("ctrl-d");
	app.key("ctrl-d");
	app.key("ctrl-u");
	app.key("j");
	app.key("l");
	app.key("l");
	app.key("v");
	assert.match(app.text(), /VISUAL/);
	app.key("h");
	app.key("c");
	assert.equal(app.focusedInput(), "Write a comment on the selected text");
	app.editComment("Please clarify");
	const draft = model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)));
	const start = text.indexOf("😀");
	assert.deepEqual(draft.anchor, { itemId: "second", start, end: start + 3, quote: "😀丙", sourceText: "😀丙" });
	assert.equal(draft.text, "Please clarify");
	assert.equal(app.posts.length, 0);
	app.click("pi-cancel-comment");
	assert.equal(app.focusedInput(), "Transcript");
	app.key("escape");
	assert.equal(app.node("pi-markdown-second").selectableState, true);
});

test("review polling does not move the keyboard transcript viewport", async (t) => {
	const items = [{ id: "item", kind: "assistant", label: "Assistant", text: "Row\n".repeat(30) }];
	const app = await open(t, [], undefined, new Map(), false, { items });
	app.click("pi-keyboard-toggle");
	app.scrollTo(220);
	app.pollReview();
	await setImmediate();
	assert.equal(app.scrollTop(), 220);
});

test("live transcript updates preserve Visual anchors on append and exit on rewrite", async (t) => {
	const first = { id: "first", kind: "user", label: "You", text: "First" };
	const second = { id: "second", kind: "assistant", label: "Assistant", text: "a b" };
	const third = { id: "third", kind: "user", label: "You", text: "Third" };
	const app = await open(t, [], undefined, new Map(), false, { items: [first, second], updates: 3 });
	app.click("pi-keyboard-toggle");
	app.key("v");
	app.key("l");
	app.event({ version: 2, reset: false, items: [third] });
	await setImmediate();
	app.event({ version: 3, reset: true, items: [first, { ...second, text: "a b and more" }, third] });
	await setImmediate();
	app.key("c");
	const draft = model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)));
	assert.deepEqual(draft?.anchor, { itemId: "second", start: 0, end: 2, quote: "a ", sourceText: "a " });
	app.click("pi-cancel-comment");
	app.key("j");
	app.key("v");
	app.key("c");
	assert.equal(model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)))?.anchor.itemId, "third");
	app.click("pi-cancel-comment");
	app.event({ version: 4, reset: true, items: [first, second, { ...third, text: "Changed" }] });
	await setImmediate();
	assert.equal(app.node("pi-keyboard-lines"), undefined);
	assert.equal(app.node("pi-markdown-third").selectableState, true);
});

test("Visual selects combined glyphs without splitting their UTF-16 ranges", async (t) => {
	const cluster = "e\u0301👨‍👩‍👧‍👦";
	const items = [{ id: "item", kind: "user", label: "You", text: cluster + "!" }];
	const app = await open(t, [], undefined, new Map(), false, { items });
	app.click("pi-keyboard-toggle");
	app.key("v");
	app.key("l");
	app.key("c");
	const draft = model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)));
	assert.deepEqual(draft?.anchor, { itemId: "item", start: 0, end: cluster.length, quote: cluster, sourceText: cluster });
});

test("selecting a note makes its expanded tool output reachable by keyboard immediately", async (t) => {
	const items = [
		{ id: "item", kind: "tool", label: "Tool", text: "Quote from tool" },
		{ id: "second", kind: "assistant", label: "Assistant", text: "Answer" },
	];
	const app = await open(t, [pending("tool", "Tool note")], undefined, new Map(), false, { items });
	app.click("pi-keyboard-toggle");
	app.click("pi-note-tool");
	app.focusTranscript();
	app.key("k");
	app.key("v");
	app.key("c");
	assert.equal(model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)))?.anchor.itemId, "item");
});

for (const focusElsewhere of [false, true]) {
	test(`saving a keyboard comment ${focusElsewhere ? "leaves newer focus alone" : "returns focus from Save to the transcript"}`, async (t) => {
		const app = await open(t, [pending("existing", "Earlier comment")]);
		app.click("pi-keyboard-toggle");
		app.key("v");
		app.key("c");
		app.editComment("New comment");
		app.click("pi-save-comment");
		if (focusElsewhere) app.click("pi-note-existing");
		const body = app.posts[0].body;
		app.posts[0].resolve(response({ noteId: "saved", notes: [pending("existing", "Earlier comment"),
			{ ...pending("saved", body.text), anchor: body.anchor }] }));
		await setImmediate();
		assert.equal(app.node("pi-save-comment"), undefined);
		assert.equal(app.focusedInput(), focusElsewhere ? "pi-note-existing" : "Transcript");
	});
}

test("Visual mode stops at the message boundary and Escape clears it before leaving keyboard mode", async (t) => {
	const app = await open(t, [], undefined, new Map(), false, { items: [
		{ id: "before", kind: "user", label: "You", text: "Earlier" },
		{ id: "current", kind: "assistant", label: "Assistant", text: "A\nB" },
	] });
	app.click("pi-keyboard-toggle");
	app.key("v");
	app.key("k");
	app.key("j");
	assert.match(app.text(), /Selected text · Assistant\nA B/);
	app.key("escape");
	assert.match(app.text(), /NORMAL/);
	assert.equal(app.node("pi-add-comment"), undefined);
	app.key("k");
	app.key("k");
	app.key("v");
	app.key("c");
	const draft = model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)));
	assert.deepEqual(draft.anchor, { itemId: "before", start: 0, end: 1, quote: "E", sourceText: "E" });
});

test("resizing across a wrapped line preserves the selection's source offsets", async (t) => {
	const app = await open(t, [], undefined, new Map(), false, { items: [
		{ id: "item", kind: "assistant", label: "Assistant", text: "abcdefghijkl" },
	] });
	app.click("pi-keyboard-toggle");
	for (let col = 0; col < 7; col++) app.key("l");
	app.key("v");
	app.elementEvent("pi-transcript-scroll", "on_size_change", { width: 392, height: 264 });
	app.key("l");
	app.key("c");
	const draft = model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)));
	assert.deepEqual(draft.anchor, { itemId: "item", start: 7, end: 9, quote: "hi", sourceText: "hi" });
});

test("gg and G reach the transcript endpoints while Visual keeps each jump inside its message", async (t) => {
	const items = [
		{ id: "first", kind: "assistant", label: "Assistant", text: "Alpha\nBravo" },
		{ id: "second", kind: "user", label: "You", text: "Charlie\nDelta" },
	];
	const draft = (app) => model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)));
	const first = await open(t, [], undefined, new Map(), false, { items });
	first.click("pi-keyboard-toggle");
	first.key("g");
	first.key("g");
	first.key("v");
	first.key("c");
	assert.deepEqual(draft(first).anchor, { itemId: "first", start: 0, end: 1, quote: "A", sourceText: "A" });

	const last = await open(t, [], undefined, new Map(), false, { items });
	last.click("pi-keyboard-toggle");
	last.key("shift-g");
	last.key("v");
	last.key("c");
	assert.deepEqual(draft(last).anchor, { itemId: "second", start: 8, end: 9, quote: "D", sourceText: "D" });

	const visualLast = await open(t, [], undefined, new Map(), false, { items });
	visualLast.click("pi-keyboard-toggle");
	visualLast.key("k");
	visualLast.key("v");
	visualLast.key("shift-g");
	visualLast.key("c");
	assert.deepEqual(draft(visualLast).anchor, { itemId: "first", start: 6, end: 7, quote: "B", sourceText: "B" });

	const visualFirst = await open(t, [], undefined, new Map(), false, { items });
	visualFirst.click("pi-keyboard-toggle");
	visualFirst.key("v");
	visualFirst.key("j");
	visualFirst.key("g");
	visualFirst.key("g");
	visualFirst.key("c");
	assert.deepEqual(draft(visualFirst).anchor, { itemId: "second", start: 0, end: 1, quote: "C", sourceText: "C" });
});

test("the g prefix jumps only on two initial presses and clears on another key, auto-repeat, or re-entry", async (t) => {
	const items = [
		{ id: "first", kind: "assistant", label: "Assistant", text: "Alpha" },
		{ id: "second", kind: "user", label: "You", text: "Charlie\nDelta" },
	];
	const draft = (app) => model.parseComposerDraft(app.drafts.get(model.composerDraftKey(sessionId)));
	const interrupted = await open(t, [], undefined, new Map(), false, { items });
	interrupted.click("pi-keyboard-toggle");
	interrupted.key("g");
	interrupted.key("j");
	interrupted.key("g");
	interrupted.key("v");
	interrupted.key("c");
	assert.deepEqual(draft(interrupted).anchor, { itemId: "second", start: 8, end: 9, quote: "D", sourceText: "D" });

	const repeated = await open(t, [], undefined, new Map(), false, { items });
	repeated.click("pi-keyboard-toggle");
	repeated.key("j");
	repeated.key("g");
	repeated.key("g", { is_held: true });
	repeated.key("v");
	repeated.key("c");
	assert.deepEqual(draft(repeated).anchor, { itemId: "second", start: 8, end: 9, quote: "D", sourceText: "D" });

	const reentered = await open(t, [], undefined, new Map(), false, { items });
	reentered.click("pi-keyboard-toggle");
	reentered.key("g");
	reentered.click("pi-keyboard-toggle");
	reentered.click("pi-keyboard-toggle");
	reentered.key("g");
	reentered.key("v");
	reentered.key("c");
	assert.deepEqual(draft(reentered).anchor, { itemId: "second", start: 0, end: 1, quote: "C", sourceText: "C" });
});

test("gg and G scroll the jumped-to transcript item into view", async (t) => {
	const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
	const app = await open(t, [], undefined, new Map(), false, {
		items: [
			{ id: "first", kind: "assistant", label: "Assistant", text: lines.join("\n") },
			{ id: "second", kind: "user", label: "You", text: "Last message" },
		],
	});
	app.click("pi-keyboard-toggle");
	app.key("shift-g");
	assert.equal(app.scrollTop(), 1);
	app.key("g");
	app.key("g");
	assert.equal(app.scrollTop(), 0);
});

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
	const actions = ["pi-send-main", "pi-start-note", "pi-edit-note", "pi-delete-note"];
	for (const id of actions) assert.equal(app.node(id).handlers.on_click, undefined, id);
	firstReview.resolve(response({ error: "Review unavailable" }, 503));
	await setImmediate();
	assert.match(app.text(), /Review unavailable/);
	for (const id of actions) assert.equal(app.node(id).handlers.on_click, undefined, id);
	app.click("pi-note-thread");
	app.editReply("Draft reply");
	assert.equal(app.node("pi-reply-thread").handlers.on_click, undefined);
	app.replyInput().submit({ secondary: true, shift: true }, "\n");
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
	restored.replyInput().submit({ secondary: true, shift: true }, "\n");
	await setImmediate();
	assert.deepEqual(restored.posts[0].body, sent);
	restored.posts[0].resolve(response({ notes: [saved] }));
	await setImmediate();
	assert.equal(restored.replyInput().value(), "New draft");
	restored.click("pi-reply-thread");
	await setImmediate();
	assert.equal(restored.posts[1].body.text, "New draft");
	assert.notEqual(restored.posts[1].body.requestId, sent.requestId);
});

for (const end of [3, 11]) {
	test(`the retry shortcut acknowledges a running turn without adding a newline at selection end ${end}`, async (t) => {
		const drafts = new Map();
		const requestId = randomUUID();
		const body = { action: "reply", noteId: thread.id, text: "中🦀Existing reply", requestId };
		drafts.set(model.replyDraftKey(sessionId, thread.id), body.text);
		drafts.set(model.replyAttemptKey(sessionId, thread.id), JSON.stringify(body));
		const running = { ...thread, turns: [{ id: requestId, status: "running", text: body.text }] };
		const app = await open(t, [running], undefined, drafts);
		app.click("pi-note-thread");
		app.replyInput().submit({ secondary: true, shift: true }, "\n", { start: 3, end });
		await setImmediate();
		assert.deepEqual(app.posts[0].body, body);
		app.posts[0].resolve(response({ notes: [running] }));
		await setImmediate();
		assert.equal(app.replyInput().value(), "");
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

test("Enter saves the comment without the native newline, Shift+Enter keeps it, and a replaced selection is restored", async (t) => {
	const app = await open(t);
	app.addComment();
	const input = app.commentInput();
	input.edit("First line");
	input.submit({ secondary: false, shift: true }, "\n");
	assert.deepEqual(app.posts, []);
	assert.equal(input.value(), "First line\n");
	input.edit(`${input.value()}Second line`);
	input.submit({ secondary: false, shift: false }, "\n");
	await setImmediate();
	assert.equal(app.posts.length, 1);
	assert.deepEqual(app.posts[0].body.anchor, anchor);
	assert.equal(app.posts[0].body.text, "First line\nSecond line");
	const saved = pending("saved", "First line\nSecond line");
	app.posts[0].resolve(response({ notes: [saved], noteId: saved.id }));
	await setImmediate();
	assert.equal(app.node("pi-save-comment"), undefined);

	const selected = await open(t);
	selected.addComment();
	selected.commentInput().edit("abcdef");
	selected.commentInput().select({ start: 2, end: 4 });
	selected.commentInput().submit({ secondary: false, shift: false }, "\n", { start: 2, end: 4 });
	await setImmediate();
	assert.equal(selected.posts[0].body.text, "abcdef");
});

test("main Enter saves, Shift+Enter inserts a newline, and the modified keys send to distinct destinations", async (t) => {
	const app = await open(t, [pending("note", "Pending comment")]);
	const input = app.mainInput();
	input.edit("Main message");
	input.submit({ secondary: false, shift: false }, "\n");
	assert.deepEqual(app.posts, []);
	assert.equal(input.value(), "Main message");
	assert.equal(app.drafts.get(model.mainDraftKey(sessionId)), "Main message");
	input.submit({ secondary: false, shift: true }, "\n");
	assert.equal(input.value(), "Main message\n");
	input.submit({ secondary: true, shift: false }, "\n");
	await setImmediate();
	assert.equal(app.posts.length, 1);
	assert.equal(app.posts[0].body.action, "send");
	assert.deepEqual(app.posts[0].body.noteIds, ["note"]);
	assert.equal(app.posts[0].body.text, "Main message\n");

	const started = await open(t);
	started.mainInput().edit("Background only");
	started.mainInput().submit({ secondary: true, shift: true }, "\n");
	await setImmediate();
	assert.equal(started.posts[0].body.action, "start");
	assert.equal(started.posts[0].body.text, "Background only");
});

test("acknowledging another view's background start preserves even an identical draft", async (t) => {
	const original = { action: "start", createId: randomUUID(), text: "Same question" };
	const drafts = new Map([
		[model.startAttemptKey(sessionId), JSON.stringify({ createId: original.createId, text: original.text })],
		[model.mainDraftKey(sessionId), original.text],
	]);
	const started = { ...thread, anchor: null, id: original.createId, text: original.text };
	const other = await open(t, [started], undefined, drafts);
	other.click("pi-start-new");
	await setImmediate();
	assert.deepEqual(other.posts[0].body, original);
	other.posts[0].resolve(response({ notes: [started], noteId: started.id }));
	await setImmediate();
	assert.equal(other.mainInput().value(), original.text);
	assert.equal(drafts.get(model.mainDraftKey(sessionId)), original.text);
	assert.equal(drafts.has(model.startAttemptKey(sessionId)), false);
});

test("checking a pending background start replays the original request and keeps a newer draft", async (t) => {
	const first = await open(t);
	first.mainInput().edit("Original question");
	first.click("pi-start-new");
	await setImmediate();
	const original = first.posts[0].body;
	first.posts[0].reject(new Error("Lost acknowledgment"));
	await setImmediate();
	first.mainInput().edit("");

	const started = { ...thread, anchor: null, id: original.createId, text: original.text };
	const reopened = await open(t, [started], undefined, first.drafts);
	assert.equal(reopened.mainInput().value(), "");
	assert.match(reopened.text(), /Check pending start/);
	assert.ok(reopened.node("pi-start-new").handlers.on_click);
	reopened.mainInput().edit("New question");
	reopened.click("pi-start-new");
	await setImmediate();
	assert.deepEqual(reopened.posts[0].body, original);
	reopened.posts[0].resolve(response({ notes: [started], noteId: started.id }));
	await setImmediate();
	assert.equal(reopened.mainInput().value(), "New question");
	assert.equal(reopened.drafts.get(model.mainDraftKey(sessionId)), "New question");
	assert.doesNotMatch(reopened.text(), /Check pending start/);
	reopened.click("pi-start-new");
	await setImmediate();
	assert.equal(reopened.posts[1].body.text, "New question");
	assert.notEqual(reopened.posts[1].body.createId, original.createId);
});

for (const shift of [false, true]) {
	test(`a comment submission saves before sending to ${shift ? "background" : "main"} Pi`, async (t) => {
		const existing = pending("existing", "Another comment");
		const app = await open(t, [existing]);
		app.addComment();
		app.editComment("New comment");
		app.commentInput().submit({ secondary: true, shift }, "\n");
		await setImmediate();
		assert.equal(app.posts[0].body.action, "save");
		assert.equal(app.posts[0].body.text, "New comment");
		const saved = pending("new", "New comment");
		app.posts[0].resolve(response({ notes: [existing, saved], noteId: saved.id }));
		await setImmediate();
		assert.equal(app.posts.length, 2);
		const body = app.posts[1].body;
		if (shift) assert.deepEqual(body, { action: "start", noteId: saved.id });
		else {
			assert.equal(body.action, "send");
			assert.deepEqual(body.noteIds, [existing.id, saved.id]);
			assert.deepEqual(body.noteVersions, [existing.version, saved.version]);
		}
	});
}

for (const action of ["send", "start"]) {
	test(`acknowledging a ${action} preserves an identical draft written by another view`, async (t) => {
		const drafts = new Map();
		const first = await open(t, [], undefined, drafts);
		const other = await open(t, [], undefined, drafts);
		first.mainInput().edit("Shared wording");
		first.click(action === "send" ? "pi-send-main" : "pi-start-new");
		await setImmediate();
		const { body } = first.posts[0];
		other.mainInput().edit(body.text);
		const started = { ...thread, anchor: null, id: body.createId, text: body.text };
		first.posts[0].resolve(response(action === "send"
			? { notes: [], sentRequestId: body.requestId }
			: { notes: [started], noteId: started.id }));
		await setImmediate();
		assert.equal(first.mainInput().value(), body.text);
		const reopened = await open(t, [], undefined, drafts);
		assert.equal(reopened.mainInput().value(), body.text);
	});
}

test("a background start rejected before dispatch does not pin the old draft", async (t) => {
	const app = await open(t);
	app.mainInput().edit("First question");
	app.click("pi-start-new");
	await setImmediate();
	app.posts[0].resolve(response({ error: "No model selected." }, 409));
	await setImmediate();
	assert.equal(app.mainInput().value(), "First question");
	app.mainInput().edit("Current question");
	app.click("pi-start-new");
	await setImmediate();
	assert.equal(app.posts[1].body.text, "Current question");
	assert.notEqual(app.posts[1].body.createId, app.posts[0].body.createId);
});

test("an unacknowledged main send keeps the draft and checks the same request ID without replaying", async (t) => {
	const app = await open(t, [pending("note", "Pending comment")]);
	app.mainInput().edit("Keep this message");
	app.click("pi-send-main");
	await setImmediate();
	assert.equal(app.posts.length, 1);
	const body = app.posts[0].body;
	assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
	assert.equal(app.node("pi-send-main").handlers.on_click, undefined);
	app.mainInput().submit({ secondary: true, shift: false }, "\n");
	assert.equal(app.posts.length, 1);
	app.posts[0].reject(new Error("Lost acknowledgment"));
	await setImmediate();
	assert.match(app.text(), /Could not reach the Pi annotation server/);
	assert.equal(app.mainInput().value(), "Keep this message");
	app.mainInput().edit("New unsent message");
	app.click("pi-send-main");
	await setImmediate();
	assert.equal(app.posts.length, 2);
	assert.deepEqual(app.posts[1].body, { action: "check-send", requestId: body.requestId });
	const sent = { ...pending("note", "Pending comment"), status: "sent" };
	app.posts[1].resolve(response({ notes: [sent], sentRequestId: body.requestId }));
	await setImmediate();
	assert.equal(app.mainInput().value(), "New unsent message");
	assert.equal(app.drafts.get(model.mainDraftKey(sessionId)), "New unsent message");
	app.click("pi-send-main");
	await setImmediate();
	assert.equal(app.posts[2].body.text, "New unsent message");
	assert.deepEqual(app.posts[2].body.noteIds, []);
	assert.notEqual(app.posts[2].body.requestId, body.requestId);
});

test("a second open tab checks the shared pending send without replacing it or clearing its own draft", async (t) => {
	const drafts = new Map();
	const first = await open(t, [], undefined, drafts);
	const second = await open(t, [], undefined, drafts);
	first.mainInput().edit("Shared text");
	second.mainInput().edit("Shared text");
	first.click("pi-send-main");
	await setImmediate();
	const { requestId } = first.posts[0].body;
	second.mainInput().submit({ secondary: true, shift: false });
	assert.deepEqual(second.posts, []);
	assert.equal(JSON.parse(drafts.get(model.sendAttemptKey(sessionId))).requestId, requestId);
	assert.match(second.text(), /Check previous send/);

	first.posts[0].reject(new Error("Lost acknowledgment"));
	second.restart();
	await setImmediate();
	second.click("pi-reconnect");
	await setImmediate();
	second.click("pi-send-main");
	assert.deepEqual(second.posts[0].body, { action: "check-send", requestId });
	second.posts[0].resolve(response({ notes: [], sentRequestId: requestId }));
	await setImmediate();
	assert.equal(second.mainInput().value(), "Shared text");
	assert.equal(drafts.get(model.mainDraftKey(sessionId)), "Shared text");
	assert.doesNotMatch(first.text(), /Check previous send/);

	second.mainInput().edit("Intentional follow-up");
	second.click("pi-send-main");
	await setImmediate();
	const next = second.posts[1];
	assert.equal(next.body.action, "send");
	assert.equal(next.body.text, "Intentional follow-up");
	assert.notEqual(next.body.requestId, requestId);
	next.resolve(response({ notes: [], sentRequestId: next.body.requestId }));
	await setImmediate();
	assert.equal(second.mainInput().value(), "");
});

test("a not-sent check clears a staged attempt without dispatching or clearing either draft", async (t) => {
	const drafts = new Map();
	const flush = Promise.withResolvers();
	const first = await open(t, [], undefined, drafts, false, { flush: () => flush.promise });
	const second = await open(t, [], undefined, drafts);
	first.mainInput().edit("Keep this message");
	second.mainInput().edit("Keep this message");
	first.click("pi-send-main");
	second.click("pi-send-main");
	assert.equal(second.posts[0].body.action, "check-send");
	second.posts[0].resolve(response({ error: "This request was not sent. Start a new send." }, 409));
	await setImmediate();
	flush.resolve();
	await setImmediate();
	assert.deepEqual(first.posts, []);
	assert.equal(first.mainInput().value(), "Keep this message");
	assert.equal(second.mainInput().value(), "Keep this message");
	assert.equal(drafts.get(model.mainDraftKey(sessionId)), "Keep this message");
	assert.equal(drafts.has(model.sendAttemptKey(sessionId)), false);
});

test("a send blocked by a server receipt can reconcile that receipt without clearing its draft", async (t) => {
	const app = await open(t);
	app.mainInput().edit("Keep this message");
	app.click("pi-send-main");
	await setImmediate();
	const requestId = randomUUID();
	app.posts[0].resolve(response({ error: "Receipt unknown. Check the source conversation before sending again.", pendingSendRequestId: requestId }, 409));
	await setImmediate();

	const reopened = await open(t, [], undefined, app.drafts);
	reopened.click("pi-send-main");
	assert.deepEqual(reopened.posts[0].body, { action: "check-send", requestId });
	reopened.posts[0].resolve(response({ error: "Receipt unknown. Check the source conversation before sending again." }, 409));
	await setImmediate();
	reopened.click("pi-resolve-sent");
	reopened.click("pi-resolve-sent");
	assert.deepEqual(reopened.posts[1].body, { action: "resolve-send", requestId, outcome: "sent" });
	reopened.posts[1].resolve(response({ notes: [], sentRequestId: requestId }));
	await setImmediate();
	assert.equal(reopened.mainInput().value(), "Keep this message");
	assert.equal(app.drafts.get(model.mainDraftKey(sessionId)), "Keep this message");
	assert.equal(app.drafts.has(model.sendAttemptKey(sessionId)), false);
});

test("main send keeps the draft when another view edits a comment before dispatch", async (t) => {
	const note = pending("note", "Seen comment");
	const app = await open(t, [note]);
	app.mainInput().edit("Keep this message");
	app.click("pi-send-main");
	await setImmediate();
	const { body } = app.posts[0];
	assert.deepEqual(body.noteIds, [note.id]);
	assert.deepEqual(body.noteVersions, [note.version]);

	app.posts[0].resolve(response({ error: "A selected note changed. Review the notes before sending again." }, 409));
	await setImmediate();
	assert.match(app.text(), /changed.*before sending/i);
	assert.equal(app.mainInput().value(), "Keep this message");
	assert.doesNotMatch(app.text(), /Check previous send/);
	assert.equal(app.drafts.has(model.sendAttemptKey(sessionId)), false);
});

test("a live uncertain receipt offers check and sent confirmation, not a resend or not-sent resolution", async (t) => {
	const app = await open(t);
	app.mainInput().edit("One message");
	app.click("pi-send-main");
	await setImmediate();
	const { requestId } = app.posts[0].body;
	app.posts[0].resolve(response({ error: "Receipt unknown. Main Pi may still deliver this message. Check again or confirm it was sent if you see it." }, 409));
	await setImmediate();
	assert.match(app.text(), /may still deliver/);
	assert.match(app.text(), /Check previous send/);
	assert.equal(app.node("pi-resolve-not-sent"), undefined);
	assert.equal(app.mainInput().value(), "One message");
	app.click("pi-resolve-sent");
	assert.equal(app.posts.length, 1);
	app.click("pi-resolve-sent");
	assert.deepEqual(app.posts[1].body, { action: "resolve-send", requestId, outcome: "sent" });
	app.posts[1].resolve(response({ notes: [], sentRequestId: requestId }));
	await setImmediate();
	assert.equal(app.mainInput().value(), "");
	assert.match(app.text(), /Sent your message/);
});

test("an acknowledged main draft is not resurrected by Enter", async (t) => {
	const app = await open(t, [], undefined, new Map(), true);
	app.mainInput().edit("Send once");
	app.click("pi-send-main");
	await setImmediate();
	app.posts[0].resolve(response({ notes: [], sentRequestId: app.posts[0].body.requestId }));
	await setImmediate();
	for (const secondary of [false, true]) {
		app.mainInput().submit({ secondary, shift: false }, "\n");
		await setImmediate();
		assert.equal(app.mainInput().value(), "");
		assert.equal(app.drafts.has(model.mainDraftKey(sessionId)), false);
		assert.equal(app.posts.length, 1);
	}
});

test("a restored composer submits its exact draft and a replacement composer starts blank", async (t) => {
	const drafts = new Map([[model.composerDraftKey(sessionId), model.encodeComposerDraft({
		noteId: null, anchor, text: "Recovered text", createId: randomUUID(),
	})]]);
	const app = await open(t, [], undefined, drafts);
	app.commentInput().submit({ secondary: false, shift: false }, "\n", { start: 0, end: 0 });
	assert.equal(app.posts[0].body.text, "Recovered text");
	app.posts[0].resolve(response({ notes: [pending("saved", "Recovered text")], noteId: "saved" }));
	await setImmediate();
	app.addComment();
	app.commentInput().submit({ secondary: false, shift: false }, "\n");
	assert.equal(app.commentInput().value(), "");
	assert.equal(app.posts.length, 1);
});

test("a newline pasted in an earlier input event is not removed by a later submit without insertion", async (t) => {
	const app = await open(t);
	app.mainInput().edit("Line");
	app.mainInput().edit("Line\n");
	await setImmediate();
	app.mainInput().submit({ secondary: true, shift: false });
	await setImmediate();
	assert.equal(app.posts[0].body.text, "Line\n");
});

test("a stale candidate does not replace a previous pasted newline when native Enter inserts a new one", async (t) => {
	const app = await open(t);
	app.mainInput().edit("Line");
	app.mainInput().edit("Line\n");
	app.mainInput().submit({ secondary: true, shift: false }, "\n");
	await setImmediate();
	assert.equal(app.posts[0].body.text, "Line\n");
});

for (const outcome of ["sent", "not-sent"]) {
	test(`a reopened send can be recorded as ${outcome} only after an unknown receipt and explicit confirmation`, async (t) => {
		const note = pending("note", "Pending comment");
		const attempt = { action: "send", requestId: randomUUID(), noteIds: [note.id], text: "Previous message" };
		const drafts = new Map([
			[model.sendAttemptKey(sessionId), JSON.stringify(attempt)],
			[model.mainDraftKey(sessionId), attempt.text],
		]);
		const app = await open(t, [note], undefined, drafts);
		assert.equal(app.node("pi-resolve-sent"), undefined);
		app.addComment();
		app.editComment("New comment");
		assert.equal(app.node("pi-send-comment").handlers.on_click, undefined);
		assert.match(app.text(), /Check the previous send before using Save & send/);
		app.commentInput().submit({ secondary: true, shift: false }, "\n");
		assert.equal(app.posts.length, 0);
		assert.equal(app.commentInput().value(), "New comment");
		app.click("pi-cancel-comment");
		app.mainInput().submit({ secondary: true, shift: false }, "\n");
		assert.equal(app.posts.length, 0);
		app.click("pi-send-main");
		assert.deepEqual(app.posts[0].body, { action: "check-send", requestId: attempt.requestId });
		app.posts[0].resolve(response({ error: "Main Pi send is still in progress." }, 409));
		await setImmediate();
		assert.equal(app.node("pi-resolve-sent"), undefined);
		app.click("pi-send-main");
		app.posts[1].resolve(response({ error: "Receipt unknown. Check the source conversation before sending again." }, 409));
		await setImmediate();
		const id = `pi-resolve-${outcome}`;
		app.click(id);
		assert.equal(app.posts.length, 2);
		assert.match(app.text(), /Confirm it was (not )?sent/);
		app.click(id);
		assert.deepEqual(app.posts[2].body, { action: "resolve-send", requestId: attempt.requestId, outcome });
		app.posts[2].resolve(response(outcome === "sent"
			? { notes: [{ ...note, status: "sent" }], sentRequestId: attempt.requestId }
			: { notes: [note], resolvedRequestId: attempt.requestId }));
		await setImmediate();
		assert.equal(app.node(id), undefined);
		assert.equal(drafts.has(model.sendAttemptKey(sessionId)), false);
		assert.equal(app.mainInput().value(), attempt.text);
		assert.equal(drafts.get(model.mainDraftKey(sessionId)), attempt.text);
	});
}

test("Save & send uses the invoked batch and keeps a newer main draft", async (t) => {
	const first = pending("first", "Already pending");
	const later = pending("later", "Added while saving");
	const saved = pending("saved", "New comment");
	const app = await open(t, [first]);
	app.mainInput().edit("Original main text");
	app.addComment();
	app.editComment(saved.text);
	app.click("pi-send-comment");
	assert.equal(app.posts[0].body.action, "save");
	app.mainInput().edit("Newer main text");
	app.posts[0].resolve(response({ notes: [first, later, saved], noteId: saved.id }));
	await setImmediate();
	const { body } = app.posts[1];
	assert.equal(body.text, "Original main text");
	assert.deepEqual(body.noteIds, [first.id, saved.id]);
	assert.deepEqual(body.noteVersions, [first.version, saved.version]);
	app.posts[1].resolve(response({ notes: [{ ...first, status: "sent" }, later, { ...saved, status: "sent" }], sentRequestId: body.requestId }));
	await setImmediate();
	assert.equal(app.mainInput().value(), "Newer main text");
	assert.equal(app.drafts.get(model.mainDraftKey(sessionId)), "Newer main text");
});

test("Save & send stops when another review view edits an invoked comment while saving", async (t) => {
	const first = pending("first", "Already pending");
	const edited = pending(first.id, "Edited by another view");
	const saved = pending("saved", "New comment");
	const app = await open(t, [first]);
	app.mainInput().edit("Keep the main draft");
	app.addComment();
	app.editComment(saved.text);
	app.click("pi-send-comment");
	app.posts[0].resolve(response({ notes: [edited, saved], noteId: saved.id }));
	await setImmediate();

	assert.deepEqual(app.posts.map(({ body }) => body.action), ["save"]);
	assert.match(app.text(), /changed.*before sending/i);
	assert.match(app.text(), /Edited by another view/);
	assert.match(app.text(), /New comment/);
	assert.equal(app.mainInput().value(), "Keep the main draft");
});

test("main send excludes rewritten anchors and requires legacy quotes to match", async (t) => {
	const stale = pending("stale", "Old source");
	const { sourceText, ...legacyAnchor } = anchor;
	const legacy = { ...pending("legacy", "Legacy source"), anchor: { ...legacyAnchor, quote: "Rewri" } };
	const transcript = { items: [{ id: anchor.itemId, kind: "user", label: "You", text: "Rewritten" }] };
	const blocked = await open(t, [stale, { ...pending("legacy-stale", "Legacy stale"), anchor: legacyAnchor }], undefined, new Map(), false, transcript);
	assert.equal(blocked.node("pi-send-main").handlers.on_click, undefined);
	const app = await open(t, [stale, legacy], undefined, new Map(), false, transcript);
	app.click("pi-send-main");
	await setImmediate();
	assert.deepEqual(app.posts[0].body.noteIds, [legacy.id]);
});

test("checking an absent send never dispatches and a later explicit send is separate", async (t) => {
	const attempt = { action: "send", requestId: randomUUID(), noteIds: [], noteVersions: [], text: "Previously staged" };
	const drafts = new Map([
		[model.sendAttemptKey(sessionId), JSON.stringify(attempt)],
		[model.mainDraftKey(sessionId), attempt.text],
	]);
	const app = await open(t, [], undefined, drafts);
	app.click("pi-send-main");
	assert.deepEqual(app.posts[0].body, { action: "check-send", requestId: attempt.requestId });
	app.posts[0].resolve(response({ error: "This request was not sent. Start a new send." }, 409));
	await setImmediate();
	assert.equal(app.posts.length, 1);
	assert.equal(app.mainInput().value(), attempt.text);
	assert.equal(app.node("pi-resolve-not-sent"), undefined);
	app.click("pi-send-main");
	await setImmediate();
	assert.equal(app.posts[1].body.action, "send");
	assert.notEqual(app.posts[1].body.requestId, attempt.requestId);
});

test("an independent copied comment remains editable after reopening its draft", async (t) => {
	const note = { ...pending("copy", "Original copy"), anchor: null };
	const app = await open(t, [note]);
	app.click("pi-note-copy");
	app.click("pi-edit-copy");
	app.editComment("Edited copy");
	const reopened = await open(t, [note], undefined, app.drafts);
	assert.equal(reopened.commentInput().value(), "Edited copy");
	assert.match(reopened.text(), /Independent conversation copy/);
	reopened.click("pi-save-comment");
	assert.deepEqual(reopened.posts[0].body, {
		action: "save", noteId: note.id, expectedText: note.text, anchor: null, text: "Edited copy",
	});
});

test("copy replaces an invalid identity, flushes it before posting, and reuses it after reopening", async (t) => {
	const firstFlush = Promise.withResolvers();
	const drafts = new Map([[model.copyAttemptKey(sessionId, thread.id), "incomplete-uuid"]]);
	const completed = { ...thread, turns: [{ id: "turn", status: "completed", text: "Ask", reply: "Answer" }] };
	const app = await open(t, [completed], undefined, drafts, false, { flush: () => firstFlush.promise });
	try {
		app.click("pi-note-thread");
		app.click("pi-copy-thread");
		assert.equal(app.posts.length, 0);
	} finally {
		firstFlush.resolve();
	}
	await setImmediate();
	const { body } = app.posts[0];
	assert.match(body.createId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
	app.posts[0].reject(new Error("Lost acknowledgment"));
	await setImmediate();
	const copy = { ...pending(body.createId, "Original copy"), anchor: null };
	const reopened = await open(t, [completed, copy], undefined, drafts);
	reopened.click("pi-note-thread");
	reopened.click("pi-copy-thread");
	await setImmediate();
	assert.deepEqual(reopened.posts[0].body, body);
	reopened.posts[0].resolve(response({ notes: [completed, copy], noteId: copy.id }));
	await setImmediate();
	reopened.click("pi-note-thread");
	reopened.click("pi-copy-thread");
	await setImmediate();
	assert.notEqual(reopened.posts[1].body.createId, body.createId);
});

test("an initially empty transcript activates keyboard navigation on its first message", async (t) => {
	const app = await open(t, [], undefined, new Map(), false, { items: [], updates: 1 });
	app.event({ version: 2, reset: false, items: [{ id: "item", kind: "user", label: "You", text: "👩‍💻 hello" }] });
	await setImmediate();
	assert.deepEqual(app.node("pi-markdown-item").highlights.map(({ start, end }) => [start, end]), [[0, "👩‍💻".length]]);
	app.key("v");
	assert.match(app.text(), /VISUAL/);
	assert.ok(app.node("pi-add-comment"));
});

test("a rewritten selection and a hidden tool output cannot be annotated from stale offsets", async (t) => {
	const user = { id: "item", kind: "user", label: "You", text: "Quote text" };
	const tool = { id: "tool", kind: "tool", label: "bash", text: "Tool output" };
	const app = await open(t, [], undefined, new Map(), false, { items: [user, tool], updates: 1 });
	app.key("v");
	assert.ok(app.node("pi-add-comment"));
	app.event({ version: 2, reset: true, items: [{ ...user, text: "Rewritten text" }, tool] });
	await setImmediate();
	assert.equal(app.node("pi-add-comment"), undefined);
	assert.doesNotMatch(app.text(), /\bVISUAL\b/);
	app.click("pi-tool-toggle-tool");
	app.key("shift-g");
	app.key("v");
	assert.ok(app.node("pi-add-comment"));
	app.click("pi-tool-toggle-tool");
	assert.equal(app.node("pi-add-comment"), undefined);
	assert.doesNotMatch(app.text(), /\bVISUAL\b/);
});

test("each background thread keeps its own reply and copy is the only way to snapshot it", async (t) => {
	const first = { ...thread, id: "first", turns: [{ id: "turn", status: "completed", text: "Ask", reply: "Answer" }] };
	const second = { ...thread, id: "second", turns: [] };
	const app = await open(t, [first, second]);
	app.click("pi-note-first");
	app.replyInput(0).edit("Reply to first");
	app.replyInput(0).submit({ secondary: true, shift: true }, "\n");
	await setImmediate();
	assert.equal(app.posts[0].body.noteId, "first");
	app.posts[0].resolve(response({ notes: [first, second] }));
	await setImmediate();
	app.click("pi-note-second");
	app.replyInput(1).edit("Reply to second");
	app.replyInput(1).submit({ secondary: true, shift: true }, "\n");
	await setImmediate();
	assert.equal(app.posts[1].body.noteId, "second");
	assert.equal(app.posts.length, 2);
	app.posts[1].resolve(response({ notes: [first, second] }));
	await setImmediate();
	app.click("pi-note-first");
	app.click("pi-copy-first");
	await setImmediate();
	assert.equal(app.posts.length, 3);
	assert.equal(app.posts[2].body.action, "copy");
	assert.equal(app.posts[2].body.noteId, "first");
	assert.match(app.posts[2].body.createId, /^[0-9a-f-]{36}$/i);
});

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
	assert.equal(app.focusedInput(), "Transcript");
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

test("a rendered Markdown selection keeps its quote and source range across draft recovery and editing", async (t) => {
	const sourceText = "Please **explain**";
	const quote = "Please explain";
	const items = [{ id: "item", kind: "user", label: "You", text: `${sourceText} the cache` }];
	const selection = { text: quote, range: { start: 0, end: sourceText.length }, position: { x: 280, y: 160 } };
	const expectedAnchor = { itemId: "item", ...selection.range, quote, sourceText };
	const first = await open(t, [], undefined, new Map(), false, { items });
	first.select("pi-markdown-item", selection);
	first.popupClick("pi-add-selection-comment");
	await setImmediate();
	first.editComment("Why?");

	const reopened = await open(t, [], undefined, first.drafts, false, { items });
	assert.equal(reopened.commentInput().value(), "Why?");
	assert.match(reopened.text(), /^Please explain$/m);
	reopened.click("pi-save-comment");
	assert.deepEqual(reopened.posts[0].body.anchor, expectedAnchor);
	const saved = { ...pending("saved", "Why?"), anchor: expectedAnchor };
	reopened.posts[0].resolve(response({ notes: [saved], noteId: saved.id }));
	await setImmediate();
	assert.match(reopened.text(), /^Please explain$/m);
	assert.ok(reopened.node("pi-markdown-item").highlights.some(({ start, end }) => start === 0 && end === sourceText.length));
	reopened.click("pi-edit-saved");
	reopened.editComment("Please elaborate");
	reopened.click("pi-save-comment");
	assert.deepEqual(reopened.posts[1].body, { action: "save", noteId: saved.id, expectedText: saved.text, anchor: expectedAnchor, text: "Please elaborate" });
});

test("a legacy formatted comment remains editable without inventing a source fingerprint", async (t) => {
	const items = [{ id: "item", kind: "user", label: "You", text: "**Quote**" }];
	const legacy = { ...pending("legacy", "Original"), anchor: { itemId: "item", start: 0, end: 9, quote: "Quote" } };
	const app = await open(t, [legacy], undefined, new Map(), false, { items });
	app.click("pi-note-legacy");
	app.click("pi-edit-legacy");
	app.editComment("Revised");
	app.click("pi-save-comment");
	assert.deepEqual(app.posts[0].body, { action: "save", noteId: legacy.id, expectedText: legacy.text, anchor: legacy.anchor, text: "Revised" });
});

for (const key of ["l", "v", "escape"]) {
	test(`the ${key} key dismisses a mouse selection popup`, async (t) => {
		const app = await open(t);
		app.select("pi-markdown-item", { text: "Quote", range: { start: 0, end: 5 }, position: { x: 280, y: 160 } });
		assert.ok(app.popup());
		app.key(key);
		assert.equal(app.popup(), undefined);
		assert.equal(Boolean(app.node("pi-add-comment")), key === "v");
	});
}

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
	assert.equal(app.focusedInput(), "Transcript");
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
	assert.deepEqual(app.posts[0].body.anchor, { itemId: "tool", start: 0, end: 17, quote: "Tool output Alpha", sourceText: "Tool output Alpha" });
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
	const hasNoteHighlight = () => app.node("pi-markdown-tool").highlights.some(({ start, end }) => start === 5 && end === 11);
	app.click("pi-note-saved");
	assert.ok(hasNoteHighlight());
	app.click("pi-tool-toggle-tool");
	assert.doesNotMatch(app.text(), /Tool output Alpha/);
	assert.ok(app.node("pi-note-saved"));
	app.click("pi-tool-toggle-tool");
	assert.ok(hasNoteHighlight());
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
