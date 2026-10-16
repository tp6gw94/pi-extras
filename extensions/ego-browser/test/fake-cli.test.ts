import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("extensions/ego-browser/test/fake-cli.mjs");

test("fake CLI state is never observable half-written", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fake-cli-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({ url: "http://localhost:4317/" }));
  const child = spawn(process.execPath, [cli], { env: { ...process.env, EGO_FAKE_STATE: statePath }, stdio: ["pipe", "ignore", "inherit"] });
  const exited = new Promise(resolve => child.on("close", resolve));
  t.after(async () => { child.kill(); await exited; });
  t.after(() => rm(dir, { recursive: true, force: true }));
  child.stdin.end(`const p = (await taskSpace()).page(); for (let i = 0; i < 300; i++) await p.fill("#email", "x".repeat(200000) + i);`);
  let running = true;
  void exited.then(() => { running = false; });
  while (running) {
    JSON.parse(await readFile(statePath, "utf8"));
  }
  assert.equal(await exited, 0);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).mutations, 300);
});
