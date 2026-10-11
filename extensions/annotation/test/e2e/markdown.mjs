import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [url, outDir, work] = process.argv.slice(2);
if (!url || !outDir || !work) {
	console.error("usage: node markdown.mjs <annotate url> <screenshot dir> <signal dir>");
	console.error("env: PLAYWRIGHT_CORE (path to an installed playwright-core package), CHROME_BIN (Chrome or Chromium executable)");
	process.exit(2);
}
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");
mkdirSync(outDir, { recursive: true });
const origin = new URL(url).origin;
const sessionPath = new URL(url).pathname;
const allowedPaths = new Set([sessionPath, `${sessionPath}/api/snapshot`, `${sessionPath}/api/events`, `${sessionPath}/api/send`, "/frame", "/frame/mermaid.js", "/frame/frame.js"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = (name) => writeFileSync(join(work, `browser-${name}`), "ready");
const waitSignal = async (name, ms = 90_000) => {
	for (let i = 0; i < ms / 100 && !existsSync(join(work, `browser-${name}`)); i++) await sleep(100);
	if (!existsSync(join(work, `browser-${name}`))) throw new Error(`timed out waiting for ${name}`);
};

const result = { checks: {}, details: {}, screenshots: [] };
const check = (name, ok, detail) => {
	result.checks[name] = Boolean(ok);
	if (!ok) result.details[name] = detail;
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, args: ["--no-sandbox"] });

async function openPage(context, label) {
	const page = await context.newPage();
	const watch = { requests: [], console: [], errors: [] };
	await page.addInitScript(() => {
		window.__violations = [];
		document.addEventListener("securitypolicyviolation", (event) => window.__violations.push(`${event.violatedDirective} ${event.blockedURI}`));
	});
	page.on("request", (request) => watch.requests.push(request.url()));
	page.on("console", (message) => watch.console.push(`${message.type()}: ${message.text()}`));
	page.on("pageerror", (error) => watch.errors.push(String(error)));
	await page.goto(url);
	await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Live"));
	return { page, watch, label };
}

const shot = async (page, name, locator) => {
	const path = join(outDir, `${name}.png`);
	if (locator) await locator.screenshot({ path });
	else await page.screenshot({ path });
	result.screenshots.push(path);
};

async function violations(page) {
	const out = [];
	for (const frame of page.frames()) {
		try {
			out.push(...(await frame.evaluate(() => window.__violations || [])).map((item) => `${frame === page.mainFrame() ? "main" : "frame"}: ${item}`));
		} catch (error) {
			out.push(`unreadable frame: ${String(error).slice(0, 120)}`);
		}
	}
	return out;
}

async function rectOf(page, selector, needle) {
	return page.evaluate(
		([selector, needle]) => {
			const root = document.querySelector(selector);
			if (!root) return null;
			const range = document.createRange();
			if (needle === null) {
				range.selectNodeContents(root);
			} else {
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				let found = false;
				for (let node = walker.nextNode(); node && !found; node = walker.nextNode()) {
					const index = node.data.indexOf(needle);
					if (index < 0) continue;
					range.setStart(node, index);
					range.setEnd(node, index + needle.length);
					found = true;
				}
				if (!found) return null;
			}
			(needle === null ? root : range.startContainer.parentElement).scrollIntoView({ block: "center" });
			const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
			const first = rects[0];
			const last = rects.at(-1);
			return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
		},
		[selector, needle],
	);
}

async function drag(page, selector, needle) {
	const rect = await rectOf(page, selector, needle);
	if (!rect) throw new Error(`not found: ${selector} ${needle}`);
	await page.mouse.move(rect.x1, rect.y1);
	await page.mouse.down();
	await page.mouse.move(rect.x2, rect.y2, { steps: 10 });
	await page.mouse.up();
	try {
		await page.locator("#composer").waitFor({ state: "visible", timeout: 5000 });
	} catch (error) {
		const state = await page.evaluate(() => ({ selection: String(window.getSelection()), active: document.activeElement.tagName }));
		await page.screenshot({ path: join(outDir, "error.png") });
		throw new Error(`no composer after selecting ${needle}: ${JSON.stringify({ rect, state })}`);
	}
	return page.locator("#composer-quote").textContent();
}

const settled = async (page) => {
	await page.waitForFunction(() => document.querySelectorAll("iframe.diagram-frame:not(.ready)").length === 0, null, { timeout: 30_000 });
	await sleep(400);
};

async function clickSettled(page, locator) {
	for (let attempt = 0; attempt < 3; attempt++) {
		await settled(page);
		await locator.scrollIntoViewIfNeeded();
		await sleep(200);
		await locator.click();
		if (await page.locator("#composer").isVisible()) return;
	}
	throw new Error("the composer did not open");
}

const readyDiagrams = (page) => page.locator(".diagram-frame.ready").count();
const failedNotes = (page) => page.locator(".diagram-note:not([hidden])").count();

const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const { page, watch } = await openPage(context, "main");

const rendered = await page.evaluate(() => {
	const article = [...document.querySelectorAll("#conversation article.assistant")].at(-1);
	const q = (selector) => article.querySelector(selector);
	const pre = q('pre.code-block[data-lang="ts"]');
	return {
		h1: q("h1")?.textContent,
		strong: q("p strong")?.textContent,
		inlineCode: q("p code.inline-code")?.textContent,
		nested: [...article.querySelectorAll("ul > li > ul > li")].map((li) => li.textContent),
		em: q("ul ul em")?.textContent,
		tsLabel: pre?.parentElement.querySelector(".code-lang")?.textContent,
		tsText: pre?.textContent,
		tsMonospace: pre ? getComputedStyle(pre).fontFamily : null,
		tsWhiteSpace: pre ? getComputedStyle(pre).whiteSpace : null,
		tableHead: [...article.querySelectorAll("th")].map((th) => th.textContent),
		tableAlign: [...article.querySelectorAll("tbody tr:first-child td")].map((td) => getComputedStyle(td).textAlign),
		links: [...article.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent, a.rel, a.target]),
		text: article.textContent,
		imgs: document.querySelectorAll("img").length,
		svgs: document.querySelectorAll("svg").length,
		scripts: [...document.querySelectorAll("script")].map((script) => (script.nonce ? "nonce" : script.src || "inline")),
		pwned: typeof window.__pwned,
		mermaidGlobal: typeof window.mermaid,
		diagrams: article.querySelectorAll(".diagram").length,
		frameAttrs: [...document.querySelectorAll("iframe")].map((frame) => [frame.getAttribute("sandbox"), frame.getAttribute("src")]),
	};
});
check("markdown: heading, bold, inline code, nested list and emphasis", rendered.h1 === "Cache design" && rendered.strong === "two layers" && rendered.inlineCode === "LRU" && rendered.nested[0] === "compacted nightly" && rendered.em === "nightly", rendered);
check(
	"markdown: ts block keeps indentation, is monospace and has its label",
	rendered.tsLabel === "ts" && rendered.tsText.includes("\n    while (cache.size > limit) {\n        const oldest") && /mono/i.test(rendered.tsMonospace) && rendered.tsWhiteSpace === "pre",
	rendered,
);
check("markdown: table with alignment", JSON.stringify(rendered.tableHead) === '["Layer","Latency"]' && JSON.stringify(rendered.tableAlign) === '["left","right"]', rendered);
check(
	"markdown: only the https link is a link, with noopener noreferrer and a new tab; javascript: and the image stay text",
	JSON.stringify(rendered.links) === JSON.stringify([["https://example.com/cache", "the docs", "noopener noreferrer", "_blank"], ["https://example.com/logo.png", "image: logo", "noopener noreferrer", "_blank"]]) &&
		rendered.text.includes("[this](javascript:alert(1))") &&
		rendered.text.includes("<img src=x onerror=window.__pwned=1>") &&
		rendered.imgs === 0,
	rendered,
);
check("main page: no mermaid, no SVG and no script without the nonce", rendered.mermaidGlobal === "undefined" && rendered.svgs === 0 && rendered.scripts.every((kind) => kind === "nonce") && rendered.pwned === "undefined", rendered);
await shot(page, "01-markdown");

await page.waitForFunction(() => document.querySelectorAll(".diagram-frame.ready").length >= 1 && document.querySelectorAll(".diagram-note:not([hidden])").length >= 1, null, { timeout: 30_000 }).catch(() => {});
await sleep(1500);
const diagramState = await page.evaluate(() =>
	[...document.querySelectorAll(".diagram")].map((diagram) => {
		const frame = diagram.querySelector("iframe");
		const box = frame ? frame.getBoundingClientRect() : null;
		return {
			source: diagram.querySelector("pre").textContent.split("\n")[0],
			frame: frame ? { sandbox: frame.getAttribute("sandbox"), src: frame.getAttribute("src"), className: frame.className, width: box.width, height: box.height, hidden: frame.hidden } : null,
			codeHidden: diagram.querySelector(".code-wrap").hidden,
			note: diagram.querySelector(".diagram-note").hidden ? null : diagram.querySelector(".diagram-note").textContent,
		};
	}),
);
result.diagrams = diagramState;
const [flow, evil, broken] = diagramState;
check("mermaid: the flowchart renders in a sandboxed /frame iframe with a size", flow?.frame?.className === "diagram-frame ready" && flow.frame.sandbox === "allow-scripts" && flow.frame.src === "/frame" && flow.frame.width > 100 && flow.frame.height > 50 && flow.codeHidden === true, diagramState);
check("mermaid: a broken diagram falls back to its code block", broken?.frame === null && broken.codeHidden === false && /could not be rendered/.test(broken.note || ""), diagramState);
const frames = page.frames().filter((frame) => frame !== page.mainFrame());
const frameInfo = [];
for (const frame of frames) {
	try {
		frameInfo.push(
			await frame.evaluate(() => ({
				origin: self.origin,
				svgs: document.querySelectorAll("svg").length,
				imgs: document.querySelectorAll("img").length,
				scripts: document.querySelectorAll("svg script").length,
				handlers: [...document.querySelectorAll("*")].flatMap((node) => [...node.attributes].filter((attr) => /^on/i.test(attr.name) || /javascript:/i.test(attr.value)).map((attr) => `${node.tagName} ${attr.name}`)),
				pwned: typeof window.__pwned,
				text: document.body.textContent.slice(0, 200),
			})),
		);
	} catch (error) {
		frameInfo.push({ error: String(error).slice(0, 200) });
	}
}
result.frames = frameInfo;
check("mermaid: frames run in an opaque origin with no handlers, scripts or images in the SVG", frameInfo.length >= 1 && frameInfo.every((info) => info.origin === "null" && info.scripts === 0 && info.imgs === 0 && info.handlers.length === 0 && info.pwned === "undefined"), frameInfo);
check("mermaid: the malicious diagram ran nothing", evil !== undefined && (await page.evaluate(() => typeof window.__pwned)) === "undefined", { evil, frameInfo });
await shot(page, "02-diagram", page.locator(".diagram").first());
await page.locator(".diagram").nth(1).scrollIntoViewIfNeeded();
await shot(page, "03-malicious-diagram", page.locator(".diagram").nth(1));
const mainDom = await page.evaluate(() => ({ svgs: document.querySelectorAll("svg").length, imgs: document.querySelectorAll("img").length, anchorsToJs: [...document.querySelectorAll("a")].filter((a) => /^javascript:/i.test(a.getAttribute("href") || "")).length }));
check("main page: nothing from the frames reached the main DOM", mainDom.svgs === 0 && mainDom.imgs === 0 && mainDom.anchorsToJs === 0, mainDom);

await settled(page);
const tsQuote = await drag(page, 'pre.code-block[data-lang="ts"]', "while (cache.size > limit) {\n        const oldest = cache.keys().next().value;");
check("quote: a selection inside the ts block is wrapped in ```ts", tsQuote === "```ts\nwhile (cache.size > limit) {\n        const oldest = cache.keys().next().value;\n```", tsQuote);
await page.keyboard.type("why here?");
await shot(page, "04-code-selection");
await page.keyboard.press("Enter");

await clickSettled(page, page.locator(".diagram").first().locator(".diagram-quote"));
const diagramQuote = await page.locator("#composer-quote").textContent();
check("quote: Quote whole diagram adds the source wrapped in ```mermaid", diagramQuote === "```mermaid\nflowchart TD\n    A[Request] --> B{In memory?}\n    B -->|yes| C[Return value]\n    B -->|no| D[Read disk]\n    D --> C\n```", diagramQuote);
await page.keyboard.type("is the flow right?");
await shot(page, "05-quote-diagram");
await page.keyboard.press("Enter");

await settled(page);
await page.locator(".diagram").first().locator(".diagram-toggle").click();
const toggled = await page.evaluate(() => {
	const diagram = document.querySelector(".diagram");
	return { codeHidden: diagram.querySelector(".code-wrap").hidden, frameHidden: diagram.querySelector("iframe").hidden, label: diagram.querySelector(".diagram-toggle").textContent };
});
check("mermaid: Show source switches to the code block", toggled.codeHidden === false && toggled.frameHidden === true && toggled.label === "Show diagram", toggled);
const sourceQuote = await drag(page, '.diagram pre.code-block[data-lang="mermaid"]', "B -->|yes| C[Return value]");
check("quote: a selection in the diagram source is wrapped in ```mermaid", sourceQuote === "```mermaid\nB -->|yes| C[Return value]\n```", sourceQuote);
await page.keyboard.type("source view");
await page.keyboard.press("Enter");
await page.locator(".diagram").first().locator(".diagram-toggle").click();

const plainQuote = await drag(page, "#conversation article.assistant .markdown > p", null);
check("quote: a selection across bold and inline code outside code blocks is the visible text", plainQuote === "The cache has two layers and uses LRU eviction.", plainQuote);
await page.keyboard.type("plain text");
await page.keyboard.press("Enter");
check("the list holds four items", (await page.locator("#list > li").count()) === 4);
await shot(page, "06-list");
await page.locator("#send").click();
await page.waitForFunction(() => document.getElementById("status").textContent.includes("(round 1)"));
check("send: the list is cleared and the page stays open", (await page.locator("#list > li").count()) === 0);
signal("sent");

await waitSignal("live");
await page.waitForFunction(() => document.getElementById("conversation").textContent.includes("Here is the call flow:"), null, { timeout: 30_000 });
const lazy = await page.evaluate(() => [...document.querySelectorAll("#conversation article.assistant")].at(-1).querySelectorAll("iframe").length);
await page.locator("#conversation article.assistant").last().scrollIntoViewIfNeeded();
await page.waitForFunction(() => {
	const last = [...document.querySelectorAll("#conversation article.assistant")].at(-1);
	return last && last.querySelector(".diagram-frame.ready");
}, null, { timeout: 30_000 }).catch(() => {});
const live = await page.evaluate(() => {
	const last = [...document.querySelectorAll("#conversation article.assistant")].at(-1);
	const frame = last.querySelector(".diagram-frame");
	return { ready: Boolean(frame && frame.className.includes("ready")), height: frame ? frame.getBoundingClientRect().height : 0 };
});
live.framesBeforeScroll = lazy;
check("live update: a new reply with a diagram renders without a reload, once scrolled into view", live.ready && live.height > 30, live);
await page.locator("#conversation article.assistant").last().scrollIntoViewIfNeeded();
await shot(page, "07-live-diagram");
signal("live-done");

await waitSignal("tree");
await page.waitForFunction(() => document.getElementById("status").textContent.includes("conversation changed"), null, { timeout: 20_000 }).catch(() => {});
await page.waitForFunction(() => document.querySelectorAll(".diagram-frame.ready").length >= 1, null, { timeout: 30_000 }).catch(() => {});
const afterReset = await page.evaluate(() => ({
	status: document.getElementById("status").textContent,
	articles: document.querySelectorAll("#conversation article").length,
	ready: document.querySelectorAll(".diagram-frame.ready").length,
	liveGone: !document.getElementById("conversation").textContent.includes("Here is the call flow:"),
}));
check("reset: /tree reloads the conversation and renders the diagrams again", afterReset.status.includes("conversation changed") && afterReset.liveGone && afterReset.ready >= 1, afterReset);
await page.evaluate(() => window.scrollTo(0, 0));
await shot(page, "08-after-tree-reset");

const mainViolations = await violations(page);
check("CSP: no violations on the main page or in any frame", mainViolations.length === 0, mainViolations);
const cspConsole = watch.console.filter((line) => /Content Security Policy|Refused to/i.test(line));
check("CSP: no CSP messages in the console", cspConsole.length === 0, cspConsole);
const offList = watch.requests.filter((requestUrl) => {
	const parsed = new URL(requestUrl);
	return parsed.origin !== origin || !allowedPaths.has(parsed.pathname);
});
check("network: only the page, its API, /frame, /frame/frame.js and /frame/mermaid.js were requested", offList.length === 0 && watch.requests.some((u) => u.endsWith("/frame/mermaid.js")), offList.length ? offList : watch.requests.slice(0, 5));
check("no page errors", watch.errors.length === 0, watch.errors);

const stubbed = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
await stubbed.route(
	(target) => new URL(target).pathname === "/frame",
	(route) => route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'self'; sandbox allow-scripts" }, body: "<!doctype html><title>silent</title>" }),
);
const slow = await openPage(stubbed, "stub");
const startedAt = Date.now();
await slow.page.waitForFunction(() => document.querySelectorAll(".diagram-note:not([hidden])").length >= 2, null, { timeout: 25_000 }).catch(() => {});
const fallback = await slow.page.evaluate(() =>
	[...document.querySelectorAll(".diagram")].map((diagram) => ({ frame: Boolean(diagram.querySelector("iframe")), codeHidden: diagram.querySelector(".code-wrap").hidden, note: diagram.querySelector(".diagram-note").hidden ? null : diagram.querySelector(".diagram-note").textContent })),
);
const waitedMs = Date.now() - startedAt;
await slow.page.locator(".diagram").last().scrollIntoViewIfNeeded();
await slow.page.waitForFunction(() => document.querySelectorAll(".diagram-note:not([hidden])").length === document.querySelectorAll(".diagram").length, null, { timeout: 25_000 }).catch(() => {});
const allFallback = await slow.page.evaluate(() =>
	[...document.querySelectorAll(".diagram")].map((diagram) => ({ frame: Boolean(diagram.querySelector("iframe")), codeHidden: diagram.querySelector(".code-wrap").hidden, note: diagram.querySelector(".diagram-note").hidden ? null : diagram.querySelector(".diagram-note").textContent })),
);
check(
	"timeout: diagrams whose frame never answers fall back to code blocks after about 10 s, two at a time",
	fallback.filter((d) => d.note).length === 2 && waitedMs >= 9_000 && allFallback.length === 3 && allFallback.every((d) => !d.frame && !d.codeHidden && /could not be rendered/.test(d.note || "")),
	{ fallback, allFallback, waitedMs },
);
await slow.page.locator(".diagram").first().scrollIntoViewIfNeeded();
await shot(slow.page, "09-timeout-fallback", slow.page.locator(".diagram").first());
await stubbed.close();

await browser.close();
console.log(JSON.stringify(result));
