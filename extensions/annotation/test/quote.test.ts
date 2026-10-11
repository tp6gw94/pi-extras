import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { annotationText, formatQuote } from "../quote.ts";

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

describe("annotation text", () => {
	it("is the quote, then the note, then a blank line", () => {
		assert.equal(annotationText("line one\nline two", "why is this here?"), "> line one\n> line two\n\nwhy is this here?\n\n");
	});

	it("still inserts the quote when the note is empty or blank", () => {
		assert.equal(annotationText("sel", ""), "> sel\n\n");
		assert.equal(annotationText("sel", "   "), "> sel\n\n");
	});

	it("starts on a new line after editor text without a trailing newline", () => {
		assert.equal(annotationText("sel", "note", "draft"), "\n> sel\n\nnote\n\n");
	});

	it("returns undefined for an empty selection", () => {
		assert.equal(annotationText(" \n", "note"), undefined);
	});
});
