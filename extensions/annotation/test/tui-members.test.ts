import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { bindSelectionHook, POSITION_MEMBER, PRIVATE_MEMBERS, REQUIRED_MEMBERS, type SelectionEnd } from "../selection-hook.ts";
import { drag, piTuiReference, settle, startAltScreen, startMainScreen } from "./harness.ts";

describe("pi-tui TuiAltScreen still has the members annotation uses", () => {
	it("has every required and private member as a method", () => {
		for (const name of [...REQUIRED_MEMBERS, ...PRIVATE_MEMBERS]) {
			assert.equal(typeof (TuiAltScreen.prototype as any)[name], "function", `TuiAltScreen.${name} is gone or renamed`);
		}
		assert.deepEqual(
			[...PRIVATE_MEMBERS].sort(),
			["clearTextSelection", "copySelectionToClipboard", "getActiveSelectionText", "handleSelectionMouseEvent"],
		);
		assert.equal(POSITION_MEMBER, "handleSelectionMouseEvent");
	});

	it("reports mode fullscreen, and terminal.columns/rows for placement", () => {
		const alt = startAltScreen({ copyOnSelect: true });
		try {
			assert.equal((alt.screen as any).mode, "fullscreen");
			assert.equal(alt.screen.terminal.columns, 80);
			assert.equal(alt.screen.terminal.rows, 24);
		} finally {
			alt.stop();
		}
	});
});

for (const copyOnSelect of [true, false]) {
	describe(`selection hook on a real TuiAltScreen behind pi's proxy, copy-on-select ${copyOnSelect ? "on" : "off"}`, () => {
		it("reports the selected text and release point, copies only when the user wants it, and restores on release", async () => {
			const alt = startAltScreen({ copyOnSelect });
			const reference = await piTuiReference();
			const proxy = reference(() => alt.screen) as any;
			const ends: SelectionEnd[] = [];
			try {
				await settle();
				const bound = bindSelectionHook(proxy, (end) => ends.push(end));
				assert.equal(bound.kind, "bound");
				if (bound.kind !== "bound") return;
				assert.equal(bound.hook.isCurrent(), true);
				assert.equal(proxy.getCopyOnSelect(), copyOnSelect, "pi still sees the user's setting");
				assert.deepEqual(bound.hook.screen(), { columns: 80, rows: 24 });

				drag(alt.send, [6, 0], [5, 1]);
				await settle();
				assert.deepEqual(ends, [{ text: "beta gamma delta\nsecond", point: { x: 5, y: 1, pressY: 0 } }]);
				assert.deepEqual(alt.copied, copyOnSelect ? ["beta gamma delta\nsecond"] : []);
				assert.equal((alt.screen as any).getActiveSelectionText(), "beta gamma delta\nsecond", "the selection stays until the box closes");
				bound.hook.clear();
				assert.equal((alt.screen as any).getActiveSelectionText(), undefined);

				drag(alt.send, [10, 2], [0, 1]);
				await settle();
				assert.deepEqual(ends[1]?.point, { x: 0, y: 1, pressY: 2 }, "an upward drag keeps the press row");

				proxy.setCopyOnSelect(!copyOnSelect);
				assert.equal(proxy.getCopyOnSelect(), !copyOnSelect);
				drag(alt.send, [0, 0], [4, 0]);
				await settle();
				assert.equal(ends.length, 3, "the box still opens after the user flips copy-on-select");
				assert.equal(alt.copied.length, (copyOnSelect ? 1 : 0) + (copyOnSelect ? 1 : 0) + (copyOnSelect ? 0 : 1));

				bound.hook.release();
				assert.equal(bound.hook.isCurrent(), false);
				assert.equal(proxy.getCopyOnSelect(), !copyOnSelect, "release puts the user's setting back on the renderer");
				for (const name of ["copySelectionToClipboard", "handleSelectionMouseEvent", "getCopyOnSelect", "setCopyOnSelect"]) {
					assert.ok(!Object.prototype.hasOwnProperty.call(alt.screen, name), `${name} still patched`);
				}
				drag(alt.send, [0, 0], [4, 0]);
				await settle();
				assert.equal(ends.length, 3, "no selection reported after release");
			} finally {
				alt.stop();
			}
		});
	});
}

describe("selection hook outside fullscreen or on a changed pi", () => {
	it("does nothing on the regular screen", () => {
		const main = startMainScreen();
		try {
			assert.deepEqual(bindSelectionHook(main.screen, () => {}), { kind: "not-fullscreen" });
		} finally {
			main.stop();
		}
	});

	it("names the missing members when a required one is gone", () => {
		const fake = { mode: "fullscreen", getCopyOnSelect() {}, setCopyOnSelect() {}, requestRender() {}, clearTextSelection() {} };
		assert.deepEqual(bindSelectionHook(fake, () => {}), { kind: "missing", members: ["copySelectionToClipboard", "getActiveSelectionText"] });
	});

	it("still reports selections without a release point when only handleSelectionMouseEvent is gone", async () => {
		const alt = startAltScreen({ copyOnSelect: true });
		const ends: SelectionEnd[] = [];
		try {
			await settle();
			const withoutPosition = new Proxy(alt.screen, {
				get: (target, prop) => (prop === "handleSelectionMouseEvent" ? undefined : Reflect.get(target, prop)),
			});
			const bound = bindSelectionHook(withoutPosition, (end) => ends.push(end));
			assert.equal(bound.kind, "bound");
			assert.ok(!Object.prototype.hasOwnProperty.call(alt.screen, "handleSelectionMouseEvent"));
			drag(alt.send, [0, 0], [4, 0]);
			await settle();
			assert.deepEqual(ends, [{ text: "alpha", point: undefined }]);
		} finally {
			alt.stop();
		}
	});
});
