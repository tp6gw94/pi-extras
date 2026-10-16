import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRound, type RoundCommand } from "../ego-round.ts";

const cli = resolve("extensions/ego-browser/test/page-cli.mjs");
const origin = "http://127.0.0.1:4317";
const checks = [{ id: "ready", condition: { kind: "visible", selector: "#ready" } }] as const;

async function newTabPage(t: TestContext) {
  await chmod(cli, 0o755);
  const dir = await mkdtemp(join(tmpdir(), "bootstrap-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({ url: "chrome://new-tab-page/", navigations: [] }));
  process.env.EGO_PAGE_STATE = statePath;
  t.after(async () => {
    delete process.env.EGO_PAGE_STATE;
    await rm(dir, { recursive: true, force: true });
  });
  const round = (op: RoundCommand["op"], extra: Partial<RoundCommand> = {}) => runRound({
    op,
    space: 94,
    page: "p1",
    resultPath: join(dir, "result.json"),
    snapshotPath: join(dir, "snapshot.txt"),
    allowedOrigins: [origin],
    candidates: [],
    checks: [...checks],
    timeoutMs: 5000,
    ...extra,
  }, new AbortController().signal, cli);
  const state = async () => JSON.parse(await readFile(statePath, "utf8")) as { url: string; navigations: string[] };
  return { round, state };
}

test("allowed navigation leaves a new tab page with passing evidence", async t => {
  const { round, state } = await newTabPage(t);
  const result = await round("act", {
    action: { kind: "navigate", url: `${origin}/` },
    after: { kind: "visible", selector: "#ready" },
  });
  assert.equal(result.reason, "acted");
  assert.equal(result.facts?.url, `${origin}/`);
  assert.deepEqual(result.facts?.checks.map(check => check.status), ["pass"]);
  assert.deepEqual(await state(), { url: `${origin}/`, navigations: [`${origin}/`] });
});

test("observing a new tab page is refused before any navigation", async t => {
  const { round, state } = await newTabPage(t);
  const result = await round("observe");
  assert.equal(result.reason, "scope_violation");
  assert.equal(result.dispatched, false);
  assert.equal(result.facts?.url, "chrome://new-tab-page/");
  assert.deepEqual(await state(), { url: "chrome://new-tab-page/", navigations: [] });
});

test("navigation outside the allowed origins is refused without moving the page", async t => {
  const { round, state } = await newTabPage(t);
  const result = await round("act", {
    action: { kind: "navigate", url: "http://example.invalid/" },
    after: { kind: "visible", selector: "#ready" },
  });
  assert.equal(result.reason, "scope_violation");
  assert.deepEqual(await state(), { url: "chrome://new-tab-page/", navigations: [] });
});
