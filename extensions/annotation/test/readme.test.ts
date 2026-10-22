import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const readRoot = (name: string) => readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8");

function headingLevels(text: string): number[] {
	const withoutFences = text.replace(/^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
	return [...withoutFences.matchAll(/^(#{1,6}) /gm)].map((m) => m[1]!.length);
}

const readmes = [
	{ file: "README.md", other: "README.zh-TW.md" },
	{ file: "README.zh-TW.md", other: "README.md" },
] as const;

function section(text: string, heading: string): string {
	const start = text.indexOf(heading);
	assert.notEqual(start, -1, heading);
	const end = text.indexOf("\n## ", start + heading.length);
	return text.slice(start, end === -1 ? undefined : end);
}

const modeKeys = ["`h` `j` `k` `l`", "`w` `b` `e`", "`0` `^` `$`", "`gg` `G`", "`{` `}`", "Ctrl-d", "Ctrl-u", "Ctrl-f", "Ctrl-b", "PageUp", "PageDown", "`v`", "`V`", "`o`", "`a`", "`A`", "Tab", "`e`", "`d`", "`s`", "`S`", "`?`", "`q`", "Esc", "Ctrl-C", "Enter", "Ctrl-J"];

const modeDocs = [
	{
		file: "README.md",
		heading: "## Quote the conversation in fullscreen mode",
		phrases: ["needs no server", "quotes the text pi draws on screen", "code fences, heading prefixes, and list markers", "A link is whatever text pi visibly renders", "with OSC 8 support the URL can be hidden", "Rows selected from their first character lose their common leading whitespace", "it can also remove indentation that the actual code shares", "fence that pi draws on the same row as a list marker", "Movement uses the measured terminal cell width", "Scroll the viewport; the caret stays until the next motion reveals it", "It uses `followUp`", "They do not survive `/reload`", "Leaving fullscreen closes it", "Use PageDown", "does not start a model turn", "editor draft stays as it is", "asks for a second press", "`pi.sendUserMessage` returns `void`", "synchronous call acceptance", "cannot restore the cleared notes", "jump-to-latest indicator is hidden", "reports Ctrl-Shift-A separately from Ctrl-A"],
		absent: ["without the URL", "take two terminal cells", "A failed send keeps them"],
	},
	{
		file: "README.zh-TW.md",
		heading: "## 在全螢幕模式引用對話",
		phrases: ["不需要伺服器", "引用 pi 畫在畫面上的文字", "程式碼 fence、標題前綴與清單標記", "連結引用的是 pi 實際畫出的文字", "有 OSC 8 支援時網址可能隱藏", "從第一個字元開始選取的列會去掉共同的前置空白", "也可能去掉程式碼本身共有的縮排", "pi 把 fence 畫在清單標記的同一列", "移動使用量測到的終端機字元格寬度", "捲動畫面；游標先不動", "它使用 `followUp`", "`/reload`、新的 session 或 pi 重新啟動之後", "離開全螢幕會關閉模式", "用 PageDown", "不會啟動模型回合", "編輯器草稿維持原樣", "要求再按一次", "`pi.sendUserMessage` 回傳 `void`", "同步呼叫被接受", "無法恢復已清除的筆記", "暫時隱藏跳到最新訊息的指示器", "把 Ctrl-Shift-A 與 Ctrl-A 分開回報"],
		absent: ["各算一個字元", "不含網址", "送出失敗會保留筆記"],
	},
] as const;

describe("annotation docs", () => {
	for (const { file, other } of readmes) {
		it(`${file} documents the web flow, the terminal view and SSH forwarding`, () => {
			const text = read(file);
			for (const needle of ["/annotate", "annotate: live on 127.0.0.1:4747", "Browser:", "Terminal:", "pi-annotation --list", "annotate: closed, port <port> released", "Server closed", "127.0.0.1", "4747", "4756", "PI_ANNOTATE_PORT", "#t=<token>", "/<session id>", "ssh -L 4747:127.0.0.1:4747 <host>", "SSH_CONNECTION", "X-Annotate-Token", "Send to pi editor", "/new", "/tree", "[paste #1]", "Show source", "Quote whole diagram", "```mermaid", "/frame", "allow-scripts", "securityLevel: \"strict\"", "5.5 MB", "grok-mermaid"]) {
				assert.ok(text.includes(needle), `${file}: ${needle}`);
			}
			assert.ok(!/alt\+q|\/quote\b|pbpaste|xclip|\/annotate tui|xdg-open/.test(text));
			assert.ok(!text.includes("/annotation-end"));
			assert.ok(text.includes(`](${other})`));
		});

		it(`the root ${file} links here instead of repeating the docs`, () => {
			const text = readRoot(file);
			assert.ok(!text.includes("## Annotation"));
			assert.ok(!text.includes("X-Annotate-Token"));
			const row = text.split("\n").find((line) => line.startsWith("| `annotation` |"));
			assert.ok(row?.includes("/annotation-mode"), `${file} annotation row names /annotation-mode`);
			assert.ok(!text.includes("PageDown"));
			assert.ok(!text.includes("followUp"));
		});
	}

	for (const { file, heading, phrases, absent } of modeDocs) {
		it(`${file} documents /annotation-mode with the supported keys and limits`, () => {
			const text = read(file);
			const intro = text.slice(0, text.indexOf("\n## "));
			assert.ok(intro.includes("/annotation-mode"), `${file}: intro names /annotation-mode`);
			const body = section(text, heading);
			for (const needle of [...modeKeys, "fullscreen", "regular", "/tree", "/reload", "compaction", ...phrases]) assert.ok(body.includes(needle), `${file}: ${needle}`);
			for (const phrase of absent) assert.ok(!body.includes(phrase), `${file}: false claim ${phrase}`);
			assert.ok(text.includes("tmux-annotation-mode.sh"), `${file}: e2e script`);
			for (const unsupported of ["`za`", "`zR`", "`zM`", "`zz`", "/annotation-end"]) assert.ok(!body.includes(unsupported), `${file}: ${unsupported}`);
		});
	}

	it("translations correspond section by section", () => {
		assert.deepEqual(headingLevels(read("README.md")), headingLevels(read("README.zh-TW.md")));
	});
});
