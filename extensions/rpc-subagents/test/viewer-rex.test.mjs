import test from "node:test";
import assert from "node:assert/strict";
import { RexOpener, createRexCliAdapter } from "../rex.mjs";

function fakeRex({ columns = 200, rows = 50 } = {}) {
  const live = new Set(["block:caller", "block:user"]); const splits = []; let created = 0;
  const run = async (_binary, args) => {
    if (args[0] === "block" && args[1] === "inspect") {
      const id = args[4];
      if (!live.has(id)) throw Object.assign(new Error("Command failed"), { code: 3, stderr: `Error: block target "${id}" not found\n` });
      return { stdout: JSON.stringify({ session_id: args[3], block: { block_id: id } }) };
    }
    if (args[0] === "block" && args[1] === "call" && args[6] === "size") return { stdout: JSON.stringify({ columns, rows }) };
    if (args[0] === "split") {
      const id = `block:viewer-${++created}`; live.add(id); splits.push(args);
      return { stdout: JSON.stringify({ anchor_id: args[4], block_ids: [id] }) };
    }
    throw new Error(`Unexpected rex call ${args.join(" ")}`);
  };
  return { live, splits, adapter: createRexCliAdapter({ run }) };
}

const task = { taskId: "task", name: "review", eventFile: "/logs/events $x.jsonl", cwd: "/project" };
const env = { REX_SESSION: "session:main", REX_BLOCK: "block:caller" };

test("Rex opener splits beside the caller without focus and runs the viewer directly in a kept-open pane", async () => {
  const { splits, adapter } = fakeRex();
  const opener = new RexOpener({ adapter, viewerPath: "/viewer path.mjs", nodePath: "/node", env });
  const opened = await opener.open(task, { callerPaneId: "block:caller" });
  assert.deepEqual(opened, { taskId: "task", paneId: "block:viewer-1", reused: false, command: "'/node' '/viewer path.mjs' '--events' '/logs/events $x.jsonl'" });
  assert.deepEqual(splits[0], ["split", "-s", "session:main", "-b", "block:caller", "--split=right", "--focus=false", "--keep-open", "--shell=none",
    "-c", "/project", "--label", "rpc review", "--json", "--", "/node", "/viewer path.mjs", "--events", "/logs/events $x.jsonl"]);
});

test("Rex opener reuses its live pane and replaces it after the user closes it", async () => {
  const { live, splits, adapter } = fakeRex({ columns: 96, rows: 54 });
  const opener = new RexOpener({ adapter, viewerPath: "/viewer.mjs", env });
  const [first, concurrent] = await Promise.all([opener.open(task, { callerPaneId: "block:caller" }), opener.open(task, { callerPaneId: "block:caller" })]);
  assert.equal(concurrent.paneId, first.paneId);
  assert.equal(splits[0][5], "--split=below");
  assert.deepEqual(await opener.open(task, { callerPaneId: "block:caller" }), { ...first, reused: true });
  live.delete(first.paneId);
  const replacement = await opener.open(task, { callerPaneId: "block:caller", direction: "right" });
  assert.equal(replacement.reused, false); assert.notEqual(replacement.paneId, first.paneId);
  assert.equal(splits.length, 2); assert.equal(splits[1][5], "--split=right");
});

test("Rex opener refuses a missing session, caller, or invalid direction", async () => {
  const { adapter, splits } = fakeRex();
  await assert.rejects(new RexOpener({ adapter, viewerPath: "/viewer.mjs", env: {} }).open(task, { callerPaneId: "block:caller" }), /REX_SESSION/);
  const opener = new RexOpener({ adapter, viewerPath: "/viewer.mjs", env });
  await assert.rejects(opener.open(task, {}), /callerPaneId/);
  await assert.rejects(opener.open(task, { callerPaneId: "block:gone" }), /no longer exists/);
  await assert.rejects(opener.open(task, { callerPaneId: "block:caller", direction: "left" }), /right or down/);
  assert.equal(splits.length, 0);
});

test("Rex adapter surfaces CLI failures other than a missing block", async () => {
  const adapter = createRexCliAdapter({ run: async () => { throw Object.assign(new Error("Command failed"), { stderr: "Error: connection refused\n" }); } });
  await assert.rejects(adapter.inspect("session:main", "block:caller"), /Command failed/);
  const empty = createRexCliAdapter({ run: async () => ({ stdout: JSON.stringify({ block_ids: [] }) }) });
  await assert.rejects(empty.split({ sessionId: "s", callerPaneId: "b", direction: "right", cwd: "/", label: "l", argv: ["node"] }), /no block ID/);
});
