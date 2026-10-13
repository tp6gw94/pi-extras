import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, url, outDir, ...files] = process.argv.slice(2);
if (!["live", "switched", "closed", "reload"].includes(mode) || !url || !outDir) {
	console.error("usage: node browser.mjs live <url> <screenshot dir> <round 2 ready file> <round 3 ready file> <tree go file>");
	console.error("       node browser.mjs switched <url> <screenshot dir> <ready file> <go file>");
	console.error("       node browser.mjs closed <url> <screenshot dir> <ready file>");
	console.error("       node browser.mjs reload <url> <screenshot dir> <ready file> <restarted file>");
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

const pendingHighlight = () =>
	page.evaluate(() => {
		const highlight = CSS.highlights.get("annotate-pending");
		return highlight ? [...highlight].map((range) => range.toString()) : null;
	});

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForFile = async (file, ms) => {
	for (let i = 0; i < ms / 100 && !existsSync(file); i++) await sleep(100);
	if (!existsSync(file)) throw new Error(`timed out waiting for ${file}`);
};
const messages = () => page.locator("#conversation article").count();
const closedState = () =>
	page.evaluate(() => {
		const list = document.getElementById("list");
		const items = [...list.querySelectorAll("li")];
		const range = document.createRange();
		range.selectNodeContents(list);
		const selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
		const copied = selection.toString();
		selection.removeAllRanges();
		return {
			status: document.getElementById("status").textContent,
			sendDisabled: document.getElementById("send").disabled,
			count: items.length,
			quotes: items.map((item) => item.querySelector("blockquote").textContent),
			notes: items.map((item) => item.querySelector("textarea").value),
			notesEditable: items.every((item) => !item.querySelector("textarea").disabled && !item.querySelector("textarea").readOnly),
			copied,
		};
	});
const listState = async (round) => ({
	count: await page.locator("#list > li").count(),
	round: (await page.locator("#status").textContent()).includes(`(round ${round})`),
	sendDisabled: await page.locator("#send").isDisabled(),
	messages: await messages(),
});
const sendRound = async (round) => {
	await page.locator("#send").click();
	await page.waitForFunction((round) => document.getElementById("status").textContent.includes(`(round ${round})`), round);
	return listState(round);
};

await page.goto(url);
await page.locator("#conversation .message").first().waitFor();
await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Live"));
result.checks.xssInert = await page.evaluate(() => ({
	images: document.querySelectorAll("#conversation img").length,
	pwned: typeof window.__pwned,
	literal: document.getElementById("conversation").textContent.includes("<img src=x onerror=window.__pwned=1>"),
}));
result.checks.href = await page.evaluate(() => location.href);
result.checks.tokenRemoved = result.checks.href === url.split("#")[0] && !result.checks.href.includes("t=");
result.checks.toolCollapsed = await page.evaluate(() => [...document.querySelectorAll("#conversation details")].every((d) => !d.open));
await shot(mode === "live" ? "01-page" : "s1-page");

if (mode === "live") {
	const [round2Ready, round3Ready, treeGo] = files;
	result.selected = [];
	result.selected.push(await dragSelect("#conversation .assistant .text", "The cache is LRU."));
	await page.keyboard.type("why LRU?");
	result.checks.highlightWhileOpen = await pendingHighlight();
	result.checks.focusInNote = await page.evaluate(() => document.activeElement.id === "note");
	await shot("02-composer");
	await page.keyboard.press("Enter");
	result.checks.highlightAfterEnter = await pendingHighlight();
	await page.locator("#conversation details summary").first().click();
	result.checks.toolExpanded = await page.evaluate(() => document.querySelector("#conversation details").open);
	result.selected.push(await dragSelect("#conversation details .text", "cache-hit-ratio 0.93"));
	await page.keyboard.type("line one");
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.type("line two");
	await page.keyboard.press("Enter");
	result.selected.push(await dragSelect("#conversation .assistant .text", "oldest entry"));
	await page.keyboard.type("discarded");
	result.checks.highlightBeforeEsc = await pendingHighlight();
	await page.keyboard.press("Escape");
	result.checks.highlightAfterEsc = await pendingHighlight();
	result.checks.escDiscarded = (await page.locator("#list > li").count()) === 2;
	result.selected.push(await dragSelect("#conversation .assistant .text", "It evicts"));
	await page.keyboard.type("to delete");
	await page.keyboard.press("Enter");
	await page.locator("#list > li").first().locator("textarea").fill("why LRU and not LFU?");
	await shot("03-list");
	await page.locator("#list > li").nth(2).getByRole("button", { name: "Delete" }).click();
	result.checks.listCount = await page.locator("#list > li").count();
	result.checks.afterRound1 = await sendRound(1);
	await shot("04-round1-sent");
	result.selected.push(await dragSelect("#conversation .assistant .text", "It evicts the oldest entry first."));
	await page.keyboard.type("round two");
	await page.keyboard.press("Enter");
	result.checks.afterRound2 = await sendRound(2);
	await shot("05-round2-sent");
	writeFileSync(round2Ready, "ready");
	await page.waitForFunction(() => document.getElementById("conversation").textContent.includes("Old keys leave in order."), null, { timeout: 60_000 });
	await page.waitForFunction(() => document.querySelectorAll("#conversation article").length === 6);
	result.checks.liveUpdate = {
		messages: await messages(),
		last: await page.locator("#conversation article").last().locator(".text").textContent(),
		status: (await page.locator("#status").textContent()).startsWith("Live · 6 messages"),
	};
	await shot("06-live-update");
	result.selected.push(await dragSelect("#conversation .assistant .text", "Old keys leave in order."));
	await page.keyboard.type("round three");
	await shot("07-round3-composer");
	await page.keyboard.press("Enter");
	result.checks.afterRound3 = await sendRound(3);
	await shot("08-round3-sent");
	writeFileSync(round3Ready, "ready");
	await waitForFile(treeGo, 60_000);
	await page.waitForFunction(() => document.querySelectorAll("#conversation article").length === 2, null, { timeout: 15_000 });
	result.checks.treeReset = {
		messages: await messages(),
		status: (await page.locator("#status").textContent()).includes("conversation changed"),
	};
	await shot("09-tree-reset");
} else if (mode === "reload") {
	const [readyFile, restartedFile] = files;
	const sid = new URL(url).pathname.slice(1);
	const storageState = () => page.evaluate(() => ({ session: { ...sessionStorage }, local: localStorage.length, cookie: document.cookie, href: location.href, history: history.length }));
	result.checks.stored = await storageState();
	await page.reload();
	await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Live"));
	result.checks.afterReload = await storageState();
	result.checks.afterReload.status = await page.locator("#status").textContent();
	await page.locator("#conversation .message").first().waitFor();
	await dragSelect("#conversation .assistant .text", "Checking the cache stats.");
	await page.keyboard.type("after reload");
	await page.keyboard.press("Enter");
	result.checks.reloadSend = await sendRound(1);
	await shot("r1-reloaded-sent");
	const fresh = await browser.newContext();
	const other = await fresh.newPage();
	await other.goto(url.split("#")[0]);
	await other.waitForFunction(() => document.getElementById("status").textContent.length > 0);
	result.checks.freshTab = await other.evaluate(() => ({ status: document.getElementById("status").textContent, sendDisabled: document.getElementById("send").disabled, stored: sessionStorage.length }));
	await other.screenshot({ path: join(outDir, "r2-fresh-tab.png") });
	await fresh.close();
	writeFileSync(readyFile, "ready");
	await waitForFile(restartedFile, 60_000);
	errors.length = 0;
	await page.reload();
	await page.waitForFunction(() => document.getElementById("status").textContent.includes("no longer valid"), null, { timeout: 15_000 });
	result.checks.stale = {
		status: await page.locator("#status").textContent(),
		sendDisabled: await page.locator("#send").isDisabled(),
		stored: await page.evaluate((sid) => sessionStorage.getItem("annotate-token:" + sid), sid),
	};
	await page.waitForTimeout(3000);
	result.checks.staleRequests = 0;
	page.on("request", () => result.checks.staleRequests++);
	await page.waitForTimeout(3000);
	await shot("r3-stale-token");
} else if (mode === "closed") {
	const [readyFile] = files;
	errors.length = 0;
	await dragSelect("#conversation .assistant .text", "That is not a command I know.");
	await page.keyboard.type("keep me");
	await page.keyboard.press("Enter");
	await page.locator("#list > li").first().waitFor();
	result.before = await closedState();
	writeFileSync(readyFile, "ready");
	await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Server closed"), null, { timeout: 30_000 });
	result.closed = await closedState();
	await shot("c1-server-closed");
} else {
	const [readyFile, goFile] = files;
	errors.length = 0;
	await dragSelect("#conversation .assistant .text", "Checking the cache stats.");
	await page.keyboard.type("too late");
	await page.keyboard.press("Enter");
	writeFileSync(readyFile, "ready");
	await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Server closed"), null, { timeout: 30_000 });
	result.closed = await closedState();
	await shot("s2-server-closed");
	await waitForFile(goFile, 60_000);
	if (!(await page.locator("#send").isDisabled())) await page.locator("#send").click().catch(() => {});
	await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("Session switched"), null, { timeout: 15_000 });
	result.statusText = await page.locator("#status").textContent();
	result.sendDisabled = await page.locator("#send").isDisabled();
	await shot("s3-switched");
}

await browser.close();
console.log(JSON.stringify(result));
