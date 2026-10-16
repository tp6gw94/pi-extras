import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, unlink, mkdir, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Classify } from "../runtime.ts";
import type { Request } from "../schema.ts";

const signal = new AbortController().signal;
const classify: Classify = async () => { throw new Error("Unexpected classifier"); };

test("busy release cannot race an admitted round; expired release retries failed unlink", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-release-race-"));
  let entered!: () => void;
  let settle!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { settle = resolve; });
  const runtime = createRuntime({ leaseDir: join(dir, "leases"), round: async c => {
    if (c.op === "begin") return { reason: "begun", spaceId: 93 };
    entered();
    await gate;
    return { reason: "uncertain_effect", dispatched: true };
  } });
  t.after(async () => { settle(); await runtime.dispose(); await rm(dir, { recursive: true, force: true }); });
  const request: Request = { op: "begin", space: { attach: 93 }, contract: { goal: "test", allowedOrigins: ["http://localhost"], allowedActions: ["click"], text: {}, evidenceDir: dir, deadline: new Date(Date.now() + 200).toISOString(), maxActions: 1 } };
  const task = (await runtime.execute(request, signal, classify)).report.task;
  const pending = runtime.execute({ op: "act", task, page: "p1", action: { kind: "click", target: { selector: "button" } }, after: { kind: "visible", selector: "h1" } }, signal, classify);
  await ready;
  assert.equal((await runtime.execute({ op: "release", task }, signal, classify)).report.reason, "busy");
  settle();
  await pending;
  await new Promise(resolve => setTimeout(resolve, 210));
  assert.equal((await runtime.execute({ op: "observe", task, page: "p1" }, signal, classify)).report.reason, "deadline");
  const lock = join(dir, "leases", "93.lock");
  await unlink(lock);
  await mkdir(lock);
  assert.equal((await runtime.execute({ op: "release", task }, signal, classify)).report.reason, "browser_error");
  await rmdir(lock);
  const released = await runtime.execute({ op: "release", task }, signal, classify);
  assert.equal(released.report.reason, "released");
  assert.equal(released.report.mayHaveLateEffects, true);
});

test("finished task keeps exactly-once finish through unlink failure and old release cannot delete a reacquired lease", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-finish-unlink-"));
  const ops: string[] = [];
  const expected = { kind: "text", selector: "#confirmation", includes: "Order confirmed" } as const;
  const facts = { url: "http://localhost/", documentId: "doc", controls: {}, checks: [{ id: "confirmed", expected, actual: "Order confirmed", status: "pass" as const }] };
  const runtime = createRuntime({ leaseDir: join(dir, "leases"), round: async c => {
    ops.push(c.op);
    if (c.op === "begin") return { reason: "begun", spaceId: 93 };
    return { reason: c.op === "finish" ? "finished" : "observed", facts };
  } });
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }); });
  const request: Request = { op: "begin", space: { attach: 93 }, contract: { goal: "test", allowedOrigins: ["http://localhost"], allowedActions: ["click"], text: {}, evidenceDir: dir, deadline: new Date(Date.now() + 60000).toISOString(), maxActions: 1 } };
  const lock = join(dir, "leases", "93.lock");
  const old = (await runtime.execute(request, signal, classify)).report.task;
  const observed = await runtime.execute({ op: "observe", task: old, page: "p1", checks: [{ id: "confirmed", condition: expected }] }, signal, classify);
  const finish: Request = { op: "finish", task: old, reviewedObservation: observed.report.observation!.id };
  await unlink(lock);
  await mkdir(lock);
  const finished = await runtime.execute(finish, signal, classify);
  assert.equal(finished.report.reason, "finished");
  assert.equal(finished.report.issues.length, 1);
  assert.equal((await runtime.execute(finish, signal, classify)).report.reason, "finished");
  assert.deepEqual(ops, ["begin", "observe", "finish"]);
  assert.equal((await runtime.execute({ op: "release", task: old }, signal, classify)).report.reason, "browser_error");
  await rmdir(lock);
  assert.equal((await runtime.execute({ op: "release", task: old }, signal, classify)).report.reason, "finished");
  const next = (await runtime.execute(request, signal, classify)).report.task;
  assert.equal((await runtime.execute({ op: "release", task: old }, signal, classify)).report.reason, "finished");
  assert.ok((await stat(lock)).isFile());
  assert.equal((await runtime.execute({ op: "release", task: next }, signal, classify)).report.reason, "released");
  await assert.rejects(stat(lock));
  assert.deepEqual(ops, ["begin", "observe", "finish", "begin"]);
});
