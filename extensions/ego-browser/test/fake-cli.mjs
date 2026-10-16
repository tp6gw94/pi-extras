#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
let source = "";
for await (const chunk of process.stdin) source += chunk;
const path = process.env.EGO_FAKE_STATE;
const state = JSON.parse(await readFile(path, "utf8"));
const save = async () => { const next = `${path}.${process.pid}.tmp`; await writeFile(next, JSON.stringify(state)); await rename(next, path); };
const receipt = async () => { state.mutations = (state.mutations ?? 0) + 1; await save(); return state.prompt ? { dialog: {} } : {}; };
const page = {
  info: async () => {
    if (state.error) throw new Error(state.error);
    return state.dialog ? { dialog: {} } : {};
  },
  url: async () => state.url,
  snapshot: async () => "button [ref=7] Submit\nopaque vendor snapshot <not JSON>",
  screenshot: async ({path}) => writeFile(path, "fake image"),
  evaluate: async (_fn, c) => ({ url: state.url, documentId: state.documentId ?? "fake-document", controls: Object.fromEntries(c.candidates.map(item => [item.id, {eligible: !state.unsupported, value: state.value ?? "", version: state.version ?? 0}])), checks: c.checks.map(({id,condition}) => ({id, expected:condition, actual:state.done ? "Order confirmed" : null, status:state.done ? "pass" : "fail"})) }),
  goto: async url => { state.url = url; return receipt(); },
  fill: async (_target, value) => { state.value = value; return receipt(); },
  click: async () => { state.done = !state.noComplete; if (state.delay) { await receipt(); await new Promise(resolve => setTimeout(resolve, state.delay)); } return receipt(); },
  selectOption: async () => receipt(),
  press: async () => receipt(),
  waitForFunction: async () => {
    if (state.waitError) throw new Error(state.waitError);
    if (state.waitDelay) await new Promise(resolve => setTimeout(resolve, state.waitDelay));
  },
};
const taskSpace = async () => ({ spaceId: 93, ownership: state.ownership ?? "agent", page: () => page, finish: async () => { state.finishes = (state.finishes ?? 0) + 1; await save(); return {}; } });
console.log("fake CLI diagnostic noise");
await new Function("taskSpace", `return (async () => {${source}\n})();`)(taskSpace);
