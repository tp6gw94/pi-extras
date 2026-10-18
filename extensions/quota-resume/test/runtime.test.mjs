import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { fixture } from "./runtime-fixture.mjs";

async function until(check, label) {
  for (let n = 0; n < 300; n++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function retained(requests) {
  const final = requests.at(-1);
  assert.equal(final.authorization, true);
  assert.ok(final.session);
  assert.equal(new Set(requests.map(request => request.session)).size, 1);
  const messages = final.body.messages.map(message => ({ ...message, content: typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("") }));
  assert.equal(messages.filter(message => message.role === "user" && message.content === "Finish the fixture task.").length, 1);
  assert.equal(messages.filter(message => message.role === "user" && message.content === "Continue the unfinished task.").length, 1);
  assert.ok(messages.some(message => message.role === "tool" && JSON.stringify(message.content).includes("completed-tool-result-marker")));
}

async function sdk(f, manager, extra = []) {
  const modelRuntime = await ModelRuntime.create({ authPath: join(f.agentDir, "auth.json"), modelsPath: join(f.agentDir, "models.json"), modelsStorePath: join(f.agentDir, "models-cache.json"), refreshOnCreate: false });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false, ...(extra.length ? { keepRecentTokens: 0 } : {}) } });
  const resourceLoader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [pi => pi.on("message_end", event => event.message.role === "assistant" ? { message: { ...event.message } } : undefined), extension, ...extra] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: f.root, agentDir: f.agentDir, modelRuntime, resourceLoader, settingsManager, sessionManager: manager, model: modelRuntime.getModel("opencode-go", "quota-fixture"), tools: ["read"] });
  await session.bindExtensions({});
  return session;
}

async function close(session) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}

test("true SDK preserves prompt/tool result through replacement and exactly one continuation", async t => {
  const f = await fixture();
  t.after(f.close);
  const session = await sdk(f, SessionManager.create(f.root, join(f.root, "sessions")));
  t.after(() => close(session));
  await session.prompt("Finish the fixture task.");
  await until(() => session.getLastAssistantText() === "Fixture task complete.", "SDK continuation");
  retained(f.requests);
  assert.equal(session.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("Continue the unfinished task.")).length, 1);
});

for (const failed of [false, true]) test(`true SDK manual compaction ${failed ? "failure" : "success"} resumes overdue quota`, async t => {
  const f = await fixture({ delay: 1 });
  t.after(f.close);
  let completionIdle;
  const session = await sdk(f, SessionManager.create(f.root, join(f.root, "sessions")), [pi => {
    pi.on("session_before_compact", async event => {
      await sleep(1200);
      if (failed) return { cancel: true };
      return { compaction: { summary: "Fixture summary.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
    });
    pi.on(failed ? "session_compact_failed" : "session_compact", async (_event, ctx) => {
      completionIdle = ctx.isIdle();
      if (!failed) await sleep(150);
    });
  }]);
  t.after(() => close(session));
  await session.prompt("Finish the fixture task.");
  let settled = 0;
  const unsubscribe = session.subscribe(event => { if (event.type === "agent_settled") settled++; });
  if (failed) await assert.rejects(session.compact(), /Compaction cancelled/);
  else await session.compact();
  assert.equal(completionIdle, failed);
  assert.equal(settled, 0);
  await until(() => session.getLastAssistantText() === "Fixture task complete.", "manual compaction continuation");
  assert.equal(session.messages.filter(message => message.role === "user" && JSON.stringify(message.content).includes("Continue the unfinished task.")).length, 1);
  unsubscribe();
});

test("true SDK ordinary success never creates quota recovery", async t => {
  const f = await fixture({ scenario: "normal" });
  t.after(f.close);
  const session = await sdk(f, SessionManager.create(f.root, join(f.root, "sessions")));
  t.after(() => close(session));
  await session.prompt("Finish the fixture task.");
  assert.equal(session.getLastAssistantText(), "Fixture task complete.");
  assert.equal(session.sessionManager.getBranch().some(entry => entry.customType === "quota-resume"), false);
  assert.equal(f.requests.length, 2);
});

test("true SDK cancelled record survives reopen without a continuation", async t => {
  const f = await fixture({ delay: 1 });
  t.after(f.close);
  const manager = SessionManager.create(f.root, join(f.root, "sessions"));
  const session = await sdk(f, manager);
  await session.prompt("Finish the fixture task.");
  await session.prompt("/quota-resume cancel");
  await close(session);
  const reopened = await sdk(f, SessionManager.open(manager.getSessionFile()));
  t.after(() => close(reopened));
  await sleep(1300);
  assert.equal(f.requests.some(request => JSON.stringify(request.body).includes("Continue the unfinished task.")), false);
  assert.ok(reopened.sessionManager.getBranch().some(entry => entry.data?.state === "cancelled"));
});

test("true SDK originally future pending resumes once when reopened overdue", async t => {
  const f = await fixture({ delay: 1 });
  t.after(f.close);
  const manager = SessionManager.create(f.root, join(f.root, "sessions"));
  const session = await sdk(f, manager);
  await session.prompt("Finish the fixture task.");
  await close(session);
  await sleep(1200);
  const reopened = await sdk(f, SessionManager.open(manager.getSessionFile()));
  t.after(() => close(reopened));
  await until(() => reopened.getLastAssistantText() === "Fixture task complete.", "reopen continuation");
  retained(f.requests);
});

function rpc(f) {
  const child = spawn(process.execPath, [...f.args, "--mode", "rpc"], { cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  let buffer = "", errors = "";
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", chunk => errors += chunk);
  return { events, send: value => child.stdin.write(JSON.stringify(value) + "\n"), stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("close", resolve));
  }, errors: () => errors };
}

test("true spawned RPC local fixture dispatches once with original context and native Go header", async t => {
  const f = await fixture({ delay: 1 });
  t.after(f.close);
  const child = rpc(f);
  t.after(child.stop);
  child.send({ id: "run", type: "prompt", message: "Finish the fixture task." });
  await until(() => child.events.filter(event => event.type === "agent_settled").length >= 2, `RPC continuation ${child.errors()}`);
  retained(f.requests);
  const records = (await readFile(join(f.root, "session.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.filter(entry => entry.data?.state === "consumed").length, 1);
});

test("true spawned RPC idle explicit cancel prevents continuation", async t => {
  const f = await fixture({ delay: 1 });
  t.after(f.close);
  const child = rpc(f);
  t.after(child.stop);
  child.send({ id: "run", type: "prompt", message: "Finish the fixture task." });
  await until(() => child.events.some(event => event.type === "agent_settled"), "RPC pending");
  child.send({ id: "cancel", type: "prompt", message: "/quota-resume cancel" });
  await until(() => child.events.some(event => event.type === "response" && event.id === "cancel"), "RPC cancel");
  await sleep(1300);
  assert.equal(f.requests.some(request => JSON.stringify(request.body).includes("Continue the unfinished task.")), false);
  const records = (await readFile(join(f.root, "session.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records.at(-1).data.state, "cancelled");
});
