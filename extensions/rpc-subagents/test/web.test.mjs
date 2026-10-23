import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeTaskSpec } from "../domain.mjs";
import { createTaskPreparer, resolveWebEntrypoint, CHILD_BINDING_ENV } from "../runtime.mjs";
import { readWebCatalog, webConfigPath } from "../web-policy.mjs";
import { PARENT_TOOL_NAME } from "../coordination.mjs";
import { ScheduleManager } from "../schedules.mjs";

const missingConfig = join(tmpdir(), "rpc-subagents-web-missing-config");
process.env.PI_CODING_AGENT_DIR = missingConfig;
const model = { provider: "test", id: "model" };
const defaultFamily = ["web_search", "source_check", "fetch_content", "get_search_content"];

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function withAgentDir(t, config) {
  const root = await temporary(t);
  const configDir = join(root, "config");
  await mkdir(configDir);
  if (config !== undefined) await writeFile(join(configDir, "web-search.json"), typeof config === "string" ? config : JSON.stringify(config));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  return { root, configDir };
}

async function launchFixture(t) {
  const root = await temporary(t);
  const agentDir = join(root, "agent");
  const extensionDir = join(root, "extension");
  const installed = join(agentDir, "npm", "node_modules", "pi-web-access");
  await mkdir(join(installed, "dist"), { recursive: true });
  await mkdir(extensionDir);
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "pi-web-access", pi: { extensions: ["./dist"] } }));
  await writeFile(join(installed, "dist", "index.js"), "export default function () {}\n");
  await writeFile(join(extensionDir, "child.ts"), "");
  const prepare = createTaskPreparer({ extensionDir, agentDir, cliPath: "/installed/pi", config: {} });
  const spec = (input) => normalizeTaskSpec({ prompt: "Inspect", cwd: root, model, ...input });
  const extensionsOf = (args) => args.flatMap((value, index) => value === "--extension" ? [args[index + 1]] : []);
  const allowlistOf = (args) => args[args.indexOf("--tools") + 1].split(",");
  return { root, agentDir, extensionDir, installed, prepare, spec, extensionsOf, allowlistOf };
}

test("the catalogue reports the mode, every enabled name and every reserved name", async (t) => {
  assert.equal(webConfigPath({ PI_CODING_AGENT_DIR: "/config" }, tmpdir()), join("/config", "web-search.json"));
  const missing = readWebCatalog({ PI_CODING_AGENT_DIR: missingConfig }, tmpdir());
  assert.equal(missing.mode, "auto");
  assert.deepEqual(missing.enabled, defaultFamily);
  assert.equal(missing.reserved.has("fetch_content"), true);
  assert.equal(missing.reserved.has("web_enable"), true);
  assert.equal(Object.hasOwn(missing, "slots"), false);

  const { configDir } = await withAgentDir(t, { toolActivation: "eager", toolNames: { fetchContent: "get_page" },
    tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } });
  const renamed = readWebCatalog({ PI_CODING_AGENT_DIR: configDir }, tmpdir());
  assert.equal(renamed.mode, "eager");
  assert.deepEqual(renamed.enabled, ["get_page"]);
  assert.equal(renamed.reserved.has("fetch_content"), true);
  assert.equal(renamed.reserved.has("get_page"), true);
});

test("the catalogue rejects unsupported activation modes, malformed names and reserved collisions", async (t) => {
  for (const config of [{ toolActivation: "sometimes" }, { toolActivation: "none" }, { toolNames: { fetchContent: "read" } },
    { toolNames: { fetchContent: "rpc_subagents_parent" } }, { toolNames: { fetchContent: "web_search" } },
    { toolNames: { fetchContent: "web_enable" } }, { toolNames: { fetchContent: "Bad Name" } }]) {
    const { configDir } = await withAgentDir(t, config);
    assert.throws(() => readWebCatalog({ PI_CODING_AGENT_DIR: configDir }, tmpdir()), /pi-web-access|reserved|Duplicate|collides/, JSON.stringify(config));
  }
  const { configDir } = await withAgentDir(t, "{invalid json");
  assert.throws(() => readWebCatalog({ PI_CODING_AGENT_DIR: configDir }, tmpdir()), /Cannot parse installed pi-web-access configuration/);
});

test("web access defaults to off and the installed catalogue only decides the enabled family", async (t) => {
  const { configDir } = await withAgentDir(t, { webSearch: { enabled: false }, tools: { sourceCheck: { enabled: false } } });
  const catalog = readWebCatalog({ PI_CODING_AGENT_DIR: configDir }, tmpdir());
  assert.deepEqual(catalog.enabled, ["fetch_content", "get_search_content"]);
  const spec = (input) => normalizeTaskSpec({ prompt: "Inspect", cwd: configDir, model, ...input });
  assert.deepEqual(spec({}), { prompt: "Inspect", name: "RPC task", cwd: configDir, model,
    webAccess: false, thinking: "off", context: "fresh", tools: ["read", "write", "edit", "bash", "codemode"], async: false, timeoutMs: 1800000 });
  assert.equal(spec({ tools: ["read"] }).webAccess, false);
  assert.equal(spec({ tools: [], webAccess: true }).webAccess, true);
  assert.deepEqual(spec({ tools: ["read", "bash"], webAccess: true }).tools, ["read", "bash"]);
  assert.deepEqual(spec(spec({ tools: ["read"], webAccess: true })), spec({ tools: ["read"], webAccess: true }));
});

test("preparation resolves web tools before the session file, loads the trusted entrypoint ahead of the child bridge and passes the expected web tool list", async (t) => {
  const f = await launchFixture(t);
  const { configDir } = await withAgentDir(t, { toolActivation: "dynamic" });
  const entrypoint = resolveWebEntrypoint(f.agentDir);
  const off = await f.prepare(f.spec({ tools: [], webAccess: false }), { directory: join(f.root, "off") });
  assert.deepEqual(f.allowlistOf(off.args), [PARENT_TOOL_NAME]);
  assert.deepEqual(off.webTools, []);
  assert.equal(f.extensionsOf(off.args).includes(entrypoint), false);
  assert.equal(off.env[CHILD_BINDING_ENV.webTools], undefined);

  const on = await f.prepare(f.spec({ tools: [], webAccess: true }), { directory: join(f.root, "on"), taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1" });
  assert.deepEqual(f.allowlistOf(on.args), [PARENT_TOOL_NAME, ...defaultFamily, "web_enable"]);
  assert.deepEqual(on.webTools, [...defaultFamily, "web_enable"]);
  assert.deepEqual(f.extensionsOf(on.args).filter((path) => path === entrypoint), [entrypoint]);
  const onExtensions = f.extensionsOf(on.args);
  assert.equal(onExtensions.indexOf(entrypoint) < onExtensions.indexOf(join(f.extensionDir, "child.ts")), true, onExtensions.join(", "));
  assert.equal(on.env[CHILD_BINDING_ENV.webTools], [...defaultFamily, "web_enable"].join(","));
  assert.equal(on.env[CHILD_BINDING_ENV.taskId], "task-1");

  await writeFile(join(configDir, "web-search.json"), JSON.stringify({ toolActivation: "eager", toolNames: { fetchContent: "get_page" },
    tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } }));
  const eager = await f.prepare(f.spec({ tools: ["read"], webAccess: true }), { directory: join(f.root, "eager") });
  assert.deepEqual(f.allowlistOf(eager.args), ["read", PARENT_TOOL_NAME, "get_page"]);
  assert.deepEqual(eager.webTools, ["get_page"]);

  await writeFile(join(configDir, "web-search.json"), JSON.stringify({ tools: { fetchContent: { enabled: false }, sourceCheck: { enabled: false },
    getSearchContent: { enabled: false } } }));
  const dynamic = await f.prepare(f.spec({ tools: [], webAccess: true }), { directory: join(f.root, "dynamic") });
  assert.deepEqual(dynamic.webTools, ["web_search", "web_enable"]);

  await writeFile(join(configDir, "web-search.json"), JSON.stringify({ tools: { webSearch: { enabled: false }, sourceCheck: { enabled: false },
    fetchContent: { enabled: false }, getSearchContent: { enabled: false } } }));
  await assert.rejects(f.prepare(f.spec({ tools: [], webAccess: true }), { directory: join(f.root, "disabled") }), /all installed web tools are disabled/);
  await writeFile(join(configDir, "web-search.json"), JSON.stringify({ toolActivation: "dynamic" }));
  await rm(join(f.installed, "dist", "index.js"));
  await assert.rejects(f.prepare(f.spec({ tools: [], webAccess: true }), { directory: join(f.root, "missing") }), /trusted installed pi-web-access/);
  const stillOff = await f.prepare(f.spec({ tools: ["read"], webAccess: false }), { directory: join(f.root, "still-off") });
  assert.deepEqual(f.allowlistOf(stillOff.args), ["read", PARENT_TOOL_NAME]);
});

test("web access off tolerates a malformed installed configuration and never reads it", async (t) => {
  const f = await launchFixture(t);
  await withAgentDir(t, "{invalid json");
  for (const [index, input] of [{ tools: [] }, { tools: ["read"] }, { tools: ["+bash", "-edit", "-codemode"] }, { tools: [], webAccess: false }].entries()) {
    const prepared = await f.prepare(f.spec(input), { directory: join(f.root, `off-${index}`) });
    assert.deepEqual(prepared.webTools, []);
    assert.equal(prepared.env[CHILD_BINDING_ENV.webTools], undefined);
  }
  assert.throws(() => f.spec({ tools: ["custom.inspect"], webAccess: false }), /Cannot parse installed pi-web-access configuration/);
});

test("schedules persist execution tools and the web access flag across normalization and restore", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-schedules-")));
  const storeA = join(root, "a"); await mkdir(storeA);
  const manager = new ScheduleManager({ directory: storeA, cwd: root, fleet: {}, now: () => 100000, setTimer: () => ({}), clearTimer() {} });
  const record = await manager.create({ task: { prompt: "Inspect", cwd: root, model, tools: ["read", "bash"], webAccess: true }, trigger: { type: "at", at: "+1h" } });
  assert.deepEqual(record.task.tools, ["read", "bash"]);
  assert.equal(record.task.webAccess, true);
  const persisted = JSON.parse(await readFile(join(storeA, "schedules.json"), "utf8"));
  assert.equal(JSON.stringify(persisted).includes("webTools"), false);
  assert.equal(persisted.schedules[0].task.webAccess, true);
  assert.deepEqual(normalizeTaskSpec({ ...persisted.schedules[0].task, async: true }), record.task);
  const off = await manager.create({ task: { prompt: "Inspect", cwd: root, model, tools: ["+bash"] }, trigger: { type: "at", at: "+1h" } });
  assert.equal(off.task.webAccess, false);
  assert.deepEqual(off.task.tools, ["read", "write", "edit", "bash", "codemode"]);
  await manager.shutdown();
  const storeB = join(root, "b"); await mkdir(storeB);
  await writeFile(join(storeB, "schedules.json"), await readFile(join(storeA, "schedules.json")));
  const restored = new ScheduleManager({ directory: storeB, cwd: root, fleet: {}, now: () => 100000, setTimer: () => ({}), clearTimer() {} });
  await restored.start();
  t.after(async () => { await restored.shutdown(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); });
  assert.equal(restored.get(record.scheduleId).task.webAccess, true);
  assert.deepEqual(restored.get(record.scheduleId).task.tools, ["read", "bash"]);
  assert.equal(restored.get(off.scheduleId).task.webAccess, false);
});
