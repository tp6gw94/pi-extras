import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type Classify } from "../runtime.ts";
import type { Request } from "../schema.ts";

const signal = new AbortController().signal;
const classify: Classify = async () => { throw new Error("Unexpected classifier"); };

test("manual uncertainty retains diagnostics, permits frozen observation, and releases without browser work", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-release-"));
  let calls = 0;
  const runtime = createRuntime({ leaseDir: join(dir, "leases"), round: async c => {
    calls++;
    if (c.op === "begin") return { reason: "begun", spaceId: 93 };
    if (c.op === "act") return { reason: "uncertain_effect", issue: "native wait failed", dispatched: true };
    return { reason: "observed", facts: { url: "http://localhost/", documentId: "doc", controls: {}, checks: [] } };
  } });
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }); });
  const begin: Request = { op: "begin", space: { attach: 93 }, contract: { goal: "test", allowedOrigins: ["http://localhost"], allowedActions: ["click"], text: {}, evidenceDir: dir, deadline: new Date(Date.now() + 60000).toISOString(), maxActions: 2 } };
  const task = (await runtime.execute(begin, signal, classify)).report.task;
  const action: Request = { op: "act", task, page: "p1", action: { kind: "click", target: { selector: "button" } }, after: { kind: "visible", selector: "h1" } };
  const uncertain = await runtime.execute(action, signal, classify);
  assert.deepEqual(uncertain.report.issues, ["native wait failed"]);
  const observed = await runtime.execute({ op: "observe", task, page: "p1" }, signal, classify);
  assert.equal(observed.report.reason, "observed");
  assert.equal(observed.report.mayHaveLateEffects, true);
  assert.equal((await runtime.execute(action, signal, classify)).report.reason, "uncertain_effect");
  const before = calls;
  const release: Request = { op: "release", task };
  const released = await runtime.execute(release, signal, classify);
  assert.equal(released.report.reason, "released");
  assert.equal(released.report.mayHaveLateEffects, true);
  assert.equal(calls, before);
  const next = await runtime.execute(begin, signal, classify);
  assert.equal(next.report.reason, "begun");
  assert.equal((await runtime.execute(release, signal, classify)).report.reason, "released");
  assert.equal((await runtime.execute(begin, signal, classify)).report.reason, "busy");
  assert.equal((await runtime.execute({ op: "observe", task, page: "p1" }, signal, classify)).report.reason, "released");
});

test("release exists for active tasks without a browser round", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-release-active-"));
  const runtime = createRuntime({ leaseDir: join(dir, "leases"), round: async c => {
    assert.equal(c.op, "begin");
    return { reason: "begun", spaceId: 93 };
  } });
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }); });
  const begun = await runtime.execute({ op: "begin", space: { attach: 93 }, contract: { goal: "test", allowedOrigins: ["http://localhost"], allowedActions: ["click"], text: {}, evidenceDir: dir, deadline: new Date(Date.now() + 60000).toISOString(), maxActions: 1 } }, signal, classify);
  assert.equal((await runtime.execute({ op: "release", task: begun.report.task }, signal, classify)).report.reason, "released");
});
