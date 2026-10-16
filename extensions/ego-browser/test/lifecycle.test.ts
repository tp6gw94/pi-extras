import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Classify } from "../runtime.ts";
import type { RoundCommand, RoundResult } from "../ego-round.ts";
import type { Request } from "../schema.ts";

const classify: Classify = async () => {
  throw new Error("Classification is not part of this workflow");
};
const signal = new AbortController().signal;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function begin(dir: string): Request {
  return {
    op: "begin",
    space: { attach: 93 },
    contract: {
      goal: "Lifecycle verification",
      allowedOrigins: ["http://localhost"],
      allowedActions: ["click"],
      text: {},
      evidenceDir: dir,
      deadline: new Date(Date.now() + 60000).toISOString(),
      maxActions: 2,
    },
  };
}

test("shutdown drains admitted mutations before releasing the lease and closes admission", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-shutdown-"));
  const entered = deferred();
  const settle = deferred();
  let dispatches = 0;
  const round = async (command: RoundCommand): Promise<RoundResult> => {
    if (command.op === "begin") return { reason: "begun", spaceId: 93 };
    dispatches++;
    entered.resolve();
    await settle.promise;
    return { reason: "uncertain_effect", dispatched: true, issue: "Browser effects may arrive after shutdown" };
  };
  const runtime = createRuntime({ round, leaseDir: join(dir, "leases") });
  const other = createRuntime({ round, leaseDir: join(dir, "leases") });
  t.after(async () => {
    settle.resolve();
    await runtime.dispose();
    await other.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const begun = await runtime.execute(begin(dir), signal, classify);
  const action: Request = { op: "act", task: begun.report.task, page: "p1", action: { kind: "click", target: { selector: "#submit" } }, after: { kind: "visible", selector: "#confirmation" } };
  const pending = runtime.execute(action, signal, classify);
  await entered.promise;
  const disposal = runtime.dispose();
  assert.equal(runtime.dispose(), disposal);
  assert.equal((await other.execute(begin(dir), signal, classify)).report.reason, "busy");
  assert.equal((await runtime.execute(action, signal, classify)).report.reason, "cancelled");
  assert.equal((await runtime.execute(begin(dir), signal, classify)).report.reason, "cancelled");
  assert.equal(dispatches, 1);
  settle.resolve();
  const result = await pending;
  assert.equal(result.report.reason, "uncertain_effect");
  assert.equal(result.report.mayHaveLateEffects, true);
  await disposal;
  assert.equal((await other.execute(begin(dir), signal, classify)).report.reason, "begun");
  assert.equal((await runtime.execute(action, signal, classify)).report.reason, "cancelled");
  assert.equal(dispatches, 1);
});

test("finish carries reviewed checks and page into one round and preserves final evidence", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-finish-"));
  const commands: RoundCommand[] = [];
  const expected = { kind: "text", selector: "#confirmation", includes: "Order confirmed" } as const;
  const facts = { url: "http://localhost/", documentId: "doc", controls: {}, checks: [{ id: "confirmed", expected, actual: "Order confirmed", status: "pass" as const }] };
  const runtime = createRuntime({
    leaseDir: join(dir, "leases"),
    round: async command => {
      commands.push(command);
      if (command.op === "begin") return { reason: "begun", spaceId: 93 };
      return { reason: command.op === "finish" ? "finished" : "observed", facts };
    },
  });
  t.after(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const begun = await runtime.execute(begin(dir), signal, classify);
  const task = begun.report.task;
  const observed = await runtime.execute({ op: "observe", task, page: "p2", checks: [{ id: "confirmed", condition: expected }] }, signal, classify);
  const result = await runtime.execute({ op: "finish", task, reviewedObservation: observed.report.observation!.id }, signal, classify);
  assert.equal(result.report.reason, "finished");
  assert.equal(result.report.observation!.page, "p2");
  assert.deepEqual(result.report.checks, facts.checks);
  assert.deepEqual(commands.map(command => command.op), ["begin", "observe", "finish"]);
  assert.equal(commands[2]!.page, "p2");
  assert.deepEqual(commands[2]!.checks, [{ id: "confirmed", condition: expected }]);
});
