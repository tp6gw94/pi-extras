import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { annotationBlock, annotationsText, formatQuote } from "../quote.ts";

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

describe("annotation blocks", () => {
	it("is the quote, then the note, then a blank line", () => {
		assert.equal(annotationBlock({ quote: "line one\nline two", note: "why is this here?" }), "> line one\n> line two\n\nwhy is this here?\n\n");
	});

	it("keeps multi-line notes and still inserts the quote when the note is blank", () => {
		assert.equal(annotationBlock({ quote: "sel", note: "a\nb\n" }), "> sel\n\na\nb\n\n");
		assert.equal(annotationBlock({ quote: "sel", note: "   " }), "> sel\n\n");
	});

	it("strips terminal control sequences from quote and note", () => {
		assert.equal(annotationBlock({ quote: "\x1b[31mred\x1b[0m\x07", note: "n\x1b]0;title\x07ote\x1b[201~" }), "> red\n\nnote\n\n");
	});

	it("skips items whose quote is empty after stripping", () => {
		assert.equal(annotationBlock({ quote: "\x1b[0m \n", note: "note" }), undefined);
	});
});

describe("annotations text", () => {
	it("joins all items in list order into one insert", () => {
		const text = annotationsText([
			{ quote: "first", note: "one" },
			{ quote: "second", note: "" },
			{ quote: "third\nmore", note: "three" },
		]);
		assert.equal(text, "> first\n\none\n\n> second\n\n> third\n> more\n\nthree\n\n");
	});

	it("adds one leading newline after editor text without a trailing newline", () => {
		assert.equal(annotationsText([{ quote: "a", note: "" }, { quote: "b", note: "" }], "draft"), "\n> a\n\n> b\n\n");
		assert.equal(annotationsText([{ quote: "a", note: "" }], "draft\n"), "> a\n\n");
	});

	it("returns undefined when nothing is left to insert", () => {
		assert.equal(annotationsText([]), undefined);
		assert.equal(annotationsText([{ quote: " ", note: "x" }]), undefined);
	});
});
