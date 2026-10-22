import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Container, ScrollView, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { attach, type Attachment, type BlockRegistry, type Hooks, isRefusal } from "../mode/host.ts";
import { paintRows } from "../mode/paint.ts";
import { hostHarness, linesComponent, settle } from "./mode-harness.ts";

const registry = (): BlockRegistry => ({ blocks: new WeakMap(), nextBlock: 1 });
const hooks = (overrides: Partial<Hooks> = {}): Hooks => ({
	onCapture: () => {},
	paint: (rows, doc) => paintRows(rows, doc, { caret: { row: 0, char: 6 }, selected: [{ row: 1, from: 0, to: 4 }], noted: [{ row: 2, from: 0, to: 4 }] }, { caret: "\x1b[7m", selected: "\x1b[48;5;24m", noted: "\x1b[4m" }),
	alive: () => true,
	onEvicted: () => {},
	onFullscreenLeft: () => {},
	...overrides,
});
const attached = (t: ReturnType<typeof hostHarness>, callbacks = hooks(), blocks = registry()): Attachment => {
	const result = attach(t.tui, blocks, callbacks);
	assert.ok(!isRefusal(result));
	return result;
};

describe("annotation host", () => {
	it("decorates actual scroll content without changing text, widths, row counts or header rows", () => {
		const t = hostHarness();
		const before = t.content();
		const a = attached(t);
		const after = t.content();
		assert.deepEqual(after.map(stripTerminalSequences), before.map(stripTerminalSequences));
		assert.deepEqual(after.map(visibleWidth), before.map(visibleWidth));
		assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
		assert.match(after[2], /\x1b\[7m中/);
		assert.match(after[3], /\x1b\[48;5;24m/);
		assert.match(after[4], /\x1b\[4m/);
		assert.equal(a.doc.width, 120);
		assert.equal(a.doc.rowCount, 3);
		assert.equal(t.resets(), 1);
		a.detach();
		assert.deepEqual(t.content(), before);
	});

	it("reads chat-local geometry from the last document layout as the header grows", () => {
		const t = hostHarness();
		const a = attached(t);
		assert.deepEqual(a.viewport(), { top: -2, height: 21 });
		t.header.addChild(linesComponent(["Extra", "Header"]));
		t.draw();
		assert.deepEqual(a.viewport(), { top: -4, height: 21 });
		a.detach();
	});

	it("disables follow even when scrolling to the maximum and keeps the captured primary view", () => {
		const t = hostHarness({ rows: 12, messages: [linesComponent(Array.from({ length: 30 }, (_, index) => `row ${index}`))] });
		assert.equal(t.view.isFollowingEnd, true);
		const a = attached(t, hooks({ paint: (rows) => rows }));
		assert.equal(t.view.isFollowingEnd, false);
		t.tui.getPrimaryScrollView = () => new ScrollView(new Container());
		a.scrollTo(0);
		assert.equal(t.view.scrollTop, 2);
		assert.equal(a.viewport().top, 0);
		a.scrollTo(999);
		assert.equal(t.view.scrollTop, 23);
		assert.equal(t.view.isFollowingEnd, false);
		t.draw();
		assert.equal(t.view.isFollowingEnd, false);
		a.detach();
		assert.equal(t.view.isFollowingEnd, true);
	});

	it("restores the render property and detaches idempotently", () => {
		const t = hostHarness();
		const original = t.chat.render;
		const descriptor = Object.getOwnPropertyDescriptor(t.chat, "render");
		const a = attached(t);
		assert.notEqual(t.chat.render, original);
		a.detach();
		const requests = t.requests.length;
		a.detach();
		assert.equal(t.chat.render, original);
		assert.deepEqual(Object.getOwnPropertyDescriptor(t.chat, "render"), descriptor);
		assert.equal(t.requests.length, requests);
	});

	it("preserves another wrapper above it and becomes an undecorated passthrough", () => {
		const t = hostHarness();
		const before = t.chat.render(120);
		const original = t.chat.render;
		t.chat.render = (width) => original.call(t.chat, width);
		const own = t.chat.render;
		const first = attached(t);
		first.detach();
		assert.equal(t.chat.render, own);
		const a = attached(t);
		const wrapped = t.chat.render;
		const second = (width: number) => [...wrapped(width), "another extension"];
		t.chat.render = second;
		a.detach();
		assert.equal(t.chat.render, second);
		assert.deepEqual(t.chat.render(120), [...before, "another extension"]);
	});

	it("leaves regular-mode rows untouched and retires only after rendering completes", async () => {
		const t = hostHarness();
		const original = t.chat.render;
		const before = t.content();
		let finished = 0;
		attached(t, hooks({ onFullscreenLeft: () => { finished++; } }));
		t.requests.length = 0;
		t.tui.mode = "regular";
		assert.deepEqual(t.content(), before);
		assert.deepEqual(t.content(), before);
		assert.equal(finished, 0);
		assert.equal(t.view.isFollowingEnd, false);
		assert.equal(t.requests.length, 0);
		await settle();
		assert.equal(finished, 1);
		assert.equal(t.chat.render, original);
		assert.equal(t.view.isFollowingEnd, true);
		assert.ok(t.requests.every((request) => !request.duringRender));
	});

	it("queues eviction cleanup and never scrolls or requests a render inside the wrapper", async () => {
		const t = hostHarness();
		const original = t.chat.render;
		let evicted = 0;
		attached(t, hooks({ alive: (frame) => frame <= 2, onEvicted: () => { evicted++; } }));
		t.draw();
		t.draw();
		t.requests.length = 0;
		t.draw();
		assert.equal(evicted, 0);
		assert.equal(t.view.isFollowingEnd, false);
		assert.equal(t.requests.length, 0);
		await settle();
		assert.equal(evicted, 1);
		assert.equal(t.chat.render, original);
		assert.ok(t.requests.every((request) => !request.duringRender));
	});

	it("does not run a queued completion after an explicit abandonment", async () => {
		const t = hostHarness();
		let finished = 0;
		const a = attached(t, hooks({ onFullscreenLeft: () => { finished++; } }));
		t.tui.mode = "regular";
		t.draw();
		a.detach();
		await settle();
		assert.equal(finished, 0);
	});

	it("re-primes auxiliary-width captures from the original render at the document width", () => {
		const widths: number[] = [];
		const t = hostHarness({ columns: 40, messages: [{ render: (width) => { widths.push(width); return [`width ${width}`]; }, invalidate: () => {} }] });
		const a = attached(t, hooks({ paint: (rows) => rows }));
		t.chat.render(12);
		assert.equal(widths.at(-1), 12);
		assert.equal(a.doc.width, 40);
		assert.equal(a.doc.text(0).text, "width 40");
		assert.equal(widths.at(-1), 40);
		a.detach();
	});

	it("reuses session block identities across attachment, including zero-height children", () => {
		const t = hostHarness();
		t.chat.addChild(new Container());
		const blocks = registry();
		const first = attached(t, hooks(), blocks);
		const ids = first.doc.blocks.map(({ id, height }) => ({ id, height }));
		first.detach();
		const second = attached(t, hooks(), blocks);
		assert.deepEqual(second.doc.blocks.map(({ id, height }) => ({ id, height })), ids);
		assert.equal(ids.at(-1)!.height, 0);
		second.detach();
		t.chat.children[0] = linesComponent(["replacement"]);
		const third = attached(t, hooks({ paint: (rows) => rows }), blocks);
		assert.notEqual(third.doc.blocks[0].id, ids[0].id);
		third.detach();
	});

	for (const failure of ["regular", "document", "chat", "layout", "getter", "view", "selection", "request"] as const) {
		it(`refuses an unsupported ${failure} before installing a wrapper`, () => {
			const t = hostHarness();
			const original = t.chat.render;
			switch (failure) {
				case "regular": t.tui.mode = "regular"; break;
				case "document": t.tui.children = []; break;
				case "chat": t.document.children = []; break;
				case "layout": Reflect.deleteProperty(t.document, "mouseLayout"); break;
				case "getter": Reflect.deleteProperty(t.tui, "getPrimaryScrollView"); break;
				case "view": t.tui.getPrimaryScrollView = () => ({}); break;
				case "selection": Reflect.deleteProperty(t.tui, "resetTextSelection"); break;
				case "request": Reflect.deleteProperty(t.tui, "requestRender"); break;
			}
			const result = attach(t.tui, registry(), hooks());
			assert.ok(isRefusal(result));
			assert.ok(result.refused.length > 0);
			assert.equal(t.chat.render, original);
			assert.equal(t.resets(), 0);
		});
	}
});
