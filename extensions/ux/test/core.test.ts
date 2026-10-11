import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CLIPBOARD_TOOLS, clipboardFailureMessage, readClipboard, type ExecFn } from "../core/clipboard.ts";
import { DEFAULT_KEYS, isValidKey, parseConfig } from "../core/config.ts";
import { lastUserPrompt, PromptPin } from "../core/prompt-state.ts";
import { formatQuote } from "../core/quote.ts";
import { collapsedLine, ELLIPSIS, expandedLines, oneLine, stripControls } from "../core/summary.ts";

describe("collapsed summary", () => {
	it("is one line: newlines and runs of spaces collapse", () => {
		assert.equal(oneLine("  fix the\n\n  build\tplease  "), "fix the build please");
		assert.equal(collapsedLine("a\nb", 80), "❯ a b");
	});

	it("fits the terminal width and ends with … when cut", () => {
		const long = "word ".repeat(100);
		for (const width of [10, 40, 79, 120]) {
			const line = collapsedLine(long, width);
			assert.ok(visibleWidth(line) <= width, `width ${width}: got ${visibleWidth(line)}`);
			assert.ok(line.endsWith(ELLIPSIS));
		}
		assert.equal(collapsedLine("short", 80), "❯ short");
		assert.ok(!collapsedLine("short", 80).includes(ELLIPSIS));
	});

	it("counts CJK characters as two columns", () => {
		const cjk = "請幫我把這個函式改成非同步並補上測試"; // 18 chars, 36 columns
		const line = collapsedLine(cjk, 20);
		assert.ok(visibleWidth(line) <= 20, `got ${visibleWidth(line)}`);
		assert.ok(line.endsWith(ELLIPSIS));
		assert.ok(line.length < 20, "would overflow if CJK counted as width 1");
		assert.equal(collapsedLine("短", 10), "❯ 短");
	});

	it("handles tiny widths", () => {
		assert.equal(collapsedLine("abc", 0), "");
		assert.ok(visibleWidth(collapsedLine("abcdef", 3)) <= 3);
	});
});

describe("expanded view", () => {
	it("shows every line, wrapped to the width", () => {
		const lines = expandedLines("first line\n\nthird line that is quite long indeed", 20);
		assert.equal(lines[0], "│ first line");
		assert.equal(lines[1], "│ ");
		assert.ok(lines.length >= 4);
		for (const l of lines) assert.ok(visibleWidth(l) <= 20, l);
		assert.ok(lines.join(" ").includes("indeed"));
	});

	it("wraps CJK by display width", () => {
		for (const l of expandedLines("一二三四五六七八九十一二三四五六七八九十", 12)) assert.ok(visibleWidth(l) <= 12, l);
	});
});

describe("control characters in the pinned prompt", () => {
	const ESC = "\u001b";
	const hostile = `before${ESC}[2J${ESC}[H${ESC}]0;pwned title\u0007middle${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}[31mred${ESC}[0m after`;
	const noControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

	it("strips CSI (ESC[2J, cursor home, SGR) and OSC (title, hyperlink) sequences", () => {
		assert.equal(stripControls(hostile), "beforemiddlelink red after");
		assert.equal(oneLine(hostile), "beforemiddlelink red after");
	});

	it("strips C0 controls, DEL and C1 controls but keeps newlines and turns tabs into spaces", () => {
		const text = "a\u0000b\u0007c\u0008d\u007fe\u009b2Jf\u0085g\th\r\ni\rj";
		assert.equal(stripControls(text), "abcde2Jfg    h\ni\nj");
		assert.ok(!noControls.test(stripControls(text)));
	});

	it("drops a lone ESC, an ESC + final byte, and an unterminated OSC", () => {
		assert.equal(stripControls(`x${ESC}`), "x");
		assert.equal(stripControls(`x${ESC}cy${ESC}(Bz`), "xyz");
		assert.equal(stripControls(`x${ESC}]0;never ends`), "x");
	});

	it("collapsed and expanded views never contain ESC or control characters from the prompt", () => {
		const prompt = `clear${ESC}[2J now\nline two${ESC}]2;title\u0007 ok\u0001\u009d`;
		const collapsed = collapsedLine(prompt, 80);
		assert.equal(collapsed, "❯ clear now line two ok");
		const expanded = expandedLines(prompt, 80);
		assert.deepEqual(expanded, ["│ clear now", "│ line two ok"]);
		for (const l of [collapsed, ...expanded]) {
			assert.ok(!l.includes(ESC) && !noControls.test(l), JSON.stringify(l));
		}
	});

	it("keeps CJK, emoji and the width math intact", () => {
		const line = collapsedLine(`${ESC}[1m第二行：請用英文回答${ESC}[0m 🙂`, 12);
		assert.ok(visibleWidth(line) <= 12);
		assert.ok(line.endsWith(ELLIPSIS));
		assert.ok(!line.includes(ESC));
	});
});

describe("prompt pin: toggle state and source filtering", () => {
	it("pins interactive input only", () => {
		const pin = new PromptPin();
		assert.equal(pin.fromInput("hello", "interactive"), true);
		assert.equal(pin.fromInput("[pi-hooks] Checks failed…", "extension"), false);
		assert.equal(pin.fromInput("from rpc client", "rpc"), false);
		assert.equal(pin.text, "hello");
	});

	it("ignores blank input", () => {
		const pin = new PromptPin();
		pin.fromInput("keep", "interactive");
		assert.equal(pin.fromInput("   \n", "interactive"), false);
		assert.equal(pin.text, "keep");
	});

	it("toggles expanded and collapsed; a new prompt starts collapsed", () => {
		const pin = new PromptPin();
		assert.equal(pin.toggle(), undefined); // nothing pinned
		pin.fromInput("one", "interactive");
		assert.equal(pin.expanded, false);
		assert.equal(pin.toggle(), true);
		assert.equal(pin.toggle(), false);
		pin.toggle();
		pin.fromInput("two", "interactive");
		assert.equal(pin.expanded, false);
	});

	it("restore sets or clears the pin", () => {
		const pin = new PromptPin();
		pin.restore("from history");
		assert.equal(pin.text, "from history");
		pin.restore(undefined);
		assert.equal(pin.text, undefined);
	});
});

describe("session resume: last user prompt", () => {
	const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });
	it("picks the last user message, skipping assistant, custom and non-message entries", () => {
		const entries = [
			user("first prompt"),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
			user([
				{ type: "text", text: "second" },
				{ type: "image", data: "…" },
				{ type: "text", text: "prompt" },
			]),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "long reply" }] } },
			{ type: "message", message: { role: "custom", content: "[pi-hooks] Checks failed" } },
			{ type: "custom", customType: "x" },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
		];
		assert.equal(lastUserPrompt(entries), "second\nprompt");
	});

	it("skips empty user messages and returns undefined for a new session", () => {
		assert.equal(lastUserPrompt([user("real"), user([{ type: "image" }])]), "real");
		assert.equal(lastUserPrompt([]), undefined);
	});
});

describe("quote formatting", () => {
	it("prefixes every line with '> ' and ends with one blank line", () => {
		assert.equal(formatQuote("a\nb"), "> a\n> b\n\n");
		assert.equal(formatQuote("only"), "> only\n\n");
	});

	it("keeps inner blank lines, drops trailing whitespace and CRLF", () => {
		assert.equal(formatQuote("a\r\n\r\nb\r\n\r\n  \n"), "> a\n> \n> b\n\n");
		assert.equal(formatQuote("\n\nlead"), "> lead\n\n");
	});

	it("starts on a new line after typed text that does not end with a newline", () => {
		assert.equal(formatQuote("x", "Explain this:"), "\n> x\n\n");
		assert.equal(formatQuote("x", "Explain this:\n"), "> x\n\n");
		assert.equal(formatQuote("x", ""), "> x\n\n");
	});

	it("returns undefined for empty or whitespace-only text", () => {
		assert.equal(formatQuote(""), undefined);
		assert.equal(formatQuote(" \n\t\n"), undefined);
	});
});

describe("clipboard fallback", () => {
	function fakeExec(results: Record<string, { code: number; stdout?: string; killed?: boolean } | "throw">) {
		const calls: string[] = [];
		const exec: ExecFn = async (command, _args, options) => {
			calls.push(command);
			assert.ok(options?.timeout && options.timeout <= 2000, "every tool gets a short timeout");
			const r = results[command] ?? { code: 127 }; // not installed
			if (r === "throw") throw new Error("spawn failed");
			return { stdout: r.stdout ?? "", stderr: "", code: r.code, killed: r.killed ?? false };
		};
		return { exec, calls };
	}

	it("tries pbpaste, wl-paste, xclip, xsel in that order", () => {
		assert.deepEqual(
			CLIPBOARD_TOOLS.map((t) => t.name),
			["pbpaste", "wl-paste", "xclip", "xsel"],
		);
		assert.deepEqual(CLIPBOARD_TOOLS.find((t) => t.name === "xclip")?.args, ["-selection", "clipboard", "-o"]);
	});

	it("uses the first tool that succeeds", async () => {
		const { exec, calls } = fakeExec({ xclip: { code: 0, stdout: "copied" }, xsel: { code: 0, stdout: "other" } });
		assert.deepEqual(await readClipboard(exec), { ok: true, text: "copied", tool: "xclip" });
		assert.deepEqual(calls, ["pbpaste", "wl-paste", "xclip"]);
	});

	it("moves on after a failure, a timeout or a spawn error", async () => {
		const { exec, calls } = fakeExec({
			pbpaste: "throw",
			"wl-paste": { code: 0, stdout: "late", killed: true },
			xclip: { code: 1 },
			xsel: { code: 0, stdout: "from xsel" },
		});
		assert.deepEqual(await readClipboard(exec), { ok: true, text: "from xsel", tool: "xsel" });
		assert.equal(calls.length, 4);
	});

	it("reports an empty clipboard without trying more tools", async () => {
		const { exec, calls } = fakeExec({ pbpaste: { code: 0, stdout: "  \n" } });
		const r = await readClipboard(exec);
		assert.deepEqual(r, { ok: false, reason: "empty", tool: "pbpaste", tried: ["pbpaste"] });
		assert.deepEqual(calls, ["pbpaste"]);
		assert.match(clipboardFailureMessage(r as never), /clipboard is empty/);
	});

	it("reports when no tool works", async () => {
		const { exec } = fakeExec({});
		const r = await readClipboard(exec);
		assert.deepEqual(r, { ok: false, reason: "unavailable", tried: ["pbpaste", "wl-paste", "xclip", "xsel"] });
		assert.match(clipboardFailureMessage(r as never), /tried pbpaste, wl-paste, xclip, xsel/);
	});
});

describe("config", () => {
	it("uses the defaults without a file", () => {
		assert.deepEqual(parseConfig(undefined).config.keys, { ...DEFAULT_KEYS });
	});

	it("overrides and disables keys", () => {
		const { config, errors } = parseConfig('{"keys":{"togglePrompt":"ctrl+alt+p","quoteClipboard":null}}');
		assert.deepEqual(errors, []);
		assert.equal(config.keys.togglePrompt, "ctrl+alt+p");
		assert.equal(config.keys.quoteClipboard, undefined);
		assert.equal(parseConfig('{"keys":{"quoteClipboard":""}}').config.keys.quoteClipboard, undefined);
	});

	it("rejects bad keys and unknown names but keeps going", () => {
		const { config, errors } = parseConfig('{"keys":{"togglePrompt":"hyper+p","quote":"alt+x"},"theme":1}');
		assert.equal(config.keys.togglePrompt, DEFAULT_KEYS.togglePrompt);
		assert.equal(errors.length, 3);
		assert.equal(parseConfig("{oops").errors.length, 1);
	});

	it("validates pi key syntax", () => {
		for (const k of ["alt+p", "ctrl+shift+x", "f5", "ctrl+]", "super+k", "alt+q", "ctrl++"]) assert.ok(isValidKey(k), k);
		for (const k of ["hyper+p", "alt+alt+p", "", "ctrl+"]) assert.ok(!isValidKey(k), k);
	});
});
