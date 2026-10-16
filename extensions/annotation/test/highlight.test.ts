import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highlight, type MdStyle } from "../tui/highlight.ts";

const LETTER: Record<MdStyle, string> = {
	plain: ".",
	marker: "M",
	heading1: "1",
	heading2: "2",
	heading3: "3",
	strong: "B",
	emphasis: "i",
	strike: "S",
	code: "c",
	link: "l",
	url: "u",
	quote: "q",
	bullet: "b",
};

const marks = (text: string): string => highlight(text).map((style) => LETTER[style]).join("");

describe("highlight headings", () => {
	it("marks the hashes and styles the text by level", () => {
		assert.equal(marks("# One"), "M1111");
		assert.equal(marks("## Hi"), "MM222");
		assert.equal(marks("### Deep"), "MMM33333");
		assert.equal(marks("#### Deeper"), "MMMM3333333");
	});

	it("marks a closing hash run behind a space", () => {
		assert.equal(marks("## Hi ##"), "MM222MMM");
		assert.equal(marks("## C#"), "MM222");
	});

	it("stays plain without a space after the hashes and keeps leading spaces plain", () => {
		assert.equal(marks("#Hi"), "...");
		assert.equal(marks("  # Hi"), "..M111");
	});
});

describe("highlight emphasis", () => {
	it("marks delimiters and styles content for strong, emphasis and strike", () => {
		assert.equal(marks("**bold**"), "MMBBBBMM");
		assert.equal(marks("__bold__"), "MMBBBBMM");
		assert.equal(marks("*em*"), "MiiM");
		assert.equal(marks("_em_"), "MiiM");
		assert.equal(marks("~~gone~~"), "MMSSSSMM");
	});

	it("leaves snake_case names plain and pairs underscores at word boundaries", () => {
		assert.equal(marks("snake_case_name"), "...............");
		assert.equal(marks("foo _bar_ baz"), "....MiiiM....");
	});

	it("requires non-whitespace on the inner side of an opening and closing delimiter", () => {
		assert.equal(marks("2 * 3 * 4"), ".........");
		assert.equal(marks("match *.ts and *.js files"), ".........................");
	});

	it("styles emphasis content recursively and closes past code spans", () => {
		assert.equal(marks("**bold *it* more**"), "MMBBBBBMiiMBBBBBMM");
		assert.equal(marks("**use `x`**"), "MMBBBBMcMMM");
		assert.equal(marks("*a `*` b*"), "MiiMcMiiM");
	});

	it("closes a single delimiter around an inner double delimiter span", () => {
		assert.equal(marks("*Note: **x** y*"), "MiiiiiiMMBMMiiM");
		assert.equal(marks("*a **b** c*"), "MiiMMBMMiiM");
		assert.equal(marks("_a __b__ c_"), "MiiMMBMMiiM");
		assert.equal(marks("***x***"), ".......");
	});

	it("leaves unmatched delimiters with the base style", () => {
		assert.equal(marks("*em"), "...");
		assert.equal(marks("__bold"), "......");
		assert.equal(marks("~~gone"), "......");
	});
});

describe("highlight code spans", () => {
	it("marks the backticks and styles the span content", () => {
		assert.equal(marks("`x`"), "McM");
		assert.equal(marks("`a` and `b`"), "McM.....McM");
		assert.equal(marks("`**x**`"), "McccccM");
	});

	it("matches a backtick run of exactly the opening length", () => {
		assert.equal(marks("``a`b``"), "MMcccMM");
	});

	it("leaves unmatched backticks plain", () => {
		assert.equal(marks("a ` b"), ".....");
		assert.equal(marks("``a`x"), ".....");
	});
});

describe("highlight escapes", () => {
	it("marks a backslash before punctuation and leaves the escaped character in the base style", () => {
		assert.equal(marks("\\*lit\\*"), "M....M.");
		assert.equal(marks("> \\*x\\*"), "bbMqqMq");
	});

	it("keeps an escaped character out of code spans, links and autolinks", () => {
		assert.equal(marks("\\`x\\`"), "M..M.");
		assert.equal(marks("\\[x](u)"), "M......");
		assert.equal(marks("\\<https://a.b>"), "M.............");
	});
});

describe("highlight links", () => {
	it("marks brackets and parens, styles link text and url", () => {
		assert.equal(marks("[text](url)"), "MllllMMuuuM");
		assert.equal(marks("![alt](x)"), "MMlllMMuM");
	});

	it("parses inline styles inside link text", () => {
		assert.equal(marks("[*a*](u)"), "MMiMMMuM");
	});

	it("keeps one level of balanced parentheses inside a url", () => {
		assert.equal(marks("[x](https://e.org/F_(b))"), "MlMMuuuuuuuuuuuuuuuuuuuM");
	});

	it("styles an autolink url between marked angle brackets", () => {
		assert.equal(marks("<https://a.b>"), "MuuuuuuuuuuuM");
	});
});

describe("highlight blockquotes", () => {
	it("marks the quote run and styles the rest as quote with inline parsing", () => {
		assert.equal(marks(">x"), "bq");
		assert.equal(marks("> > x"), "bbbbq");
		assert.equal(marks(">> x"), "bbbq");
		assert.equal(marks("> **b**"), "bbMMBMM");
	});
});

describe("highlight lists", () => {
	it("marks bullets and ordered numbers", () => {
		assert.equal(marks("- item"), "b.....");
		assert.equal(marks("+ one"), "b....");
		assert.equal(marks("* x"), "b..");
		assert.equal(marks("1. one"), "bb....");
		assert.equal(marks("10) ten"), "bbb....");
	});

	it("marks a task box after the bullet and keeps the indent plain", () => {
		assert.equal(marks("- [x] done"), "bbbbb.....");
		assert.equal(marks("- [ ] todo"), "bbbbb.....");
		assert.equal(marks("  - x"), "..b..");
	});
});

describe("highlight thematic breaks", () => {
	it("marks the whole line", () => {
		assert.equal(marks("---"), "MMM");
		assert.equal(marks("***"), "MMM");
		assert.equal(marks("___"), "MMM");
		assert.equal(marks(" * * * "), "MMMMMMM");
	});
});

describe("highlight tables", () => {
	it("marks the pipes and parses cell content", () => {
		assert.equal(marks("| a | b |"), "M...M...M");
		assert.equal(marks("| *a* |"), "M.MiM.M");
		assert.equal(marks("  | a |"), "..M...M");
	});

	it("keeps an escaped pipe inside its cell", () => {
		assert.equal(marks("| `a\\|b` |"), "M.MccccM.M");
		assert.equal(marks("| a \\| b |"), "M...M....M");
	});

	it("treats a pipe after an escaped backslash as a separator", () => {
		assert.equal(marks("| a \\\\| b |"), "M...M.M...M");
		assert.equal(marks("| **a\\\\|b** |"), "M....M.M....M");
	});

	it("marks a delimiter row entirely", () => {
		assert.equal(marks("| --- | :-- |"), "MMMMMMMMMMMMM");
	});
});

describe("highlight fenced code", () => {
	it("marks the fence lines and styles every line inside as code", () => {
		assert.equal(marks("```ts\nconst a = 1;\n```"), "MMMMM.cccccccccccccMMM");
		assert.equal(marks("~~~\n*x*\n~~~"), "MMM.ccccMMM");
		assert.equal(marks("```md\n# h\n```"), "MMMMM.ccccMMM");
	});

	it("styles inline markers inside a fence as code", () => {
		assert.equal(marks("```\n**bold**\n```"), "MMM.cccccccccMMM");
	});

	it("treats a backtick fence whose info string holds a backtick as an ordinary line", () => {
		assert.equal(marks("```npm i``` first.\n# Next"), "MMMcccccMMM........M11111");
	});

	it("keeps a closing-fence line with a non-empty info string inside the block", () => {
		assert.equal(marks("```ts\nconst a = 1;\n```js\nlet b;\n```\n## After"), "MMMMM.ccccccccccccccccccccccccccMMM.MM222222");
	});

	it("scans the lines of an unclosed fence as ordinary text", () => {
		assert.equal(marks("```\n*x*"), "....MiM");
	});

	it("does not let a fence opened after a list marker swallow the text after it", () => {
		assert.equal(marks("- ```js\n  x\n  ```\nafter **b**"), "b.......................MMBMM");
	});
});

describe("highlight offsets", () => {
	it("keeps one style per UTF-16 code unit for CJK and surrogate pairs", () => {
		assert.equal(marks("# 標題"), "M111");
		assert.equal(marks("😀 **x**"), "...MMBMM");
	});

	it("returns one style per code unit for a mixed document", () => {
		const mixed = "## Title\n\n- [x] one\n> **quote**\n\n| a | b |\n| - | - |\n\n```ts\nlet x = 1;\n```\n";
		assert.equal(highlight(mixed).length, mixed.length);
		assert.deepEqual(highlight(""), []);
	});
});

describe("highlight unbalanced delimiter runs", () => {
	it("leaves unmatched mixed-length runs plain without exponential backtracking", () => {
		const twoRuns = "*a **b ".repeat(200);
		const fourRuns = "*a **b *c **d ".repeat(100);
		assert.equal(marks(twoRuns), ".".repeat(1400));
		assert.equal(marks(fourRuns), ".".repeat(1400));
		assert.equal(marks("*a **b ".repeat(2000)), ".".repeat(14000));
		assert.equal(marks("*a **b *c **d ".repeat(1000)), ".".repeat(14000));
	});
});
