import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRegistry } from "../sessions.mjs";
import { ScheduleManager } from "../schedules.mjs";
import { projectKey } from "../store.mjs";
import { legacyLayout, prepareStorage, storageLayout } from "../storage.mjs";
import { loadLocalConfig, providerExtensionPaths } from "../runtime.mjs";

const model = { provider: "test-provider", id: "test-model" };

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rpc-subagents-storage-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the layout lives in <agentDir>/rpc-subagents and the old one in <agentDir>/extensions", () => {
  assert.deepEqual(storageLayout("/a/agent"), { base: "/a/agent/rpc-subagents", dataRoot: "/a/agent/rpc-subagents/data",
    configFile: "/a/agent/rpc-subagents/config.json", marker: "/a/agent/rpc-subagents/migration.json" });
  assert.deepEqual(legacyLayout("/a/agent"), { dataRoots: ["/a/agent/extensions/rpc-fleet/data", "/a/agent/extensions/rpc-subagents/data"],
    configFiles: ["/a/agent/extensions/rpc-subagents/config.json"] });
});

test("neither location has data: nothing is copied and nothing is created", async (t) => {
  const agentDir = join(await temporary(t), "agent");
  const storage = await prepareStorage({ agentDir });
  assert.deepEqual(storage.migrated, {});
  assert.equal(storage.dataRoot, join(agentDir, "rpc-subagents", "data"));
  assert.equal(storage.configFile, join(agentDir, "rpc-subagents", "config.json"));
  assert.equal(existsSync(agentDir), false);
});

test("an empty old data directory is not data", async (t) => {
  const agentDir = join(await temporary(t), "agent");
  await mkdir(join(agentDir, "extensions", "rpc-subagents", "data"), { recursive: true });
  assert.deepEqual((await prepareStorage({ agentDir })).migrated, {});
  assert.equal(existsSync(join(agentDir, "rpc-subagents")), false);
});

test("data and config.json are migrated independently", async (t) => {
  const agentDir = join(await temporary(t), "agent");
  const oldDir = join(agentDir, "extensions", "rpc-subagents");
  await mkdir(join(oldDir, "data", "projects"), { recursive: true });
  await writeFile(join(oldDir, "data", "projects", "old.txt"), "old");
  await writeFile(join(oldDir, "config.json"), "{}");
  await mkdir(join(agentDir, "rpc-subagents"), { recursive: true });
  await writeFile(join(agentDir, "rpc-subagents", "config.json"), JSON.stringify({ concurrency: 5 }));
  const storage = await prepareStorage({ agentDir });
  assert.deepEqual(storage.migrated, { data: join(oldDir, "data") });
  assert.deepEqual(JSON.parse(await readFile(storage.configFile, "utf8")), { concurrency: 5 });
  assert.equal(await readFile(join(storage.dataRoot, "projects", "old.txt"), "utf8"), "old");
});

test("relative providerSources in an old config.json keep pointing where they did", async (t) => {
  const directory = await temporary(t);
  const agentDir = join(directory, "agent");
  const oldDir = join(agentDir, "extensions", "rpc-subagents");
  const provider = join(agentDir, "extensions", "my-provider");
  await mkdir(oldDir, { recursive: true }); await mkdir(provider);
  await writeFile(join(oldDir, "config.json"), JSON.stringify({ concurrency: 2, projects: { "/project": { providerSources: ["../my-provider", "/abs/elsewhere"] } } }));
  const storage = await prepareStorage({ agentDir });
  assert.equal(storage.migrated.config, join(oldDir, "config.json"));
  const config = await loadLocalConfig(storage.configFile);
  assert.equal(config.concurrency, 2);
  assert.deepEqual(config.projects["/project"].providerSources, [provider, "/abs/elsewhere"]);
  config.projects["/project"].providerSources = [provider];
  await mkdir(join(directory, "pkg", "rpc-subagents"), { recursive: true });
  assert.deepEqual(providerExtensionPaths({ extensionDir: join(directory, "pkg", "rpc-subagents"), configDir: storage.configDir, agentDir, cwd: "/project", config }), [provider]);
});

test("copied managed sessions and fork schedules stay usable from the new root", async (t) => {
  const directory = await temporary(t);
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "project"); await mkdir(cwd);
  const oldRoot = join(agentDir, "extensions", "rpc-subagents", "data");

  const owner = new SessionRegistry({ root: oldRoot, ownerId: "owner-one" });
  const lease = await owner.acquireFresh({ taskId: "task-one", directory: join(oldRoot, "tasks", "task-one"), cwd, model });
  const header = { type: "session", version: 3, id: "session-one", timestamp: "2026-01-01T00:00:00.000Z", cwd };
  await writeFile(lease.sessionFile, JSON.stringify(header) + "\n", { flag: "wx", mode: 0o600 });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  await owner.attach(lease, { childPid: child.pid });
  await owner.observe(lease, { sessionId: "session-one", sessionFile: lease.sessionFile, model });
  const closed = once(child, "close"); child.kill(); await closed;
  assert.equal((await owner.finalize(lease, { status: "completed", processClosed: true })).sessionReusable, true);
  await owner.release(lease);

  const project = (root) => join(root, "projects", projectKey(cwd));
  const timers = { setTimer: () => ({}), clearTimer() {}, now: () => 100000 };
  const before = new ScheduleManager({ directory: project(oldRoot), cwd, fleet: {}, ...timers });
  const created = await before.create({ task: { prompt: "fork", cwd, model, context: "fork" }, trigger: { type: "at", at: "+1h" } }, { template: { entries: [] } });
  await before.shutdown();
  assert.equal(created.templatePath.startsWith(oldRoot), true);
  const oldCatalog = await readdir(join(oldRoot, "session-catalog"));

  const storage = await prepareStorage({ agentDir });
  assert.deepEqual(storage.migrated, { data: oldRoot });
  const newRoot = storage.dataRoot;

  const resumed = new SessionRegistry({ root: newRoot, ownerId: "owner-two" });
  const resumeLease = await resumed.acquireResume({ taskId: "task-two", session: "session-one", cwd, model });
  assert.equal(resumeLease.sessionFile, join(newRoot, "tasks", "task-one", "session.jsonl"));
  await resumed.release(resumeLease, { neverLaunched: true });
  assert.notDeepEqual(await readdir(join(newRoot, "session-catalog")), oldCatalog, "the catalog is keyed by the new path");

  const after = new ScheduleManager({ directory: project(newRoot), cwd, fleet: {}, ...timers });
  await after.start();
  const [restored] = after.list();
  assert.equal(restored.scheduleId, created.scheduleId);
  assert.equal(restored.templatePath, join(project(newRoot), "templates", `${created.scheduleId}.json`));
  assert.deepEqual(await after.prepareTemplate(restored), { entries: [] });
  await after.shutdown();

  assert.deepEqual(await readdir(join(oldRoot, "session-catalog")), oldCatalog);
  const oldSchedules = JSON.parse(await readFile(join(project(oldRoot), "schedules.json"), "utf8"));
  assert.equal(oldSchedules.schedules[0].templatePath, created.templatePath);
});

test("a failed copy leaves no partial data and no marker", async (t) => {
  const agentDir = join(await temporary(t), "agent");
  const oldData = join(agentDir, "extensions", "rpc-subagents", "data");
  await mkdir(join(oldData, "projects"), { recursive: true });
  await writeFile(join(oldData, "projects", "x.txt"), "x");
  await mkdir(join(agentDir, "rpc-subagents"), { recursive: true });
  await writeFile(join(agentDir, "rpc-subagents", "data"), "a file where the data directory goes");
  await assert.rejects(prepareStorage({ agentDir }));
  assert.deepEqual((await readdir(join(agentDir, "rpc-subagents"))).sort(), ["data"]);
});
