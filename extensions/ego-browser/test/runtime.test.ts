import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRuntime, type Classify } from "../runtime.ts";
import { runRound } from "../ego-round.ts";
import type { Request } from "../schema.ts";

const root = resolve("extensions/ego-browser/test/.artifacts");
const cli = resolve("extensions/ego-browser/test/fake-cli.mjs");
const condition = { kind: "text", selector: "#confirmation", includes: "Order confirmed" } as const;
const checks = [{ id: "confirmed", condition }];
const candidates = [{ id: "submit", action: { kind: "click", selector: "#submit" } as const, after: condition }];
const decision = (choice: string): Classify => async () => ({ provider: "fake", model: "fake", api: "typesafe-system-one", timestamp: Date.now(), stopReason: "stop", answers: { action: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } } } });

async function fixture(t: TestContext, state: Record<string, unknown> = {}) {
  await mkdir(root, { recursive: true });
  await chmod(cli, 0o755);
  const dir = await mkdtemp(join(root, "case-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({ url: "http://localhost:4317/", ...state }));
  process.env.EGO_FAKE_STATE = statePath;
  const runtime = createRuntime({ round: (command, signal) => runRound(command, signal, cli), leaseDir: join(dir, "leases") });
  t.after(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
    delete process.env.EGO_FAKE_STATE;
  });
  const call = (request: Request, classify = decision("submit"), signal = new AbortController().signal) => runtime.execute(request, signal, classify).then(r => r.report);
  const begun = await call({
    op: "begin",
    space: { attach: 93 },
    contract: {
      goal: "Submit",
      allowedOrigins: ["http://localhost:4317"],
      allowedActions: ["click", "fill", "navigate"],
      text: { email: "user@example.invalid" },
      evidenceDir: dir,
      deadline: new Date(Date.now() + 60000).toISOString(),
      maxActions: 3,
    },
  });
  const task = begun.task;
  const run = (maxActions = 2): Request => ({ op: "run", task, page: "p1", goal: "Submit", candidates, checks, budget: { maxActions, timeoutMs: 5000 } });
  return {
    runtime,
    call,
    task,
    run,
    begun,
    dir,
    statePath,
    state: async () => JSON.parse(await readFile(statePath, "utf8")),
  };
}

test("manual observations preserve raw snapshots and gate explicit finish", async t => {
  const f = await fixture(t);
  assert.equal(f.begun.reason,"begun");
  const before = await f.call({op:"observe",task:f.task,page:"p1",checks});
  assert.equal(before.checks[0]?.status,"fail");
  assert.equal(await readFile(before.observation!.snapshotPath,"utf8"),"button [ref=7] Submit\nopaque vendor snapshot <not JSON>");
  assert.equal((await f.call({op:"finish",task:f.task,reviewedObservation:before.observation!.id})).reason,"check_failed");
  assert.equal((await f.call({op:"act",task:f.task,page:"p1",observation:"old",action:{kind:"click",target:{ref:"ref=7"}},after:condition})).reason,"stale");
  assert.equal((await f.call({op:"act",task:f.task,page:"p1",observation:before.observation!.id,action:{kind:"click",target:{ref:"ref=7"}},after:condition})).reason,"acted");
  const after = await f.call({op:"observe",task:f.task,page:"p1",checks});
  assert.equal(after.reason,"checks_passed");
  const finished = await f.call({op:"finish",task:f.task,reviewedObservation:after.observation!.id});
  assert.equal(finished.reason, "finished");
  assert.deepEqual(finished.checks, after.checks);
  assert.equal(await readFile(finished.observation!.snapshotPath, "utf8"), "button [ref=7] Submit\nopaque vendor snapshot <not JSON>");
  await f.call({op:"finish",task:f.task,reviewedObservation:after.observation!.id});
  assert.equal((await f.state()).finishes,1);
});

test("bounded classifier selects one candidate and verifies effects", async t => {
  const f = await fixture(t);
  const result = await f.call(f.run());
  assert.equal(result.reason,"checks_passed");
  assert.equal(result.actionsUsed,1);
  assert.equal(result.classifierCalls,1);
  assert.equal(result.checks[0]?.actual,"Order confirmed");
  assert.equal((await f.state()).mutations,1);
});

for (const [choice, reason] of [["DONE","check_failed"],["unknown","invalid_decision"],["STOP","classifier_stop"]]) test(`${choice} never proves success or mutates`, async t => {
  const f = await fixture(t);
  const result = await f.call(f.run(),decision(choice!));
  assert.equal(result.reason,reason);
  assert.equal(result.actionsUsed,0);
  assert.equal((await f.state()).mutations,undefined);
});

test("DOM changes during classification stop dispatch in the next round", async t => {
  const f = await fixture(t);
  const result = await f.call(f.run(),async (...args) => {
    await writeFile(f.statePath,JSON.stringify({...await f.state(),version:1}));
    return decision("submit")(...args);
  });
  assert.equal(result.reason,"stale");
  assert.equal((await f.state()).mutations,undefined);
});

test("cancelled mutation freezes the task and never retries", async t => {
  const f = await fixture(t,{delay:2000});
  const controller = new AbortController();
  const timer = setInterval(async () => { if ((await f.state()).mutations) controller.abort(); },20);
  t.after(() => clearInterval(timer));
  const result = await f.call(f.run(),decision("submit"),controller.signal);
  clearInterval(timer);
  assert.equal(result.reason,"uncertain_effect");
  assert.equal(result.mayHaveLateEffects,true);
  assert.equal((await f.call(f.run())).reason,"uncertain_effect");
  assert.equal((await f.state()).mutations,1);
});

test("exclusive lease rejects another runtime without stealing ownership", async t => {
  const f = await fixture(t);
  const other = createRuntime({leaseDir:join(f.dir,"leases")});
  t.after(() => other.dispose());
  const result = await other.execute({op:"begin",space:{attach:93},contract:{goal:"Other",allowedOrigins:["http://localhost:4317"],allowedActions:["click"],text:{},evidenceDir:f.dir,deadline:new Date(Date.now()+10000).toISOString(),maxActions:1}},new AbortController().signal,decision("STOP"));
  assert.equal(result.report.reason,"busy");
});

test("ownership loss stops without finish", async t => {
  const f = await fixture(t);
  await writeFile(f.statePath,JSON.stringify({...await f.state(),ownership:"user"}));
  assert.equal((await f.call(f.run())).reason,"ownership_lost");
  assert.equal((await f.state()).finishes,undefined);
});

test("aborted classifier does not consume an action", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await f.call(f.run(),async (...args) => { controller.abort(); return decision("submit")(...args); },controller.signal);
  assert.equal(result.reason,"cancelled");
  assert.equal(result.actionsUsed,0);
});

test("action budget stops an incomplete workflow", async t => {
  const f = await fixture(t,{noComplete:true});
  const result = await f.call(f.run(1));
  assert.equal(result.reason,"action_limit");
  assert.equal(result.actionsUsed,1);
  assert.equal(result.classifierCalls,1);
  assert.equal(result.checks[0]?.status,"fail");
});

test("run deadline cancels classification without mutation", async t => {
  const f = await fixture(t);
  const request = f.run();
  assert.equal(request.op,"run");
  if(request.op!=="run") throw new Error("Expected run");
  request.budget.timeoutMs=150;
  const result = await f.call(request,async (_context, signal) => new Promise((_resolve,reject) => signal.addEventListener("abort",()=>reject(signal.reason),{once:true})));
  assert.equal(result.reason,"deadline");
  assert.equal(result.actionsUsed,0);
  assert.equal((await f.state()).mutations,undefined);
});

test("contract text and origins cannot be expanded by manual action", async t => {
  const f = await fixture(t);
  assert.equal((await f.call({op:"act",task:f.task,page:"p1",action:{kind:"fill",target:{selector:"#email"},textKey:"invented"},after:condition})).reason,"browser_error");
  assert.equal((await f.call({op:"act",task:f.task,page:"p1",action:{kind:"navigate",url:"https://example.com"},after:condition})).reason,"browser_error");
  assert.equal((await f.state()).mutations,undefined);
});

const emailCandidate = { id: "email", action: { kind: "fill", selector: "#email", textKey: "email" } as const, after: { kind: "value", selector: "#email", equals: "user@example.invalid" } as const };

test("already-filled candidate is neither offered nor executed while submit stays eligible", async t => {
  const f = await fixture(t, { value: "user@example.invalid" });
  const request = f.run();
  if (request.op !== "run") throw new Error("Expected run");
  request.candidates = [emailCandidate, ...candidates];
  const offered: string[][] = [];
  const result = await f.call(request, async (context, ...rest) => {
    offered.push(Object.keys((context.questions.action as { criteria: Record<string, string> }).criteria));
    return decision("submit")(context, ...rest);
  });
  assert.deepEqual(offered, [["submit", "DONE", "STOP"]]);
  assert.equal(result.reason, "checks_passed");
  assert.equal(result.actionsUsed, 1);
  assert.equal((await f.state()).mutations, 1);
});

test("unfilled candidate is still offered and executed", async t => {
  const f = await fixture(t);
  const request = f.run();
  if (request.op !== "run") throw new Error("Expected run");
  request.candidates = [emailCandidate, ...candidates];
  const offered: string[][] = [];
  const result = await f.call(request, async (context, ...rest) => {
    offered.push(Object.keys((context.questions.action as { criteria: Record<string, string> }).criteria));
    return decision(offered.length === 1 ? "email" : "submit")(context, ...rest);
  });
  assert.deepEqual(offered, [["email", "submit", "DONE", "STOP"], ["submit", "DONE", "STOP"]]);
  assert.equal(result.reason, "checks_passed");
  assert.equal(result.actionsUsed, 2);
});

for (const change of [{ documentId: "replacement-document" }, { url: "http://localhost:4317/replaced" }]) {
  test(`manual ref rejects changed document provenance ${JSON.stringify(change)}`, async t => {
    const f = await fixture(t);
    const observed = await f.call({ op: "observe", task: f.task, page: "p1" });
    await writeFile(f.statePath, JSON.stringify({ ...await f.state(), ...change }));
    const result = await f.call({ op: "act", task: f.task, page: "p1", observation: observed.observation!.id, action: { kind: "click", target: { ref: "ref=7" } }, after: condition });
    assert.equal(result.reason, "stale");
    assert.equal(result.actionsUsed, 0);
    assert.equal((await f.state()).mutations, undefined);
  });
}

for (const [change, reason, frozen] of [
  [{ ownership: "user" }, "ownership_lost", true],
  [{ dialog: true }, "browser_prompt", true],
  [{ url: "https://example.com/" }, "scope_violation", true],
  [{ error: "Inspection failed" }, "browser_error", false],
  [{ done: false }, "check_failed", false],
] as const) {
  test(`finish preserves ${reason} and its lifecycle without dispatching finish`, async t => {
    const f = await fixture(t, { done: true });
    const observed = await f.call({ op: "observe", task: f.task, page: "p1", checks });
    assert.equal(observed.reason, "checks_passed");
    await writeFile(f.statePath, JSON.stringify({ ...await f.state(), ...change }));
    const result = await f.call({ op: "finish", task: f.task, reviewedObservation: observed.observation!.id });
    assert.equal(result.reason, reason);
    if (reason === "browser_error") assert.match(result.issues[0]!, /Inspection failed/);
    if (reason === "check_failed") assert.equal(result.checks[0]?.status, "fail");
    assert.equal((await f.state()).finishes, undefined);
    await writeFile(f.statePath, JSON.stringify({ url: "http://localhost:4317/", done: true }));
    const next = await f.call({ op: "observe", task: f.task, page: "p1", checks });
    assert.equal(next.reason, "checks_passed");
    if (frozen) assert.equal((await f.call({ op: "finish", task: f.task, reviewedObservation: next.observation!.id })).reason, reason);
  });
}
