import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../markdown.js", import.meta.url), "utf8");
const frameScript = readFileSync(new URL("../frame.js", import.meta.url), "utf8");
const frameHtml = readFileSync(new URL("../frame.html", import.meta.url), "utf8");

class Node {
	tag: string;
	className = "";
	text = "";
	attributes: Record<string, string> = {};
	style: Record<string, string> = {};
	children: Node[] = [];
	parentNode: Node | null = null;
	annotateLang?: string;
	annotateSource?: string;
	constructor(tag: string) {
		this.tag = tag;
	}
	set textContent(value: string) {
		this.children = [];
		this.text = String(value);
	}
	get textContent(): string {
		return this.text + this.children.map((child) => child.textContent).join("");
	}
	set innerHTML(_value: string) {
		throw new Error("innerHTML must not be used");
	}
	append(...nodes: Node[]): void {
		for (const node of nodes) node.parentNode = this;
		this.children.push(...nodes);
	}
	setAttribute(name: string, value: string): void {
		this.attributes[name] = String(value);
	}
	all(): Node[] {
		return [this, ...this.children.flatMap((child) => child.all())];
	}
	shape(): unknown {
		if (this.tag === "#text") return this.text;
		const children = this.children.map((child) => child.shape());
		const text = this.text ? [this.text] : [];
		return [this.tag, ...text, ...children];
	}
}

const document = {
	createElement: (tag: string) => new Node(tag),
	createTextNode: (text: string) => {
		const node = new Node("#text");
		node.text = String(text);
		return node;
	},
};

const context = vm.createContext({ document });
vm.runInContext(`${source}\nthis.md = createMarkdown(document);`, context);
const md = context.md as {
	render(text: string, options?: unknown): { root: Node; codeBlocks: { pre: Node; wrap: Node; lang: string; text: string }[] };
	fenced(lang: string, text: string): string;
	safeHref(url: string): string | null;
	parse(text: string): unknown;
};
const shape = (text: string) => JSON.parse(JSON.stringify(md.render(text).root.children.map((child) => child.shape())));
const ALLOWED = new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em", "del", "code", "pre", "span", "a", "blockquote", "hr", "table", "thead", "tbody", "tr", "th", "td", "#text"]);

describe("markdown renderer", () => {
	it("renders headings, paragraphs, emphasis and inline code", () => {
		assert.deepEqual(shape("# Title\n\n## Sub *it*\n\n###### six"), [["h1", "Title"], ["h2", "Sub ", ["em", "it"]], ["h6", "six"]]);
		assert.deepEqual(shape("Some **bold**, *em*, _em_, ~~gone~~, ***both*** and `a < b`.\nSecond line"), [
			["p", "Some ", ["strong", "bold"], ", ", ["em", "em"], ", ", ["em", "em"], ", ", ["del", "gone"], ", ", ["strong", ["em", "both"]], " and ", ["code", "a < b"], ".\nSecond line"],
		]);
		assert.deepEqual(shape("snake_case_name, 2 * 3 * 4, \\*not em\\*, ``a ` b``"), [["p", "snake_case_name, 2 * 3 * 4, *not em*, ", ["code", "a ` b"]]]);
	});

	it("renders unordered, ordered and nested lists", () => {
		assert.deepEqual(shape("- a\n- b\n  - c\n    1. deep\n- d"), [
			["ul", ["li", ["p", "a"]], ["li", ["p", "b"], ["ul", ["li", ["p", "c"], ["ol", ["li", ["p", "deep"]]]]]], ["li", ["p", "d"]]],
		]);
		const ordered = md.render("3. three\n4. four\n   more text\n\n5. five").root.children[0]!;
		assert.equal(ordered.tag, "ol");
		assert.equal(ordered.attributes.start, "3");
		assert.deepEqual(JSON.parse(JSON.stringify(ordered.shape())), ["ol", ["li", ["p", "three"]], ["li", ["p", "four\nmore text"]], ["li", ["p", "five"]]]);
		assert.deepEqual(shape("Steps:\n1. one\n2. two\n\nafter"), [["p", "Steps:"], ["ol", ["li", ["p", "one"]], ["li", ["p", "two"]]], ["p", "after"]]);
	});

	it("renders blockquotes, rules and tables", () => {
		assert.deepEqual(shape("> quoted **text**\n> - item\n\n---\n\n***"), [["blockquote", ["p", "quoted ", ["strong", "text"]], ["ul", ["li", ["p", "item"]]]], ["hr"], ["hr"]]);
		const table = md.render("| Name | Size |\n|:-----|-----:|\n| `a` | 1 |\n| b \\| c | 2 |").root.children[0]!;
		assert.deepEqual(JSON.parse(JSON.stringify(table.shape())), ["div", ["table", ["thead", ["tr", ["th", "Name"], ["th", "Size"]]], ["tbody", ["tr", ["td", ["code", "a"]], ["td", "1"]], ["tr", ["td", "b | c"], ["td", "2"]]]]]);
		const cells = table.all().filter((node) => node.tag === "th" || node.tag === "td");
		assert.deepEqual(cells.map((cell) => cell.style.textAlign), ["left", "right", "left", "right", "left", "right"]);
	});

	it("renders code blocks with the language label, preserved indentation and the raw source on the <pre>", () => {
		const text = "```ts\nfunction f() {\n    return `x`;\n\n}\n```\n~~~\nplain\n~~~";
		const { root, codeBlocks } = md.render(text);
		assert.deepEqual(JSON.parse(JSON.stringify(root.children.map((child) => child.shape()))), [
			["div", ["span", "ts"], ["pre", ["code", "function f() {\n    return `x`;\n\n}"]]],
			["div", ["pre", ["code", "plain"]]],
		]);
		const [ts, plain] = codeBlocks;
		assert.equal(ts!.pre.className, "code-block");
		assert.equal(ts!.pre.attributes["data-lang"], "ts");
		assert.equal(ts!.pre.annotateLang, "ts");
		assert.equal(ts!.pre.annotateSource, "function f() {\n    return `x`;\n\n}");
		assert.equal(ts!.wrap.children[0]!.className, "code-lang");
		assert.equal(plain!.pre.annotateLang, "");
		assert.equal(md.render("```js\nunclosed\nstill code").codeBlocks[0]!.text, "unclosed\nstill code");
		assert.equal(md.render("````md\n```js\ninner\n```\n````").codeBlocks[0]!.text, "```js\ninner\n```");
	});

	it("lets the caller wrap code blocks", () => {
		const seen: string[] = [];
		const { root } = md.render("```mermaid\ngraph TD\n```", {
			wrapCode: (info: { lang: string; wrap: Node }) => {
				seen.push(info.lang);
				const box = new Node("div");
				box.className = "diagram";
				box.append(info.wrap);
				return box;
			},
		});
		assert.deepEqual(seen, ["mermaid"]);
		assert.equal(root.children[0]!.className, "diagram");
	});

	it("only links http, https and mailto, with noopener noreferrer and a new tab", () => {
		const { root } = md.render("[site](https://example.com/a?b=1) <http://x.test/p> mail [me](mailto:a@b.c) and https://bare.test/path.");
		const links = root.all().filter((node) => node.tag === "a");
		assert.deepEqual(links.map((link) => [link.attributes.href, link.textContent]), [
			["https://example.com/a?b=1", "site"],
			["http://x.test/p", "http://x.test/p"],
			["mailto:a@b.c", "me"],
			["https://bare.test/path", "https://bare.test/path"],
		]);
		for (const link of links) {
			assert.equal(link.attributes.rel, "noopener noreferrer");
			assert.equal(link.attributes.target, "_blank");
		}
		assert.equal(md.safeHref(" HTTPS://EXAMPLE.COM "), "HTTPS://EXAMPLE.COM");
		for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd", "//evil.test", "/relative", "java\nscript:x", "https://a b"]) {
			assert.equal(md.safeHref(bad), null, bad);
		}
	});

	it("does not load images and shows their alt text instead", () => {
		const { root } = md.render("![diagram](https://example.com/x.png) ![local](javascript:alert(1))");
		assert.ok(!root.all().some((node) => node.tag === "img"));
		const refs = root.all().filter((node) => node.className === "image-ref");
		assert.deepEqual(refs.map((node) => [node.tag, node.textContent, node.attributes.href]), [
			["a", "image: diagram", "https://example.com/x.png"],
			["span", "image: local", undefined],
		]);
	});

	it("keeps HTML, scripts and unsafe links as inert text", () => {
		const payloads = [
			'<img src=x onerror="window.pwned=1">',
			"<script>window.pwned=1</script>",
			"# <b onclick=alert(1)>head</b>",
			"[click](javascript:alert(1))",
			"[click]( JAVASCRIPT:alert(1) )",
			"[x](data:text/html;base64,PHNjcmlwdD4=)",
			"<javascript:alert(1)>",
			"```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```",
			"| <img src=x onerror=1> | b |\n|---|---|\n| <svg onload=1> | c |",
			"> <iframe src=javascript:alert(1)>",
			"- <a href=javascript:alert(1)>x</a>",
		];
		for (const payload of payloads) {
			const { root } = md.render(payload);
			for (const node of root.all()) {
				assert.ok(ALLOWED.has(node.tag), `${payload}: ${node.tag}`);
				for (const [name, value] of Object.entries(node.attributes)) {
					assert.ok(!name.startsWith("on"), `${payload}: ${name}`);
					if (name === "href") assert.match(value, /^(https?:|mailto:)/i, payload);
				}
			}
			assert.ok(!root.all().some((node) => node.tag === "a"), payload);
		}
		assert.equal(md.render("<script>window.pwned=1</script>").root.textContent, "<script>window.pwned=1</script>");
		assert.equal(md.render("[click](javascript:alert(1))").root.textContent, "[click](javascript:alert(1))");
		assert.equal(md.render("# <b onclick=alert(1)>head</b>").root.children[0]!.textContent, "<b onclick=alert(1)>head</b>");
		assert.equal(md.render("```html\n<script>alert(1)</script>\n```").codeBlocks[0]!.pre.textContent, "<script>alert(1)</script>");
	});

	it("wraps code quotes in a fence that the code cannot close", () => {
		assert.equal(md.fenced("ts", "const a = 1;"), "```ts\nconst a = 1;\n```");
		assert.equal(md.fenced("", "x\n"), "```\nx\n```");
		assert.equal(md.fenced("md", "```js\ny\n```"), "````md\n```js\ny\n```\n````");
		assert.equal(md.fenced("mermaid", "graph TD\n  A --> B"), "```mermaid\ngraph TD\n  A --> B\n```");
	});

	it("never uses HTML-parsing sinks in the renderer or the diagram frame", () => {
		for (const [name, text] of [["markdown.js", source], ["frame.js", frameScript], ["frame.html", frameHtml]] as const) {
			for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "setAttribute(\"on", "DOMParser", "srcdoc"]) {
				assert.ok(!text.includes(sink), `${name}: ${sink}`);
			}
		}
		assert.ok(!/<\/script/i.test(source));
		assert.ok(!source.includes("__NONCE__"));
	});
});
