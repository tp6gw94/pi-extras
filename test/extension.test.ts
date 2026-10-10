import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Point pi's agent dir at an empty temp dir before the extension loads its config.
const agentDir = mkdtempSync(join(tmpdir(), "pi-ux-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

type Handler = (...args: any[]) => any;

function fakePi(clipboard: string | undefined) {
	const on: Record<string, Handler> = {};
	const shortcuts: Record<string, Handler> = {};
	const commands: Record<string, Handler> = {};
	const pi = {
		on: (event: string, h: Handler) => {
			on[event] = h;
			return () => {};
		},
		registerShortcut: (key: string, o: { handler: Handler }) => {
			shortcuts[key] = o.handler;
		},
		registerCommand: (name: string, o: { handler: Handler }) => {
			commands[name] = o.handler;
		},
		exec: async (command: string) =>
			command === "xclip" && clipboard !== undefined
				? { stdout: clipboard, stderr: "", code: 0, killed: false }
				: { stdout: "", stderr: "not found", code: 127, killed: false },
	};
	return { pi, on, shortcuts, commands };
}

function fakeCtx(editorText = "", branch: unknown[] = []) {
	const calls: { pasted: string[]; setText: string[]; notes: string[]; widgets: unknown[] } = {
		pasted: [],
		setText: [],
		notes: [],
		widgets: [],
	};
	const ctx = {
		hasUI: true,
		cwd: tmpdir(),
		sessionManager: { getBranch: () => branch },
		ui: {
			getEditorText: () => editorText,
			pasteToEditor: (t: string) => calls.pasted.push(t),
			setEditorText: (t: string) => calls.setText.push(t),
			notify: (m: string) => calls.notes.push(m),
			setWidget: (key: string, content: unknown, opts: unknown) => calls.widgets.push({ key, content, opts }),
		},
	};
	return { ctx, calls };
}

const theme = { fg: (_c: string, s: string) => s };

function renderWidget(w: any, width = 60): string[] {
	return w.content(undefined, theme).render(width);
}

describe("extension wiring (fake pi)", () => {
	let piUx: (pi: any) => void;
	before(async () => {
		piUx = (await import("../ux-pi/index.ts")).default;
	});
	after(() => rmSync(agentDir, { recursive: true, force: true }));

	it("registers alt+p, alt+q and /quote by default", () => {
		const f = fakePi("x");
		piUx(f.pi);
		assert.deepEqual(Object.keys(f.shortcuts).sort(), ["alt+p", "alt+q"]);
		assert.ok(f.commands.quote);
		assert.ok(f.on.input && f.on.session_start);
	});

	it("quote inserts with pasteToEditor, never setEditorText, and keeps typed text", async () => {
		const f = fakePi("line one\nline two\n");
		piUx(f.pi);
		const { ctx, calls } = fakeCtx("Explain this:");
		await f.shortcuts["alt+q"]!(ctx);
		assert.deepEqual(calls.pasted, ["\n> line one\n> line two\n\n"]);
		assert.deepEqual(calls.setText, []);
		const c2 = fakeCtx("");
		await f.commands.quote!("", c2.ctx);
		assert.deepEqual(c2.calls.pasted, ["> line one\n> line two\n\n"]);
		assert.deepEqual(c2.calls.setText, []);
	});

	it("an empty or unreadable clipboard notifies and inserts nothing", async () => {
		for (const clip of ["", undefined]) {
			const f = fakePi(clip);
			piUx(f.pi);
			const { ctx, calls } = fakeCtx("typed");
			await f.shortcuts["alt+q"]!(ctx);
			assert.deepEqual(calls.pasted, []);
			assert.deepEqual(calls.setText, []);
			assert.equal(calls.notes.length, 1);
			assert.match(calls.notes[0]!, /Nothing inserted/);
		}
	});

	it("pins interactive input above the editor and ignores extension input", () => {
		const f = fakePi("x");
		piUx(f.pi);
		const { ctx, calls } = fakeCtx();
		assert.deepEqual(f.on.input!({ type: "input", text: "my prompt", source: "interactive" }, ctx), { action: "continue" });
		assert.deepEqual(f.on.input!({ type: "input", text: "[pi-hooks] fix", source: "extension" }, ctx), { action: "continue" });
		assert.equal(calls.widgets.length, 1);
		const w = calls.widgets[0] as any;
		assert.equal(w.key, "pi-ux:prompt");
		assert.deepEqual(w.opts, { placement: "aboveEditor" });
		assert.deepEqual(renderWidget(w), ["❯ my prompt"]);
	});

	it("the toggle shortcut re-renders expanded and collapsed", () => {
		const f = fakePi("x");
		piUx(f.pi);
		const { ctx, calls } = fakeCtx();
		f.on.input!({ type: "input", text: "line 1\nline 2", source: "interactive" }, ctx);
		f.shortcuts["alt+p"]!(ctx);
		assert.deepEqual(renderWidget(calls.widgets.at(-1)), ["▾ Last prompt (alt+p to collapse)", "│ line 1", "│ line 2"]);
		f.shortcuts["alt+p"]!(ctx);
		assert.deepEqual(renderWidget(calls.widgets.at(-1)), ["❯ line 1 line 2"]);
	});

	it("session_start restores the last user prompt from the branch", () => {
		const f = fakePi("x");
		piUx(f.pi);
		const { ctx, calls } = fakeCtx("", [
			{ type: "message", message: { role: "user", content: "resumed prompt" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "a" }] } },
		]);
		f.on.session_start!({ type: "session_start", reason: "resume" }, ctx);
		assert.deepEqual(renderWidget(calls.widgets.at(-1)), ["❯ resumed prompt"]);
		const empty = fakeCtx();
		f.on.session_start!({ type: "session_start", reason: "new" }, empty.ctx);
		assert.equal((empty.calls.widgets.at(-1) as any).content, undefined);
	});

	it("reads keys from <agent-dir>/pi-ux.json", () => {
		writeFileSync(join(agentDir, "pi-ux.json"), '{"keys":{"togglePrompt":"ctrl+alt+p","quoteClipboard":"ctrl+alt+p"}}');
		try {
			const f = fakePi("x");
			piUx(f.pi);
			// a duplicate key keeps the first action and disables the second
			assert.deepEqual(Object.keys(f.shortcuts), ["ctrl+alt+p"]);
			const { ctx, calls } = fakeCtx();
			f.on.session_start!({ type: "session_start", reason: "startup" }, ctx);
			assert.match(calls.notes[0]!, /already used by togglePrompt/);
		} finally {
			rmSync(join(agentDir, "pi-ux.json"));
		}
	});
});
