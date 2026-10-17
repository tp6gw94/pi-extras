import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readSchedules, ScheduleManager } from "../schedules.mjs";
import { COORDINATION_LIMITS } from "../coordination.mjs";
import { CHILD_BINDING_ENV } from "../runtime.mjs";
import { safeText } from "../viewer.mjs";
import { projectKey } from "../store.mjs";
import { terminalTaskStates } from "../domain.mjs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const schema = {
  String: (options = {}) => ({ type: "string", ...options }), Number: () => ({ type: "number" }), Integer: (options = {}) => ({ type: "integer", ...options }),
  Boolean: () => ({ type: "boolean" }), Null: () => ({ type: "null" }), Literal: (value) => ({ const: value }),
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }), Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Union: (anyOf) => ({ anyOf }), Optional: (value) => value, Record: (key, value) => ({ type: "object", key, additionalProperties: value }),
};
const moduleUrl = new URL("../index.ts", import.meta.url).href;
const source = stripTypeScriptTypes(await readFile(new URL(moduleUrl), "utf8"));
const factorySource = source.replace(/^import .*?;\s*$/gm, "").replace("export default function rpcSubagents", "function rpcSubagents").replaceAll("import.meta.url", "moduleUrl") + "\nrpcSubagents";

function load(env, context = {}, api = {}) {
  const forbidden = () => { throw new Error("Factory attempted to initialize runtime resources"); };
  const factory = runInNewContext(factorySource, { process: { env }, Type: schema, dirname, join, fileURLToPath, moduleUrl, COORDINATION_LIMITS, CHILD_BINDING_ENV, safeText, terminalTaskStates,
    getPackageDir: forbidden, getAgentDir: forbidden, loadLocalConfig: forbidden, prepareStorage: forbidden, setTimeout: forbidden, setInterval: forbidden, ...context });
  const instantiate = (api = {}) => {
    const tools = []; const commands = []; const commandHandlers = new Map(); const events = []; const handlers = new Map();
    factory({ registerTool: (tool) => tools.push(tool), registerCommand: (name, command) => { commands.push(name); commandHandlers.set(name, command.handler); },
      on: (name, handler) => { events.push(name); handlers.set(name, handler); }, ...api });
    return { tools, commands, commandHandlers, events, handlers };
  };
  return { ...instantiate(api), factory, instantiate };
}

test("one VM factory registers independent adapters without starting resources", () => {
  const first = load({});
  const second = first.instantiate();
  assert.equal(first.tools.length, 15);
  assert.equal(second.tools.length, 15);
  assert.deepEqual(second.events, ["resources_discover", "session_start", "agent_start", "agent_settled", "session_shutdown"]);
  assert.notEqual(first.handlers.get("session_start"), second.handlers.get("session_start"));
  assert.deepEqual(Array.from(second.handlers.get("resources_discover")().skillPaths), [join(dirname(fileURLToPath(moduleUrl)), "skills", "rpc-subagents", "SKILL.md")]);
});

test("adapter factory registers unique codemode tools with directly accessible structured result declarations but starts no resources", () => {
  const registry = load({});
  assert.deepEqual(registry.tools.map((tool) => tool.name), ["rpc_subagents_run", "rpc_subagents_status", "rpc_subagents_result", "rpc_subagents_wait", "rpc_subagents_cancel", "rpc_subagents_respond", "rpc_subagents_pending", "rpc_subagents_reply", "rpc_subagents_steer", "rpc_subagents_view", "rpc_subagents_schedule_create", "rpc_subagents_schedule_list", "rpc_subagents_schedule_pause", "rpc_subagents_schedule_resume", "rpc_subagents_schedule_cancel"]);
  const run = registry.tools[0];
  assert.equal(run.exposure, "codemode");
  assert.equal(run.outputSchema.properties.taskId.type, "string");
  assert.equal(run.outputSchema.properties.text.type, "string");
  assert.equal(run.outputSchema.properties.tps.type, "number");
  assert.deepEqual(Array.from(run.outputSchema.properties.thinking.anyOf, (value) => value.const), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(run.outputSchema.properties.timeoutMs.type, "integer");
  assert.equal(run.outputSchema.properties.status.anyOf.some((value) => value.const === "completed"), true);
  assert.equal(run.parameters.properties.tools.maxItems, 64);
  assert.equal(run.parameters.properties.session.maxLength, 4096);
  assert.equal(run.outputSchema.properties.sessionReusable.type, "boolean");
  for (const tool of registry.tools) {
    assert.doesNotMatch(JSON.stringify(tool.parameters), /webAccess/, tool.name);
    assert.doesNotMatch(JSON.stringify(tool.outputSchema), /webAccess/, tool.name);
    assert.doesNotMatch(tool.namespace.instructions, /webAccess/, tool.name);
  }
  assert.equal(run.outputSchema.properties.capabilities.properties.webTools.maxItems, 16);
  assert.equal(run.outputSchema.properties.capabilities.properties.reachable.type, "array");
  assert.equal(run.outputSchema.properties.capabilities.properties.exposures.additionalProperties.anyOf.some((value) => value.const === "model-only"), true);
  assert.equal(run.outputSchema.properties.reports.items.properties.seq.type, "integer");
  assert.equal(run.outputSchema.properties.requests.items.properties.requestId.type, "string");
  assert.equal(registry.tools.every((tool) => tool.exposure === "codemode" && tool.namespace.name === "rpc_subagents"), true);
  const pending = registry.tools.find((tool) => tool.name === "rpc_subagents_pending");
  assert.equal(pending.annotations.readOnlyHint, true);
  assert.equal(pending.parameters.properties.limit.maximum, 64);
  assert.equal(pending.outputSchema.properties.nextAfter.type, "integer");
  const reply = registry.tools.find((tool) => tool.name === "rpc_subagents_reply");
  assert.equal(reply.annotations.readOnlyHint, false);
  assert.equal(reply.parameters.properties.value.maxLength, 65536);
  assert.equal(Object.hasOwn(reply.parameters.properties, "confirmed"), false);
  const steer = registry.tools.find((tool) => tool.name === "rpc_subagents_steer");
  assert.equal(steer.parameters.properties.message.maxLength, 8192);
  assert.equal(steer.outputSchema.properties.disposition.anyOf.some((value) => value.const === "queued"), true);
  assert.deepEqual(registry.commands, ["rpc-subagents", "rpc-subagents-output", "rpc-subagents-view"]);
  assert.deepEqual(registry.events, ["resources_discover", "session_start", "agent_start", "agent_settled", "session_shutdown"]);
});

test("output command toggles installed TUI preview, resets on session start, and rejects unavailable modes", async () => {
  let expanded = false;
  const registry = load({}, {
    loadLocalConfig: async () => ({}), prepareStorage: async () => ({ dataRoot: "/data", configFile: "/config.json", configDir: "/", migrated: {} }), getPackageDir: () => "/pi", getAgentDir: () => "/agent",
    resolveCliEntrypoint: () => "/pi/cli", createTaskPreparer: () => () => {},
    FleetManager: class { subscribe() { return () => {}; } list() { return []; } async shutdown() {} },
    ScheduleManager: class { subscribe() { return () => {}; } async start() {} async shutdown() {} list() { return []; } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: async (cwd) => cwd, projectKey: () => "project",
    installFleetWidget: () => { expanded = false; return { toggle() { expanded = !expanded; } }; },
  });
  const command = registry.commandHandlers.get("rpc-subagents-output");
  const ctx = { mode: "tui", hasUI: true, cwd: "/project", ui: { notify() {}, setWidget() {} } };
  await assert.rejects(command("", ctx), /has not started yet/);
  for (const mode of ["rpc", "json", "print"]) await assert.rejects(command("", { ...ctx, mode }), /TUI/);
  await registry.handlers.get("session_start")({}, ctx);
  await command("", ctx);
  assert.equal(expanded, true);
  await command("", ctx);
  assert.equal(expanded, false);
  await command("", ctx);
  await registry.handlers.get("session_start")({}, ctx);
  assert.equal(expanded, false);
  await registry.handlers.get("session_shutdown")({}, ctx);
  await assert.rejects(command("", ctx), /has not started yet/);
});

test("task output schema accepts new metadata and legacy results without it", {
  skip: !process.env.RPC_SUBAGENTS_PI_PACKAGE && "Set RPC_SUBAGENTS_PI_PACKAGE to validate the installed TypeBox schema",
}, async () => {
  const build = join(process.env.RPC_SUBAGENTS_PI_PACKAGE, "node_modules", "typebox", "build");
  const { Type } = await import(pathToFileURL(join(build, "index.mjs")).href);
  const { Check } = await import(pathToFileURL(join(build, "value", "index.mjs")).href);
  const outputSchema = load({}, { Type }).tools.find((tool) => tool.name === "rpc_subagents_result").outputSchema;
  const legacy = { taskId: "task-1", name: "legacy", model: { provider: "test", id: "model" }, cwd: "/project",
    status: "completed", state: { status: "completed" }, text: "done", truncated: false, createdAt: 0,
    currentTools: [], eventFile: "/events.jsonl", ownerId: "owner-1", ownerPid: 1 };
  assert.equal(Check(outputSchema, legacy), true);
  assert.equal(Check(outputSchema, { ...legacy, tps: 12.5 }), true);
  assert.equal(Check(outputSchema, { ...legacy, tps: "12.5" }), false);
  for (const thinking of ["high", "off"]) assert.equal(Check(outputSchema, { ...legacy, thinking, timeoutMs: 150 }), true);
  assert.equal(Check(outputSchema, { ...legacy, thinking: "unknown" }), false);
});

test("README startup allowlist preserves all fifteen registered codemode tools", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const names = readme.match(/^pi --tools (.+)$/m)[1].split(",");
  assert.ok(names.includes("codemode"));
  for (const tool of load({}).tools) assert.ok(names.includes(tool.name), `${tool.name} is missing from the documented allowlist`);
});

test("schedule_list on a new cwd reads an unchanged snapshot without constructing an owner or timer", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-list-adapter-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = join(directory, "data", "projects", projectKey(directory));
  const manager = new ScheduleManager({ directory: store, cwd: directory, fleet: {}, now: () => 100000,
    setTimer() { return {}; }, clearTimer() {} });
  await manager.create({ task: { prompt: "read only", cwd: directory, model: { provider: "test", id: "model" } }, trigger: { type: "at", at: "+1h" } });
  await manager.shutdown();
  const before = await readFile(join(store, "schedules.json"), "utf8");
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), prepareStorage: async () => ({ dataRoot: join(directory, "data"), configFile: join(directory, "config.json"), configDir: directory, migrated: {} }), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: class { subscribe() { return () => {}; } list() { return []; } },
    ScheduleManager: class { constructor() { throw new Error("Read-only list tried to create an owner"); } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules });
  const tool = registry.tools.find((tool) => tool.name === "rpc_subagents_schedule_list");
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = await tool.execute("list", { cwd: directory }, undefined, undefined, { cwd: directory });
  assert.equal(result.structuredContent.schedules.length, 1);
  assert.equal(result.structuredContent.schedules[0].state.status, "active");
  assert.equal(await readFile(join(store, "schedules.json"), "utf8"), before);
  assert.deepEqual(await readdir(store), ["schedules.json"]);
});

test("RPC_SUBAGENTS_CHILD prevents all tool, command, and lifecycle registration", () => {
  assert.equal(load({}).tools.length, 15);
  const child = load({ RPC_SUBAGENTS_CHILD: "1" });
  assert.deepEqual(child.tools, []);
  assert.deepEqual(child.commands, []);
  assert.deepEqual(child.events, []);
});

test("schedule_create rejects session continuation before acquiring a schedule owner", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-schedule-session-adapter-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: class { subscribe() { return () => {}; } list() { return []; } },
    ScheduleManager: class { constructor() { throw new Error("Schedule owner was created before the session rejection"); } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules });
  const tool = registry.tools.find((tool) => tool.name === "rpc_subagents_schedule_create");
  await assert.rejects(tool.execute("create", { task: { prompt: "resume", session: "/tmp/owned.jsonl" }, trigger: { type: "at", at: "+10m" } }, undefined, undefined, { cwd: directory }),
    /Schedules cannot continue an existing session/);
});

test("pending child asks wake the parent exactly once, forward explicit replies, and dispose on shutdown", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-notify-adapter-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = []; const listeners = new Set(); const calls = []; const messages = []; const notices = [];
  let attempts = 0; let failNext = false;
  class FakeFleet {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    list() { return structuredClone(tasks); }
    status(taskId) { return structuredClone(tasks.find((task) => task.taskId === taskId)); }
    pending(taskId, options) { calls.push(["pending", taskId, options]); return Promise.resolve({ requests: [], reports: [], nextAfter: 0, droppedThrough: 0 }); }
    reply(taskId, requestId, answer) { calls.push(["reply", taskId, requestId, answer]); return Promise.resolve({ taskId }); }
    steer(taskId, message) { calls.push(["steer", taskId, message]); return Promise.resolve({ taskId, disposition: "queued" }); }
    shutdown() { return Promise.resolve(); }
  }
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), prepareStorage: async () => ({ dataRoot: join(directory, "data"), configFile: join(directory, "config.json"), configDir: directory, migrated: {} }), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: FakeFleet, ScheduleManager: class { subscribe() { return () => {}; } async start() {} async shutdown() {} list() { return []; } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules },
    { sendMessage: (message, options) => { attempts++; if (failNext) throw new Error("session is closing"); messages.push({ message, options }); } });
  const ctx = { mode: "print", hasUI: true, cwd: directory, ui: { notify: (message, type) => notices.push([message, type]) } };
  await registry.handlers.get("session_start")({ type: "session_start" }, ctx);
  assert.equal(listeners.size, 3);
  const tick = () => { for (const listener of [...listeners]) listener(); };
  tasks.push({ taskId: "task-1", state: { status: "waiting_input", dialogs: [], requests: [{ requestId: "ask-1", question: "Approve?", expiresAt: 5 }] } });
  tick(); tick();
  assert.equal(messages.length, 1);
  assert.equal(attempts, 1);
  assert.equal(messages[0].options.deliverAs, "followUp");
  assert.equal(messages[0].options.triggerTurn, true);
  assert.ok(messages[0].message.content.includes("task-1") && messages[0].message.content.includes("ask-1"));
  assert.equal(messages[0].message.details.taskId, "task-1");
  assert.equal(messages[0].message.details.requestId, "ask-1");
  tasks[0].state.requests.push({ requestId: "ask-2", question: "And?", expiresAt: 5 });
  tick();
  assert.equal(messages.length, 2);
  tasks.push({ taskId: "task-2", state: { status: "waiting_input", dialogs: [], requests: [] } });
  tick();
  assert.equal(messages.length, 2);
  failNext = true;
  tasks.push({ taskId: "task-3", state: { status: "waiting_input", dialogs: [], requests: [{ requestId: "ask-9", question: "Retry?", expiresAt: 5 }] } });
  tick(); tick();
  assert.equal(messages.length, 2);
  assert.equal(attempts, 4);
  assert.equal(notices.length, 1);
  assert.equal(notices[0][1], "warning");
  failNext = false;
  tick();
  assert.equal(messages.length, 3);
  assert.equal(attempts, 5);
  tick();
  assert.equal(messages.length, 3);
  tasks.splice(tasks.findIndex((task) => task.taskId === "task-3"), 1);
  tick();
  tasks.push({ taskId: "task-3", state: { status: "waiting_input", dialogs: [], requests: [{ requestId: "ask-9", question: "Retry?", expiresAt: 5 }] } });
  tick();
  assert.equal(messages.length, 4);
  assert.equal(calls.length, 0);
  const reply = registry.tools.find((tool) => tool.name === "rpc_subagents_reply");
  await reply.execute("reply", { taskId: "task-1", requestId: "ask-1", value: "yes" }, undefined, undefined, ctx);
  await reply.execute("reply", { taskId: "task-1", requestId: "ask-1", cancelled: true }, undefined, undefined, ctx);
  const steer = registry.tools.find((tool) => tool.name === "rpc_subagents_steer");
  await steer.execute("steer", { taskId: "task-1", message: "keep going" }, undefined, undefined, ctx);
  const pending = registry.tools.find((tool) => tool.name === "rpc_subagents_pending");
  await pending.execute("pending", { taskId: "task-1", after: 3, limit: 5 }, undefined, undefined, ctx);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call[0]), ["reply", "reply", "steer", "pending"]);
  assert.equal(calls[0][1], "task-1");
  assert.equal(calls[0][2], "ask-1");
  assert.equal(calls[0][3].value, "yes");
  assert.equal(calls[1][3].cancelled, true);
  assert.equal(calls[2][1], "task-1");
  assert.equal(calls[2][2], "keep going");
  assert.equal(calls[3][1], "task-1");
  assert.equal(calls[3][2].after, 3);
  assert.equal(calls[3][2].limit, 5);
  await registry.handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
  assert.equal(listeners.size, 0);
});

test("async run tasks wake the parent once when they finish, while sync and scheduled tasks stay silent", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-completion-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = []; const listeners = new Set(); const messages = [];
  let nextId = 0;
  class FakeFleet {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    list() { return structuredClone(tasks); }
    run(spec) {
      const task = { taskId: `task-${++nextId}`, status: spec.async ? "queued" : "completed", state: { status: spec.async ? "queued" : "completed" } };
      tasks.push(task);
      return Promise.resolve(structuredClone(task));
    }
    shutdown() { return Promise.resolve(); }
  }
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), prepareStorage: async () => ({ dataRoot: join(directory, "data"), configFile: join(directory, "config.json"), configDir: directory, migrated: {} }), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: FakeFleet, ScheduleManager: class { subscribe() { return () => {}; } async start() {} async shutdown() {} list() { return []; } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules, normalizeTaskSpec: (input) => ({ ...input, context: "fresh" }) },
    { sendMessage: (message, options) => messages.push({ message, options }) });
  const ctx = { mode: "print", hasUI: false, cwd: directory, model: { provider: "test", id: "model" } };
  await registry.handlers.get("session_start")({ type: "session_start" }, ctx);
  const tick = () => { for (const listener of [...listeners]) listener(); };
  const finish = (taskId, status) => { const task = tasks.find((candidate) => candidate.taskId === taskId); task.status = status; task.state = { status }; tick(); };
  const run = registry.tools.find((tool) => tool.name === "rpc_subagents_run");
  const background = (await run.execute("run", { prompt: "work", cwd: directory, async: true }, undefined, undefined, ctx)).structuredContent;
  await run.execute("run", { prompt: "work", cwd: directory }, undefined, undefined, ctx);
  tasks.push({ taskId: "scheduled", status: "running", state: { status: "running" }, scheduleId: "schedule-1" });
  tick();
  assert.equal(messages.length, 0);
  finish("scheduled", "completed");
  finish(background.taskId, "failed");
  tick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.customType, "rpc-subagents-completion");
  assert.deepEqual({ ...messages[0].message.details }, { taskId: background.taskId, status: "failed" });
  assert.equal(messages[0].options.deliverAs, "followUp");
  assert.equal(messages[0].options.triggerTurn, true);
  await registry.handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
  assert.equal(listeners.size, 0);
});

async function loadWakeFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-observed-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = []; const listeners = new Set(); const messages = [];
  let nextId = 0;
  const fixture = { tasks, messages, waitImpl: undefined, failImmediately: false };
  const snapshot = (taskId) => structuredClone(tasks.find((task) => task.taskId === taskId));
  class FakeFleet {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    list() { return structuredClone(tasks); }
    run() {
      const task = { taskId: `task-${++nextId}`, status: "queued", state: { status: "queued" } };
      tasks.push(task);
      const accepted = structuredClone(task);
      if (fixture.failImmediately) { task.status = "failed"; task.state = { status: "failed" }; }
      return Promise.resolve(accepted);
    }
    status(taskId) { return Promise.resolve(snapshot(taskId)); }
    result(taskId) { return Promise.resolve(snapshot(taskId)); }
    wait(taskId, options) { return fixture.waitImpl(taskId, options); }
    async shutdown() {
      for (const task of tasks) if (task.status === "queued" || task.status === "running") { task.status = "interrupted"; task.state = { status: "interrupted" }; }
      for (const listener of [...listeners]) listener();
    }
  }
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), prepareStorage: async () => ({ dataRoot: join(directory, "data"), configFile: join(directory, "config.json"), configDir: directory, migrated: {} }), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: FakeFleet, ScheduleManager: class { subscribe() { return () => {}; } async start() {} async shutdown() {} list() { return []; } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules, normalizeTaskSpec: (input) => ({ ...input, context: "fresh" }) },
    { sendMessage: (message, options) => messages.push({ message, options }) });
  const ctx = { mode: "print", hasUI: false, cwd: directory, model: { provider: "test", id: "model" } };
  await registry.handlers.get("session_start")({ type: "session_start" }, ctx);
  const call = (name, params) => registry.tools.find((tool) => tool.name === name).execute(name, params, undefined, undefined, ctx);
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return Object.assign(fixture, {
    emit: (name, event) => registry.handlers.get(name)(event),
    runAsync: async () => (await call("rpc_subagents_run", { prompt: "work", cwd: directory, async: true })).structuredContent,
    call,
    shutdownSession: () => registry.handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx),
    notify,
    finish: (taskId, status) => { const task = tasks.find((candidate) => candidate.taskId === taskId); task.status = status; task.state = { status }; notify(); },
  });
}

test("no completion is sent for a task interrupted by session_shutdown while the parent is idle", async (t) => {
  const f = await loadWakeFixture(t);
  await f.runAsync();
  await f.shutdownSession();
  assert.equal(f.tasks[0].status, "interrupted");
  assert.equal(f.messages.length, 0);
});

test("a task observed as terminal through wait in the same parent run does not wake the parent afterwards", async (t) => {
  const f = await loadWakeFixture(t);
  await f.emit("agent_start", { type: "agent_start" });
  const task = await f.runAsync();
  let release;
  f.waitImpl = () => new Promise((resolve) => { release = resolve; });
  const waited = f.call("rpc_subagents_wait", { taskId: task.taskId });
  await new Promise((resolve) => setImmediate(resolve));
  f.finish(task.taskId, "completed");
  assert.equal(f.messages.length, 0);
  release({ taskId: task.taskId, status: "completed", state: { status: "completed" } });
  await waited;
  await f.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(f.messages.length, 0);
});

test("a task observed as terminal before subscribers are notified does not wake the parent", async (t) => {
  const f = await loadWakeFixture(t);
  await f.emit("agent_start", { type: "agent_start" });
  const task = await f.runAsync();
  const stored = f.tasks.find((candidate) => candidate.taskId === task.taskId);
  stored.status = "completed";
  stored.state = { status: "completed" };
  const status = await f.call("rpc_subagents_status", { taskId: task.taskId });
  assert.equal(status.structuredContent.status, "completed");
  f.notify();
  await f.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(f.messages.length, 0);
});

test("an unobserved task that finishes during a parent run wakes the parent once at agent_settled", async (t) => {
  const f = await loadWakeFixture(t);
  await f.emit("agent_start", { type: "agent_start" });
  const task = await f.runAsync();
  f.finish(task.taskId, "failed");
  assert.equal(f.messages.length, 0);
  await f.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].message.customType, "rpc-subagents-completion");
  assert.deepEqual({ ...f.messages[0].message.details }, { taskId: task.taskId, status: "failed" });
  assert.deepEqual({ ...f.messages[0].options }, { deliverAs: "followUp", triggerTurn: true });
  await f.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(f.messages.length, 1);
});

for (const [label, observe] of [
  ["rpc_subagents_status with a taskId", (f, taskId) => f.call("rpc_subagents_status", { taskId })],
  ["rpc_subagents_status listing all tasks", (f) => f.call("rpc_subagents_status", {})],
  ["rpc_subagents_result", (f, taskId) => f.call("rpc_subagents_result", { taskId })],
]) {
  test(`${label} returning a terminal task suppresses its wake but not another task's`, async (t) => {
    const f = await loadWakeFixture(t);
    await f.emit("agent_start", { type: "agent_start" });
    const observed = await f.runAsync();
    const other = await f.runAsync();
    f.finish(observed.taskId, "completed");
    await observe(f, observed.taskId);
    f.finish(other.taskId, "failed");
    await f.emit("agent_settled", { type: "agent_settled", aborted: false });
    assert.equal(f.messages.length, 1);
    assert.deepEqual({ ...f.messages[0].message.details }, { taskId: other.taskId, status: "failed" });
  });
}

test("a wait that returns a non-terminal snapshot does not suppress the wake", async (t) => {
  const f = await loadWakeFixture(t);
  await f.emit("agent_start", { type: "agent_start" });
  const task = await f.runAsync();
  f.waitImpl = (taskId) => Promise.resolve({ taskId, status: "running", state: { status: "running" } });
  await f.call("rpc_subagents_wait", { taskId: task.taskId, timeoutMs: 50 });
  f.finish(task.taskId, "failed");
  await f.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(f.messages.length, 1);
  assert.deepEqual({ ...f.messages[0].message.details }, { taskId: task.taskId, status: "failed" });
});

test("an aborted wait does not suppress the wake", async (t) => {
  const f = await loadWakeFixture(t);
  await f.emit("agent_start", { type: "agent_start" });
  const task = await f.runAsync();
  f.waitImpl = () => Promise.reject(new Error("aborted"));
  await assert.rejects(f.call("rpc_subagents_wait", { taskId: task.taskId }), /aborted/);
  f.finish(task.taskId, "completed");
  await f.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(f.messages.length, 1);
  assert.deepEqual({ ...f.messages[0].message.details }, { taskId: task.taskId, status: "completed" });
});

test("an aborted parent run appends the wake without starting a new turn", async (t) => {
  const f = await loadWakeFixture(t);
  await f.emit("agent_start", { type: "agent_start" });
  const task = await f.runAsync();
  f.finish(task.taskId, "failed");
  await f.emit("agent_settled", { type: "agent_settled", aborted: true });
  assert.equal(f.messages.length, 1);
  assert.deepEqual({ ...f.messages[0].message.details }, { taskId: task.taskId, status: "failed" });
  assert.deepEqual({ ...f.messages[0].options }, { deliverAs: "followUp", triggerTurn: false });
});

test("a task already terminal when its async run returns queued wakes the parent at agent_settled", async (t) => {
  const f = await loadWakeFixture(t);
  await f.emit("agent_start", { type: "agent_start" });
  f.failImmediately = true;
  const task = await f.runAsync();
  assert.equal(task.status, "queued");
  assert.equal(f.messages.length, 0);
  await f.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(f.messages.length, 1);
  assert.deepEqual({ ...f.messages[0].message.details }, { taskId: task.taskId, status: "failed" });
});

test("a task evicted from the fleet before agent_settled still wakes the parent once", async (t) => {
  const f = await loadWakeFixture(t);
  await f.emit("agent_start", { type: "agent_start" });
  const task = await f.runAsync();
  f.finish(task.taskId, "failed");
  f.tasks.splice(0, f.tasks.length);
  await f.emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.equal(f.messages.length, 1);
  assert.deepEqual({ ...f.messages[0].message.details }, { taskId: task.taskId, status: "failed" });
});

for (const [aborted, expected] of [[false, [false, true]], [true, [false, false]]]) {
  test(`several completions flushed at agent_settled with aborted=${aborted} trigger at most one turn`, async (t) => {
    const f = await loadWakeFixture(t);
    await f.emit("agent_start", { type: "agent_start" });
    const first = await f.runAsync();
    const second = await f.runAsync();
    f.finish(first.taskId, "completed");
    f.finish(second.taskId, "failed");
    assert.equal(f.messages.length, 0);
    await f.emit("agent_settled", { type: "agent_settled", aborted });
    assert.deepEqual(f.messages.map(({ message }) => ({ ...message.details })), [{ taskId: first.taskId, status: "completed" }, { taskId: second.taskId, status: "failed" }]);
    assert.deepEqual(f.messages.map(({ options }) => options.triggerTurn), expected);
  });
}

test("wake bookkeeping follows currently pending request keys on a retained task", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-notify-prune-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasks = []; const listeners = new Set(); const messages = [];
  class FakeFleet {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    list() { return structuredClone(tasks); }
    status() { return undefined; }
    pending() { return Promise.resolve({ requests: [], reports: [], nextAfter: 0, droppedThrough: 0 }); }
    reply() { return Promise.resolve({}); }
    steer() { return Promise.resolve({}); }
    shutdown() { return Promise.resolve(); }
  }
  const registry = load({}, { dirname: () => directory, loadLocalConfig: async () => ({}), prepareStorage: async () => ({ dataRoot: join(directory, "data"), configFile: join(directory, "config.json"), configDir: directory, migrated: {} }), getPackageDir: () => directory, getAgentDir: () => directory,
    resolveCliEntrypoint: () => "/pi", createTaskPreparer: () => () => { throw new Error("No task preparation allowed"); },
    FleetManager: FakeFleet, ScheduleManager: class { subscribe() { return () => {}; } async start() {} async shutdown() {} list() { return []; } },
    HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey, readSchedules },
    { sendMessage: (message) => messages.push(message) });
  const ctx = { mode: "print", hasUI: true, cwd: directory, ui: { notify: () => {} } };
  await registry.handlers.get("session_start")({ type: "session_start" }, ctx);
  const tick = () => { for (const listener of [...listeners]) listener(); };
  const waiting = (requestId, question) => ({ taskId: "task-1", state: { status: "waiting_input", dialogs: [], requests: [{ requestId, question, expiresAt: 5 }] } });
  const idle = { taskId: "task-1", state: { status: "running", disposition: "started", dialogs: [], requests: [] } };
  tasks.push(waiting("ask-1", "First?"));
  tick(); tick();
  assert.equal(messages.length, 1);
  tasks[0] = idle;
  tick();
  tasks[0] = waiting("ask-2", "Second?");
  tick(); tick();
  assert.equal(messages.length, 2);
  tasks[0] = idle;
  tick();
  tasks[0] = waiting("ask-1", "Reused?");
  tick(); tick();
  assert.deepEqual(messages.map((message) => message.details.requestId), ["ask-1", "ask-2", "ask-1"]);
  tick(); tick();
  assert.equal(messages.length, 3);
  await registry.handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
  assert.equal(listeners.size, 0);
});
