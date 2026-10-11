function createMarkdown(document) {
	"use strict";

	const SAFE_URL = /^(?:https?:\/\/[^\s<>"'`]+|mailto:[^\s<>"'`]+)$/i;
	const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
	const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
	const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
	const QUOTE = /^ {0,3}>/;
	const LIST = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
	const DELIMITER_ROW = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
	const PUNCT = /[!-\/:-@\[-`{-~]/;

	function safeHref(url) {
		const trimmed = String(url).trim();
		return SAFE_URL.test(trimmed) ? trimmed : null;
	}

	function expandTabs(line) {
		return line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, "    "));
	}

	function isBlank(line) {
		return line.trim() === "";
	}

	function indentOf(line) {
		return line.length - line.replace(/^ +/, "").length;
	}

	function stripIndent(line, count) {
		let index = 0;
		while (index < count && line[index] === " ") index++;
		return line.slice(index);
	}

	function listMarker(line) {
		if (HR.test(line)) return null;
		const match = LIST.exec(line);
		if (!match) return null;
		const content = match[4] === undefined ? "" : match[4];
		const gap = match[3] === undefined ? 1 : Math.min(match[3].length, 4);
		return {
			indent: match[1].length,
			ordered: /\d/.test(match[2]),
			start: /\d/.test(match[2]) ? parseInt(match[2], 10) : 1,
			content,
			contentIndent: match[1].length + match[2].length + gap,
		};
	}

	function splitRow(line) {
		let row = line.trim();
		if (row.startsWith("|")) row = row.slice(1);
		if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
		const cells = [];
		let cell = "";
		for (let index = 0; index < row.length; index++) {
			if (row[index] === "\\" && row[index + 1] === "|") {
				cell += "|";
				index++;
			} else if (row[index] === "|") {
				cells.push(cell.trim());
				cell = "";
			} else {
				cell += row[index];
			}
		}
		cells.push(cell.trim());
		return cells;
	}

	function tableStart(line, next) {
		if (next === undefined || !line.includes("|") || !next.includes("|") && !next.includes("-")) return false;
		if (!DELIMITER_ROW.test(next) || !next.includes("-")) return false;
		return splitRow(line).length === splitRow(next).length;
	}

	function startsBlock(line, next) {
		return FENCE_OPEN.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || listMarker(line) !== null || tableStart(line, next);
	}

	function parseList(lines, start) {
		const first = listMarker(lines[start]);
		const node = { type: "list", ordered: first.ordered, start: first.start, items: [] };
		let index = start;
		while (index < lines.length) {
			const marker = listMarker(lines[index]);
			if (!marker || marker.ordered !== first.ordered || marker.indent > first.indent + 1) break;
			const body = [marker.content];
			index++;
			while (index < lines.length) {
				const line = lines[index];
				if (isBlank(line)) {
					let ahead = index + 1;
					while (ahead < lines.length && isBlank(lines[ahead])) ahead++;
					if (ahead < lines.length && indentOf(lines[ahead]) > marker.indent && !(listMarker(lines[ahead]) && indentOf(lines[ahead]) <= first.indent + 1)) {
						while (index < ahead) {
							body.push("");
							index++;
						}
						continue;
					}
					break;
				}
				const sibling = listMarker(line);
				if (sibling && sibling.indent <= first.indent + 1) break;
				if (indentOf(line) > marker.indent) {
					body.push(stripIndent(line, marker.contentIndent));
					index++;
					continue;
				}
				if (startsBlock(line, lines[index + 1]) || body[body.length - 1] === "") break;
				body.push(line.trim());
				index++;
			}
			node.items.push({ children: parseBlocks(body) });
			let ahead = index;
			while (ahead < lines.length && isBlank(lines[ahead])) ahead++;
			const next = ahead < lines.length ? listMarker(lines[ahead]) : null;
			if (ahead > index && next && next.ordered === first.ordered && next.indent <= first.indent + 1) index = ahead;
		}
		return { node, next: index };
	}

	function parseBlocks(lines) {
		const out = [];
		let index = 0;
		while (index < lines.length) {
			const line = lines[index];
			if (isBlank(line)) {
				index++;
				continue;
			}
			let match = FENCE_OPEN.exec(line);
			if (match) {
				const indent = match[1].length;
				const fence = match[2];
				const body = [];
				index++;
				while (index < lines.length) {
					const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index]);
					if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
						index++;
						break;
					}
					body.push(stripIndent(lines[index], indent));
					index++;
				}
				out.push({ type: "code", lang: match[3], text: body.join("\n") });
				continue;
			}
			match = HEADING.exec(line);
			if (match) {
				out.push({ type: "heading", level: match[1].length, children: parseInline(match[2] || "") });
				index++;
				continue;
			}
			if (HR.test(line)) {
				out.push({ type: "hr" });
				index++;
				continue;
			}
			if (QUOTE.test(line)) {
				const body = [];
				while (index < lines.length && QUOTE.test(lines[index])) {
					body.push(lines[index].replace(/^ {0,3}> ?/, ""));
					index++;
				}
				out.push({ type: "quote", children: parseBlocks(body) });
				continue;
			}
			if (listMarker(line)) {
				const list = parseList(lines, index);
				out.push(list.node);
				index = list.next;
				continue;
			}
			if (tableStart(line, lines[index + 1])) {
				const align = splitRow(lines[index + 1]).map((cell) => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : ""));
				const width = align.length;
				const cells = (row) => {
					const raw = splitRow(row).slice(0, width);
					while (raw.length < width) raw.push("");
					return raw.map((cell) => parseInline(cell));
				};
				const header = cells(line);
				const rows = [];
				index += 2;
				while (index < lines.length && !isBlank(lines[index]) && lines[index].includes("|")) {
					rows.push(cells(lines[index]));
					index++;
				}
				out.push({ type: "table", align, header, rows });
				continue;
			}
			const para = [line.trim()];
			index++;
			while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines[index], lines[index + 1])) {
				para.push(lines[index].trim());
				index++;
			}
			out.push({ type: "paragraph", children: parseInline(para.join("\n")) });
		}
		return out;
	}

	function parse(text) {
		return parseBlocks(String(text).replace(/\r\n?/g, "\n").split("\n").map(expandTabs));
	}

	function codeSpanEnd(text, start) {
		let run = 0;
		while (text[start + run] === "`") run++;
		let index = start + run;
		while (index < text.length) {
			if (text[index] === "`") {
				let close = 0;
				while (text[index + close] === "`") close++;
				if (close === run) return { end: index, run };
				index += close;
			} else {
				index++;
			}
		}
		return { end: -1, run };
	}

	function matching(text, start, open, close) {
		let depth = 0;
		for (let index = start; index < text.length; index++) {
			const char = text[index];
			if (char === "\\") {
				index++;
			} else if (char === "`") {
				const span = codeSpanEnd(text, index);
				if (span.end >= 0) index = span.end + span.run - 1;
				else index += span.run - 1;
			} else if (char === open) {
				depth++;
			} else if (char === close) {
				depth--;
				if (depth === 0) return index;
			} else if (char === "\n" && open === "(") {
				return -1;
			}
		}
		return -1;
	}

	function linkAt(text, start) {
		const textEnd = matching(text, start, "[", "]");
		if (textEnd < 0 || text[textEnd + 1] !== "(") return null;
		const urlEnd = matching(text, textEnd + 1, "(", ")");
		if (urlEnd < 0) return null;
		let target = text.slice(textEnd + 2, urlEnd).trim();
		if (target.startsWith("<")) {
			const close = target.indexOf(">");
			target = close < 0 ? target : target.slice(1, close);
		} else {
			target = target.split(/\s+/)[0] || "";
		}
		return { label: text.slice(start + 1, textEnd), url: target, end: urlEnd + 1 };
	}

	function isWordChar(char) {
		return char !== undefined && /[\p{L}\p{N}]/u.test(char);
	}

	function findCloser(text, from, delimiter) {
		const char = delimiter[0];
		let index = from;
		while (index < text.length) {
			const current = text[index];
			if (current === "\\") {
				index += 2;
				continue;
			}
			if (current === "`") {
				const span = codeSpanEnd(text, index);
				index = span.end >= 0 ? span.end + span.run : index + span.run;
				continue;
			}
			if (current === char) {
				let run = 0;
				while (text[index + run] === char) run++;
				const before = text[index - 1];
				const after = text[index + run];
				const closable = before !== undefined && !/\s/.test(before) && !(char === "_" && isWordChar(after));
				if (closable && run === delimiter.length) return index;
				if (closable && run > delimiter.length && delimiter.length >= 2 && run === 3) return index + run - delimiter.length;
				index += run;
				continue;
			}
			index++;
		}
		return -1;
	}

	function emphasisAt(text, start) {
		const char = text[start];
		let run = 0;
		while (text[start + run] === char) run++;
		const after = text[start + run];
		if (after === undefined || /\s/.test(after)) return null;
		if (char === "_" && isWordChar(text[start - 1])) return null;
		if (char === "~") {
			if (run !== 2) return null;
			const close = findCloser(text, start + 2, "~~");
			if (close <= start + 2) return null;
			return { node: { type: "del", children: parseInline(text.slice(start + 2, close)) }, end: close + 2 };
		}
		if (run >= 3) {
			const close = findCloser(text, start + 3, char.repeat(3));
			if (close > start + 3) return { node: { type: "strong", children: [{ type: "em", children: parseInline(text.slice(start + 3, close)) }] }, end: close + 3 };
		}
		if (run >= 2) {
			const close = findCloser(text, start + 2, char.repeat(2));
			if (close > start + 2) return { node: { type: "strong", children: parseInline(text.slice(start + 2, close)) }, end: close + 2 };
		}
		if (run === 1) {
			const close = findCloser(text, start + 1, char);
			if (close > start + 1) return { node: { type: "em", children: parseInline(text.slice(start + 1, close)) }, end: close + 1 };
		}
		return null;
	}

	function parseInline(text) {
		const out = [];
		let buffer = "";
		const flush = () => {
			if (buffer !== "") out.push({ type: "text", text: buffer });
			buffer = "";
		};
		let index = 0;
		while (index < text.length) {
			const char = text[index];
			if (char === "\\" && PUNCT.test(text[index + 1] || "")) {
				buffer += text[index + 1];
				index += 2;
				continue;
			}
			if (char === "`") {
				const span = codeSpanEnd(text, index);
				if (span.end >= 0) {
					flush();
					let code = text.slice(index + span.run, span.end).replace(/\n/g, " ");
					if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
					out.push({ type: "code", text: code });
					index = span.end + span.run;
				} else {
					buffer += "`".repeat(span.run);
					index += span.run;
				}
				continue;
			}
			if (char === "!" && text[index + 1] === "[") {
				const link = linkAt(text, index + 1);
				if (link) {
					flush();
					out.push({ type: "image", alt: link.label, href: safeHref(link.url) });
					index = link.end;
					continue;
				}
			}
			if (char === "[") {
				const link = linkAt(text, index);
				if (link) {
					const href = safeHref(link.url);
					if (href) flush();
					if (href) out.push({ type: "link", href, children: parseInline(link.label) });
					else buffer += text.slice(index, link.end);
					index = link.end;
					continue;
				}
			}
			if (char === "<") {
				const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(index));
				if (auto && safeHref(auto[1])) {
					flush();
					out.push({ type: "link", href: auto[1], children: [{ type: "text", text: auto[1] }] });
					index += auto[0].length;
					continue;
				}
			}
			if ((char === "h" || char === "H") && !isWordChar(text[index - 1])) {
				const bare = /^https?:\/\/[^\s<>()\[\]"'`]+/i.exec(text.slice(index));
				if (bare) {
					const url = bare[0].replace(/[.,;:!?*_~]+$/, "");
					if (safeHref(url) && url.length > url.indexOf("//") + 2) {
						flush();
						out.push({ type: "link", href: url, children: [{ type: "text", text: url }] });
						index += url.length;
						continue;
					}
				}
			}
			if (char === "*" || char === "_" || char === "~") {
				const emphasis = emphasisAt(text, index);
				if (emphasis) {
					flush();
					out.push(emphasis.node);
					index = emphasis.end;
					continue;
				}
				let run = 0;
				while (text[index + run] === char) run++;
				buffer += char.repeat(run);
				index += run;
				continue;
			}
			buffer += char;
			index++;
		}
		flush();
		return out;
	}

	function fenced(lang, text) {
		let size = 3;
		for (const run of String(text).match(/`+/g) || []) size = Math.max(size, run.length + 1);
		const fence = "`".repeat(size);
		const body = String(text).endsWith("\n") ? String(text) : String(text) + "\n";
		return fence + (lang || "") + "\n" + body + fence;
	}

	function element(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function renderInline(nodes, parent) {
		for (const node of nodes) {
			if (node.type === "text") {
				parent.append(document.createTextNode(node.text));
			} else if (node.type === "code") {
				parent.append(element("code", "inline-code", node.text));
			} else if (node.type === "strong" || node.type === "em" || node.type === "del") {
				const wrap = element(node.type === "strong" ? "strong" : node.type === "em" ? "em" : "del");
				renderInline(node.children, wrap);
				parent.append(wrap);
			} else if (node.type === "link") {
				const link = element("a");
				link.setAttribute("href", node.href);
				link.setAttribute("rel", "noopener noreferrer");
				link.setAttribute("target", "_blank");
				renderInline(node.children, link);
				parent.append(link);
			} else if (node.type === "image") {
				const label = "image: " + (node.alt || "(no description)");
				if (node.href) {
					const link = element("a", "image-ref", label);
					link.setAttribute("href", node.href);
					link.setAttribute("rel", "noopener noreferrer");
					link.setAttribute("target", "_blank");
					parent.append(link);
				} else {
					parent.append(element("span", "image-ref", label));
				}
			}
		}
	}

	function codeBlock(lang, text, codeBlocks, options) {
		const wrap = element("div", "code-wrap");
		if (lang) wrap.append(element("span", "code-lang", lang));
		const pre = element("pre", "code-block");
		pre.setAttribute("data-lang", lang);
		pre.annotateLang = lang;
		pre.annotateSource = text;
		pre.append(element("code", "", text));
		wrap.append(pre);
		const info = { wrap, pre, lang, text };
		codeBlocks.push(info);
		return options.wrapCode ? options.wrapCode(info) : wrap;
	}

	function renderBlocks(blocks, parent, codeBlocks, options) {
		for (const block of blocks) {
			if (block.type === "paragraph") {
				const para = element("p");
				renderInline(block.children, para);
				parent.append(para);
			} else if (block.type === "heading") {
				const heading = element("h" + block.level);
				renderInline(block.children, heading);
				parent.append(heading);
			} else if (block.type === "code") {
				parent.append(codeBlock(block.lang, block.text, codeBlocks, options));
			} else if (block.type === "quote") {
				const quote = element("blockquote");
				renderBlocks(block.children, quote, codeBlocks, options);
				parent.append(quote);
			} else if (block.type === "list") {
				const list = element(block.ordered ? "ol" : "ul");
				if (block.ordered && block.start !== 1) list.setAttribute("start", String(block.start));
				for (const item of block.items) {
					const li = element("li");
					renderBlocks(item.children, li, codeBlocks, options);
					list.append(li);
				}
				parent.append(list);
			} else if (block.type === "table") {
				const wrap = element("div", "table-wrap");
				const table = element("table");
				const head = element("thead");
				const headRow = element("tr");
				block.header.forEach((cell, index) => {
					const th = element("th");
					if (block.align[index]) th.style.textAlign = block.align[index];
					renderInline(cell, th);
					headRow.append(th);
				});
				head.append(headRow);
				const body = element("tbody");
				for (const row of block.rows) {
					const tr = element("tr");
					row.forEach((cell, index) => {
						const td = element("td");
						if (block.align[index]) td.style.textAlign = block.align[index];
						renderInline(cell, td);
						tr.append(td);
					});
					body.append(tr);
				}
				table.append(head, body);
				wrap.append(table);
				parent.append(wrap);
			} else if (block.type === "hr") {
				parent.append(element("hr"));
			}
		}
	}

	function render(text, options) {
		const root = element("div", "markdown");
		const codeBlocks = [];
		renderBlocks(parse(text), root, codeBlocks, options || {});
		return { root, codeBlocks };
	}

	return { parse, parseInline, render, fenced, safeHref };
}
