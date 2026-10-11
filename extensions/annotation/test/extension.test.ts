import assert from "node:assert/strict";
import { describe, it } from "node:test";
import annotation, { isStaleContextError } from "../index.ts";
import { drag, piTuiReference, settle, startAltScreen, startMainScreen } from "./harness.ts";

type Handler = (...args: any[]) => any;
const theme = { fg: (_c: string, s: string) => s };

function setup(tui: unknown, opts: { mode?: string; editorText?: string; ui?: Record<string, Handler> } = {}) {
	const on: Record<string, Handler> = {};
	const pi = {
		on: (event: string, h: Handler) => {
			on[event] = h;
		},
		registerShortcut: () => assert.fail("annotation registers no shortcut"),
		registerCommand: () => assert.fail("annotation registers no command"),
		sendUserMessage: () => assert.fail("annotation never submits"),
	};
	const calls = { pasted: [] as string[], notes: [] as string[], overlays: [] as any[], inputs: [] as Handler[] };
	let box: any;
	let resolveBox: (v: unknown) => void = () => {};
	const ctx = {
		hasUI: true,
		mode: opts.mode ?? "tui",
		ui: {
			setWidget: (_key: string, content: unknown) => {
				if (typeof content === "function") content(tui, theme);
			},
			notify: (m: string) => calls.notes.push(m),
			onTerminalInput: (h: Handler) => {
				calls.inputs.push(h);
				return () => calls.inputs.splice(calls.inputs.indexOf(h), 1);
			},
			getEditorText: () => opts.editorText ?? "",
			pasteToEditor: (t: string) => calls.pasted.push(t),
			setEditorText: () => assert.fail("annotation must not replace the editor text"),
			custom: (factory: Handler, options: any) => {
				calls.overlays.push(options);
				return new Promise((resolve) => {
					resolveBox = resolve;
					box = factory(tui, theme, undefined, resolve);
				});
			},
			...opts.ui,
		},
	};
	annotation(pi as any);
	return {
		on,
		ctx,
		calls,
		type: (data: string) => box.handleInput(data),
		box: () => box,
		cancelPending: () => resolveBox({ kind: "cancel" }),
	};
}

async function altBehindProxy(copyOnSelect = true) {
	const alt = startAltScreen({ copyOnSelect });
	const reference = await piTuiReference();
	await settle();
	return { alt, proxy: reference(() => alt.screen) };
}

describe("annotation wiring", () => {
	it("opens the box under the selection, and Enter inserts quote + note without submitting, then clears the selection", async () => {
		const { alt, proxy } = await altBehindProxy();
		try {
			const t = setup(proxy, { editorText: "draft" });
			t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
			drag(alt.send, [6, 0], [5, 1]);
			await settle();
			assert.deepEqual(alt.copied, ["beta gamma delta\nsecond"], "copy-on-select still copies");
			assert.equal(t.calls.overlays.length, 1);
			assert.deepEqual(t.calls.overlays[0], { overlay: true, overlayOptions: { width: 60, row: 2, col: 5 } });
			const lines: string[] = t.box().render(60);
			assert.equal(lines.length, 7);
			assert.ok(lines[0]!.includes(" Annotate "));
			assert.ok(lines.some((l) => l.includes("│ beta gamma delta")));
			assert.ok(lines.at(-2)!.includes("Enter insert · Esc cancel"));
			t.type("explain");
			t.type("\r");
			await settle();
			assert.deepEqual(t.calls.pasted, ["\n> beta gamma delta\n> second\n\nexplain\n\n"]);
			assert.equal((alt.screen as any).getActiveSelectionText(), undefined, "selection cleared");
		} finally {
			alt.stop();
		}
	});

	it("Enter with no note still inserts the quote", async () => {
		const { alt, proxy } = await altBehindProxy();
		try {
			const t = setup(proxy);
			t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
			drag(alt.send, [0, 2], [3, 2]);
			await settle();
			t.type("\r");
			await settle();
			assert.deepEqual(t.calls.pasted, ["> thir\n\n"]);
		} finally {
			alt.stop();
		}
	});

	it("Esc closes the box, discards the note and clears the selection", async () => {
		const { alt, proxy } = await altBehindProxy();
		try {
			const t = setup(proxy);
			t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
			drag(alt.send, [0, 0], [4, 0]);
			await settle();
			t.type("never mind");
			t.type("\x1b");
			await settle();
			assert.deepEqual(t.calls.pasted, []);
			assert.equal((alt.screen as any).getActiveSelectionText(), undefined);
		} finally {
			alt.stop();
		}
	});

	it("opens the box without copying when the user turned copy-on-select off", async () => {
		const { alt, proxy } = await altBehindProxy(false);
		try {
			const t = setup(proxy);
			t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
			drag(alt.send, [0, 0], [4, 0]);
			await settle();
			assert.deepEqual(alt.copied, []);
			assert.equal(t.calls.overlays.length, 1);
			t.cancelPending();
		} finally {
			alt.stop();
		}
	});

	it("opens one box at a time", async () => {
		const { alt, proxy } = await altBehindProxy();
		try {
			const t = setup(proxy);
			t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
			drag(alt.send, [0, 0], [4, 0]);
			await settle();
			drag(alt.send, [0, 1], [4, 1]);
			await settle();
			assert.equal(t.calls.overlays.length, 1);
			t.cancelPending();
		} finally {
			alt.stop();
		}
	});

	it("session_shutdown unhooks the renderer", async () => {
		const { alt, proxy } = await altBehindProxy();
		try {
			const t = setup(proxy);
			t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
			t.on.session_shutdown!({ type: "session_shutdown" }, t.ctx);
			assert.ok(!Object.prototype.hasOwnProperty.call(alt.screen, "copySelectionToClipboard"));
			assert.deepEqual(t.calls.inputs, []);
			drag(alt.send, [0, 0], [4, 0]);
			await settle();
			assert.equal(t.calls.overlays.length, 0);
		} finally {
			alt.stop();
		}
	});

	it("rebinds on the next key after pi swaps the renderer", async () => {
		const first = startAltScreen({ copyOnSelect: true });
		const second = startAltScreen({ copyOnSelect: true });
		let current = first.screen;
		const reference = await piTuiReference();
		const proxy = reference(() => current);
		try {
			await settle();
			const t = setup(proxy);
			t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
			current = second.screen;
			t.calls.inputs[0]!("x");
			drag(second.send, [0, 0], [4, 0]);
			await settle();
			assert.equal(t.calls.overlays.length, 1);
			t.cancelPending();
		} finally {
			first.stop();
			second.stop();
		}
	});
});

describe("annotation outside fullscreen", () => {
	it("does nothing and says nothing on the regular screen", () => {
		const main = startMainScreen();
		try {
			const t = setup(main.screen);
			t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
			assert.deepEqual(t.calls.notes, []);
		} finally {
			main.stop();
		}
	});

	it("does nothing without a TUI", () => {
		const t = setup(undefined, { mode: "rpc" });
		t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
		assert.deepEqual(t.calls.inputs, []);
		assert.deepEqual(t.calls.notes, []);
	});

	it("turns itself off with one notice when pi-tui lost a member", () => {
		const fake = { mode: "fullscreen", getCopyOnSelect() {}, setCopyOnSelect() {}, requestRender() {}, getActiveSelectionText() {} };
		const t = setup(fake);
		t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
		t.calls.inputs[0]!("a");
		t.on.session_start!({ type: "session_start", reason: "new" }, t.ctx);
		assert.equal(t.calls.notes.length, 1);
		assert.match(t.calls.notes[0]!, /annotation: turned off\. .*copySelectionToClipboard, clearTextSelection/);
	});
});

const STALE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

async function withoutUnhandledRejections(run: (rejections: unknown[]) => Promise<void>) {
	const rejections: unknown[] = [];
	const listener = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", listener);
	try {
		await run(rejections);
		await settle();
		await settle();
		assert.deepEqual(rejections, [], "no unhandled rejection");
	} finally {
		process.off("unhandledRejection", listener);
	}
}

describe("annotation errors never escape", () => {
	it("recognizes pi's stale ctx error only", () => {
		assert.equal(isStaleContextError(new Error(STALE)), true);
		assert.equal(isStaleContextError(new Error("boom")), false);
		assert.equal(isStaleContextError(STALE), false);
	});

	it("ignores a stale ctx when the box closes after /new or resume, and still clears the selection", async () => {
		await withoutUnhandledRejections(async () => {
			const { alt, proxy } = await altBehindProxy();
			try {
				const t = setup(proxy, {
					ui: {
						getEditorText: () => {
							throw new Error(STALE);
						},
					},
				});
				t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
				drag(alt.send, [0, 0], [4, 0]);
				await settle();
				t.type("\r");
				await settle();
				assert.deepEqual(t.calls.pasted, []);
				assert.deepEqual(t.calls.notes, [], "a stale ctx is expected after a session switch, so no notice");
				assert.equal((alt.screen as any).getActiveSelectionText(), undefined);
			} finally {
				alt.stop();
			}
		});
	});

	it("ignores a stale ctx thrown by pasteToEditor", async () => {
		await withoutUnhandledRejections(async () => {
			const { alt, proxy } = await altBehindProxy();
			try {
				const t = setup(proxy, {
					ui: {
						pasteToEditor: () => {
							throw new Error(STALE);
						},
					},
				});
				t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
				drag(alt.send, [0, 0], [4, 0]);
				await settle();
				t.type("\r");
				await settle();
				assert.deepEqual(t.calls.notes, []);
			} finally {
				alt.stop();
			}
		});
	});

	it("notifies once when custom throws, keeps working, and never rethrows", async () => {
		await withoutUnhandledRejections(async () => {
			const { alt, proxy } = await altBehindProxy();
			try {
				let calls = 0;
				const t = setup(proxy, {
					ui: {
						custom: () => {
							calls++;
							throw new Error("overlay exploded");
						},
					},
				});
				t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
				drag(alt.send, [0, 0], [4, 0]);
				await settle();
				drag(alt.send, [0, 1], [4, 1]);
				await settle();
				assert.equal(calls, 2, "a failed box does not block the next selection");
				assert.equal(t.calls.notes.length, 1, "one notice, not one per selection");
				assert.match(t.calls.notes[0]!, /annotation: the annotation box failed: overlay exploded/);
				assert.equal((alt.screen as any).getActiveSelectionText(), undefined);
			} finally {
				alt.stop();
			}
		});
	});

	it("notifies once when pasteToEditor throws something else, and a rejected custom is handled too", async () => {
		await withoutUnhandledRejections(async () => {
			const { alt, proxy } = await altBehindProxy();
			try {
				const t = setup(proxy, {
					ui: {
						pasteToEditor: () => {
							throw new Error("editor gone");
						},
					},
				});
				t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
				drag(alt.send, [0, 0], [4, 0]);
				await settle();
				t.type("\r");
				await settle();
				assert.equal(t.calls.notes.length, 1);
				assert.match(t.calls.notes[0]!, /editor gone/);

				const r = setup(proxy, { ui: { custom: () => Promise.reject(new Error("rejected overlay")) } });
				t.on.session_shutdown!({ type: "session_shutdown" }, t.ctx);
				r.on.session_start!({ type: "session_start", reason: "startup" }, r.ctx);
				drag(alt.send, [0, 1], [4, 1]);
				await settle();
				assert.equal(r.calls.notes.length, 1);
				assert.match(r.calls.notes[0]!, /rejected overlay/);
			} finally {
				alt.stop();
			}
		});
	});

	it("does not throw when even the notice fails", async () => {
		await withoutUnhandledRejections(async () => {
			const { alt, proxy } = await altBehindProxy();
			try {
				const t = setup(proxy, {
					ui: {
						custom: () => {
							throw new Error("overlay exploded");
						},
						notify: () => {
							throw new Error(STALE);
						},
					},
				});
				t.on.session_start!({ type: "session_start", reason: "startup" }, t.ctx);
				drag(alt.send, [0, 0], [4, 0]);
				await settle();
			} finally {
				alt.stop();
			}
		});
	});
});
