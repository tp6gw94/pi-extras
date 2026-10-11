import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const chineseLocale = /toLocale\w*String\(\s*["']zh/;
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

async function* sourceFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["test", "skills", "node_modules"].includes(entry.name)) yield* sourceFiles(path);
    } else if (!entry.name.endsWith(".md")) yield path;
  }
}

test("rpc-subagents source shows no CJK text in the UI (README, skills and test fixtures excluded)", async () => {
  const hits = [];
  for await (const file of sourceFiles(root)) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, index) => { if (cjk.test(line) || chineseLocale.test(line)) hits.push(`${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(hits, []);
});
