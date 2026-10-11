import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, url, outDir, readyFile, goFile] = process.argv.slice(2);
if (!["annotate", "switched"].includes(mode) || !url || !outDir) {
	console.error("usage: node browser.mjs annotate|switched <url> <screenshot dir> [ready file] [go file]");
	console.error("env: PLAYWRIGHT_CORE (path to an installed playwright-core package), CHROME_BIN (Chrome or Chromium executable)");
	process.exit(2);
}
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
	if (message.type() === "error") errors.push(message.text());
});
const result = { mode, errors, checks: {} };
const shot = async (name) => {
	const path = join(outDir, `${name}.png`);
	await page.screenshot({ path, fullPage: false });
	(result.screenshots ??= []).push(path);
};

async function textRect(selector, needle) {
	return page.evaluate(
		([selector, needle]) => {
			for (const root of document.querySelectorAll(selector)) {
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					const index = node.data.indexOf(needle);
					if (index < 0) continue;
					node.parentElement.scrollIntoView({ block: "center" });
					const range = document.createRange();
					range.setStart(node, index);
					range.setEnd(node, index + needle.length);
					const rects = [...range.getClientRects()];
					const first = rects[0];
					const last = rects.at(-1);
					return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
				}
			}
			return null;
		},
		[selector, needle],
	);
}

async function dragSelect(selector, needle) {
	const rect = await textRect(selector, needle);
	if (!rect) throw new Error(`text not found: ${needle}`);
	await page.mouse.move(rect.x1, rect.y1);
	await page.mouse.down();
	await page.mouse.move(rect.x2, rect.y2, { steps: 8 });
	await page.mouse.up();
	await page.locator("#composer").waitFor({ state: "visible" });
	return page.locator("#composer-quote").textContent();
}

await page.goto(url);
await page.locator("#conversation .message").first().waitFor();
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Snapshot"));
result.checks.xssInert = await page.evaluate(() => ({
	images: document.querySelectorAll("#conversation img").length,
	pwned: typeof window.__pwned,
	literal: document.getElementById("conversation").textContent.includes("<img src=x onerror=window.__pwned=1>"),
}));
result.checks.tokenRemoved = !page.url().includes("token") && (await page.evaluate(() => location.href)) === new URL("/", url).href;
result.checks.toolCollapsed = await page.evaluate(() => [...document.querySelectorAll("#conversation details")].every((d) => !d.open));
await shot(mode === "annotate" ? "01-page" : "s1-page");

if (mode === "annotate") {
	result.selected = [];
	result.selected.push(await dragSelect("#conversation .assistant .text", "The cache is LRU."));
	await page.keyboard.type("why LRU?");
	await shot("02-composer");
	await page.keyboard.press("Enter");
	await page.locator("#conversation details summary").first().click();
	result.checks.toolExpanded = await page.evaluate(() => document.querySelector("#conversation details").open);
	result.selected.push(await dragSelect("#conversation details .text", "cache-hit-ratio 0.93"));
	await page.keyboard.type("line one");
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.type("line two");
	await page.keyboard.press("Enter");
	result.selected.push(await dragSelect("#conversation .assistant .text", "oldest entry"));
	await page.keyboard.type("discarded");
	await page.keyboard.press("Escape");
	result.checks.escDiscarded = (await page.locator("#list > li").count()) === 2;
	result.selected.push(await dragSelect("#conversation .assistant .text", "It evicts"));
	await page.keyboard.type("to delete");
	await page.keyboard.press("Enter");
	await page.locator("#list > li").first().locator("textarea").fill("why LRU and not LFU?");
	await shot("03-list");
	await page.locator("#list > li").nth(2).getByRole("button", { name: "Delete" }).click();
	result.checks.listCount = await page.locator("#list > li").count();
	await page.locator("#send").click();
	await page.locator(".done").waitFor();
	result.doneText = await page.locator(".done").textContent();
	await shot("04-done");
} else {
	await dragSelect("#conversation .assistant .text", "The cache is LRU.");
	await page.keyboard.type("too late");
	await page.keyboard.press("Enter");
	writeFileSync(readyFile, "ready");
	for (let i = 0; i < 300 && !existsSync(goFile); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	await page.locator("#send").click();
	await page.waitForFunction(() => document.getElementById("status").className === "error");
	result.statusText = await page.locator("#status").textContent();
	result.sendDisabled = await page.locator("#send").isDisabled();
	await shot("s2-switched");
}

await browser.close();
console.log(JSON.stringify(result));
