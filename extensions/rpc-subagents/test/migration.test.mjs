import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { COORDINATION_LIMITS } from "../coordination.mjs";
import { safeText } from "../viewer.mjs";
import { projectKey } from "../store.mjs";
import { prepareStorage } from "../storage.mjs";

const schema = {
  String: (options = {}) => ({ type: "string", ...options }), Number: () => ({ type: "number" }), Integer: (options = {}) => ({ type: "integer", ...options }),
  Boolean: () => ({ type: "boolean" }), Null: () => ({ type: "null" }), Literal: (value) => ({ const: value }),
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }), Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Union: (anyOf) => ({ anyOf }), Optional: (value) => value, Record: (key, value) => ({ type: "object", key, additionalProperties: value }),
};
const moduleUrl = new URL("../index.ts", import.meta.url).href;
const source = stripTypeScriptTypes(await readFile(new URL(moduleUrl), "utf8"));
const factorySource = source.replace(/^import .*?;\s*$/gm, "").replace("export default function rpcSubagents", "function rpcSubagents").replaceAll("import.meta.url", "moduleUrl") + "\nrpcSubagents";

async function temporary(t, prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function load({ extensionDir, agentDir = extensionDir, calls, fleetOptions, scheduleOptions, configFiles = [] }) {
  const tools = []; const commands = []; const events = []; const handlers = new Map();
  const track = (name, fn) => (...args) => { calls.push(name); return fn(...args); };
  const factory = runInNewContext(factorySource, { process: { env: {} }, Type: schema, dirname: () => extensionDir, join, fileURLToPath, moduleUrl,
    COORDINATION_LIMITS, safeText, prepareStorage: track("prepareStorage", prepareStorage),
    loadLocalConfig: track("loadLocalConfig", async (file) => { configFiles.push(file); return {}; }), getPackageDir: track("getPackageDir", () => extensionDir),
    getAgentDir: track("getAgentDir", () => agentDir), resolveCliEntrypoint: track("resolveCliEntrypoint", () => "/pi"),
    createTaskPreparer: track("createTaskPreparer", () => async () => ({})),
    FleetManager: class { constructor(options) { fleetOptions.push(options); } subscribe() { return () => {}; } list() { return []; } shutdown() { return Promise.resolve(); } },
    ScheduleManager: class { constructor(options) { scheduleOptions.push(options); } subscribe() { return () => {}; } async start() {} list() { return []; } },
    readSchedules: track("readSchedules", () => []), HerdrOpener: class {}, createHerdrCliAdapter: () => ({}), canonicalCwd: realpath, projectKey,
    installFleetWidget: () => {}, showFleetScreen: async () => {},
    setTimeout: () => { throw new Error("Factory started a timer"); }, setInterval: () => { throw new Error("Factory started a timer"); } });
  factory({ registerTool: (tool) => tools.push(tool), registerCommand: (name) => commands.push(name), on: (name, handler) => { events.push(name); handlers.set(name, handler); } });
  return { tools, commands, events, handlers };
}

function sessionContext(directory) {
  return { mode: "print", hasUI: false, cwd: directory, ui: { notify() {} } };
}

async function tree(directory) {
  const result = {};
  async function walk(path, prefix) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { result[name + "/"] = ""; await walk(join(path, entry.name), name); }
      else result[name] = await readFile(join(path, entry.name), "utf8");
    }
  }
  await walk(directory, "");
  return result;
}

async function agentFixture(t, prefix) {
  const base = await temporary(t, prefix);
  const agentDir = join(base, "agent");
  const extensionDir = join(agentDir, "git", "github.com", "tp6gw94", "pi-extras", "extensions", "rpc-subagents");
  await mkdir(extensionDir, { recursive: true });
  const newRoot = join(agentDir, "rpc-subagents");
  const oldDir = join(agentDir, "extensions", "rpc-subagents");
  return { base, agentDir, extensionDir, newRoot, oldDir };
}

async function start(f) {
  const calls = []; const fleetOptions = []; const scheduleOptions = []; const configFiles = [];
  const registry = load({ extensionDir: f.extensionDir, agentDir: f.agentDir, calls, fleetOptions, scheduleOptions, configFiles });
  assert.deepEqual(calls, [], "factory must not resolve the data root or other runtime resources");
  await registry.handlers.get("session_start")({ type: "session_start" }, sessionContext(f.base));
  return { registry, calls, fleetOptions, scheduleOptions, configFiles };
}

test("initialize keeps data and config.json in <agentDir>/rpc-subagents, outside the package copy", async (t) => {
  const f = await agentFixture(t, "rpc-subagents-migration-clean-");
  const run = await start(f);
  assert.equal(run.calls[0], "getAgentDir");
  assert.equal(run.calls[1], "prepareStorage");
  assert.equal(run.fleetOptions.length, 1);
  assert.equal(run.fleetOptions[0].root, join(f.newRoot, "data"));
  assert.deepEqual(run.configFiles, [join(f.newRoot, "config.json")]);
  assert.equal(run.scheduleOptions.length, 1);
  assert.equal(run.scheduleOptions[0].directory, join(f.newRoot, "data", "projects", projectKey(await realpath(f.base))));
  assert.equal(existsSync(join(f.extensionDir, "data")), false, "nothing is written next to the extension code");
  assert.equal(existsSync(join(f.agentDir, "extensions")), false, "the old location is not created");
  assert.equal(existsSync(join(f.newRoot, "migration.json")), false);
});

test("initialize copies data and config.json from the old <agentDir>/extensions/rpc-subagents location once", async (t) => {
  const f = await agentFixture(t, "rpc-subagents-migration-old-");
  await mkdir(join(f.oldDir, "data", "tasks", "task-1"), { recursive: true });
  await writeFile(join(f.oldDir, "data", "tasks", "task-1", "state.json"), JSON.stringify({ taskId: "task-1", eventFile: join(f.oldDir, "data", "tasks", "task-1", "events.jsonl") }) + "\n");
  await writeFile(join(f.oldDir, "config.json"), JSON.stringify({ concurrency: 2 }));
  const before = await tree(f.oldDir);
  const run = await start(f);
  assert.equal(run.fleetOptions[0].root, join(f.newRoot, "data"));
  assert.deepEqual(run.configFiles, [join(f.newRoot, "config.json")]);
  const state = JSON.parse(await readFile(join(f.newRoot, "data", "tasks", "task-1", "state.json"), "utf8"));
  assert.equal(state.eventFile, join(f.newRoot, "data", "tasks", "task-1", "events.jsonl"), "paths into the old root move to the new root");
  assert.deepEqual(JSON.parse(await readFile(join(f.newRoot, "config.json"), "utf8")), { concurrency: 2 });
  const marker = JSON.parse(await readFile(join(f.newRoot, "migration.json"), "utf8"));
  assert.equal(marker.data.from, join(f.oldDir, "data"));
  assert.equal(marker.config.from, join(f.oldDir, "config.json"));
  assert.deepEqual(await tree(f.oldDir), before, "the old location is left untouched");

  await rm(join(f.newRoot, "data"), { recursive: true });
  await rm(join(f.newRoot, "config.json"));
  const again = await start(f);
  assert.equal(again.fleetOptions[0].root, join(f.newRoot, "data"));
  assert.equal(existsSync(join(f.newRoot, "data", "tasks")), false, "nothing is copied a second time");
  assert.equal(existsSync(join(f.newRoot, "config.json")), false);
  assert.deepEqual(await tree(f.oldDir), before);
});

test("initialize copies the older rpc-fleet/data first, as the old code preferred it", async (t) => {
  const f = await agentFixture(t, "rpc-subagents-migration-fleet-");
  const fleetData = join(f.agentDir, "extensions", "rpc-fleet", "data");
  await mkdir(join(fleetData, "projects"), { recursive: true });
  await writeFile(join(fleetData, "projects", "fleet.txt"), "rpc-fleet");
  await mkdir(join(f.oldDir, "data", "projects"), { recursive: true });
  await writeFile(join(f.oldDir, "data", "projects", "subagents.txt"), "rpc-subagents");
  const run = await start(f);
  assert.equal(run.fleetOptions[0].root, join(f.newRoot, "data"));
  assert.deepEqual(await readdir(join(f.newRoot, "data", "projects")), ["fleet.txt"]);
  assert.equal(JSON.parse(await readFile(join(f.newRoot, "migration.json"), "utf8")).data.from, fleetData);
});

test("initialize leaves the old location alone when the new location already has data", async (t) => {
  const f = await agentFixture(t, "rpc-subagents-migration-new-");
  await mkdir(join(f.newRoot, "data", "projects"), { recursive: true });
  await writeFile(join(f.newRoot, "data", "projects", "new.txt"), "new");
  await writeFile(join(f.newRoot, "config.json"), JSON.stringify({ concurrency: 3 }));
  await mkdir(join(f.oldDir, "data", "projects"), { recursive: true });
  await writeFile(join(f.oldDir, "data", "projects", "old.txt"), "old");
  await writeFile(join(f.oldDir, "config.json"), JSON.stringify({ concurrency: 9 }));
  const before = await tree(f.oldDir);
  const newBefore = await tree(f.newRoot);
  const run = await start(f);
  assert.equal(run.fleetOptions[0].root, join(f.newRoot, "data"));
  assert.deepEqual(await tree(f.oldDir), before);
  assert.deepEqual(await tree(f.newRoot), newBefore, "no copy and no migration marker");
});

test("ordinary factory registration and resource discovery stay lazy", async (t) => {
  const base = await temporary(t, "rpc-subagents-migration-lazy-");
  const extensionDir = join(base, "extensions", "rpc-subagents");
  await mkdir(extensionDir, { recursive: true });
  const calls = []; const fleetOptions = []; const scheduleOptions = [];
  const registry = load({ extensionDir, calls, fleetOptions, scheduleOptions });
  const discovered = await registry.handlers.get("resources_discover")({ type: "resources_discover", cwd: base, reason: "startup" }, {});
  assert.deepEqual([...discovered.skillPaths], [join(extensionDir, "skills", "rpc-subagents", "SKILL.md")]);
  assert.deepEqual(calls, [], "registration and resource discovery must not touch runtime resources");
  assert.equal(fleetOptions.length, 0);
  assert.equal(scheduleOptions.length, 0);
});
