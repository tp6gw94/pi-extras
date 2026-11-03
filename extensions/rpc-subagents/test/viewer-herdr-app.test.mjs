import test from "node:test";
import assert from "node:assert/strict";
import { HerdrAppOpener, createHerdrAppCliAdapter } from "../herdr-app.mjs";

function fakeHerdrApp({ cols = 200, rows = 50, focused = "p-caller" } = {}) {
  const tabs = { "tb-main": [{ terminal: "t2", pane: "p-caller" }, { terminal: "t3", pane: "p-user" }], "tb-other": [{ terminal: "t4", pane: "p-away" }] };
  const calls = []; let created = 0;
  const reply = (value) => ({ stdout: JSON.stringify(value) });
  const run = async (binary, args) => {
    calls.push([binary, ...args]);
    if (binary === "hc" && args[0] === "get") return reply({ address: args[1], cols, rows });
    if (args[0] === "ls") return reply({ spaces: [{ id: "sp", tabs: Object.entries(tabs).map(([id, terminals]) => ({ id, terminals })) }] });
    if (args[0] === "status") return reply({ focused_pane: focused });
    if (args[0] === "do" && args[1] === "pane.split") {
      const { pane } = JSON.parse(args[2]);
      const tab = Object.values(tabs).find((terminals) => terminals.some((item) => item.pane === pane));
      if (!tab) throw Object.assign(new Error("Command failed"), { code: 1, stdout: JSON.stringify({ error: `no pane "${pane}"` }) });
      const id = `p-viewer-${++created}`; tab.push({ terminal: `t-viewer-${created}`, pane: id }); focused = id;
      return reply({ pane: id, terminal: `t-viewer-${created}` });
    }
    if (args[0] === "do" && args[1] === "pane.focus") { focused = JSON.parse(args[2]).pane; return reply({}); }
    throw new Error(`Unexpected call ${binary} ${args.join(" ")}`);
  };
  return { tabs, calls, focused: () => focused, adapter: createHerdrAppCliAdapter({ run }) };
}

const task = { taskId: "task", name: "review", eventFile: "/logs/events $x.jsonl", cwd: "/project" };
const env = { HC_TERMINAL_ID: "t2" };
const splits = (calls) => calls.filter((call) => call[2] === "pane.split").map((call) => JSON.parse(call[3]));

test("Herdr app opener splits beside the pane showing this terminal, runs the viewer directly, and keeps focus", async () => {
  const fake = fakeHerdrApp();
  const opener = new HerdrAppOpener({ adapter: fake.adapter, viewerPath: "/viewer path.mjs", nodePath: "/node", env });
  const opened = await opener.open(task);
  assert.deepEqual(opened, { taskId: "task", paneId: "p-viewer-1", reused: false, command: "'/node' '/viewer path.mjs' '--events' '/logs/events $x.jsonl'" });
  assert.deepEqual(splits(fake.calls), [{ direction: "right", pane: "p-caller", argv: ["/node", "/viewer path.mjs", "--events", "/logs/events $x.jsonl"] }]);
  assert.equal(fake.focused(), "p-caller");
});

test("Herdr app opener returns focus to whichever pane of the caller tab had it, and leaves other tabs alone", async () => {
  const sameTab = fakeHerdrApp({ focused: "p-user" });
  await new HerdrAppOpener({ adapter: sameTab.adapter, viewerPath: "/viewer.mjs", env }).open(task);
  assert.equal(sameTab.focused(), "p-user");
  const otherTab = fakeHerdrApp({ focused: "p-away" });
  await new HerdrAppOpener({ adapter: otherTab.adapter, viewerPath: "/viewer.mjs", env }).open(task);
  assert.equal(otherTab.calls.some((call) => call[2] === "pane.focus"), false);
});

test("Herdr app opener reuses its live pane and replaces it after the user closes it", async () => {
  const fake = fakeHerdrApp({ cols: 96, rows: 54 });
  const opener = new HerdrAppOpener({ adapter: fake.adapter, viewerPath: "/viewer.mjs", env });
  const [first, concurrent] = await Promise.all([opener.open(task), opener.open(task)]);
  assert.equal(concurrent.paneId, first.paneId);
  assert.deepEqual(await opener.open(task), { ...first, reused: true });
  fake.tabs["tb-main"] = fake.tabs["tb-main"].filter((item) => item.pane !== first.paneId);
  const replacement = await opener.open(task, { direction: "right" });
  assert.equal(replacement.reused, false); assert.notEqual(replacement.paneId, first.paneId);
  assert.deepEqual(splits(fake.calls).map((split) => split.direction), ["down", "right"]);
});

test("Herdr app opener refuses a missing terminal, an unshown caller, or an invalid direction", async () => {
  const fake = fakeHerdrApp();
  await assert.rejects(new HerdrAppOpener({ adapter: fake.adapter, viewerPath: "/viewer.mjs", env: {} }).open(task), /HC_TERMINAL_ID/);
  await assert.rejects(new HerdrAppOpener({ adapter: fake.adapter, viewerPath: "/viewer.mjs", env: { HC_TERMINAL_ID: "t9" } }).open(task), /no pane for terminal t9/);
  const opener = new HerdrAppOpener({ adapter: fake.adapter, viewerPath: "/viewer.mjs", env });
  await assert.rejects(opener.open(task, { callerPaneId: "p-gone" }), /no longer exists/);
  await assert.rejects(opener.open(task, { direction: "left" }), /right or down/);
  assert.equal(splits(fake.calls).length, 0);
});

test("Herdr app adapter reports the app's error reply", async () => {
  const fake = fakeHerdrApp();
  await assert.rejects(fake.adapter.split({ callerPaneId: "p-gone", direction: "right", argv: ["node"] }), /pane.split failed: no pane "p-gone"/);
  const refused = createHerdrAppCliAdapter({ run: async () => { throw Object.assign(new Error("spawn herdr-app ENOENT"), { code: "ENOENT" }); } });
  await assert.rejects(refused.panes(), /ENOENT/);
});
