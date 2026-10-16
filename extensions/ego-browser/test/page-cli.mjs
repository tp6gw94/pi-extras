#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const path = process.env.EGO_PAGE_STATE;
const state = JSON.parse(await readFile(path, "utf8"));
const ready = { tagName: "DIV", innerText: "Ready", getClientRects: () => [{}], visibility: "visible" };
globalThis.location = { get href() { return state.url; } };
globalThis.document = { querySelectorAll: selector => (state.url.startsWith("http") && selector === "#ready" ? [ready] : []) };
globalThis.getComputedStyle = element => element;
const page = {
  info: async () => ({}),
  url: async () => state.url,
  snapshot: async () => "page snapshot",
  screenshot: async () => {},
  evaluate: async (fn, arg) => fn(arg),
  waitForFunction: async (fn, arg) => { if (!fn(arg)) throw new Error("condition not met"); },
  goto: async url => { state.navigations.push(url); state.url = url; return {}; },
};
const taskSpace = async () => ({ spaceId: 94, ownership: "agent", page: () => page, finish: async () => ({}) });
try {
  await new Function("taskSpace", `return (async () => {${source}\n})();`)(taskSpace);
} finally {
  await writeFile(path, JSON.stringify(state));
}
