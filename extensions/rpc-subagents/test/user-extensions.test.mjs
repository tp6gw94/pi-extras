import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeTaskSpec } from "../domain.mjs";
import { createTaskPreparer, providerExtensionPaths, resolveCliEntrypoint } from "../runtime.mjs";
import { userExtensionPaths, EXCLUDED_EXTENSION_IDS } from "../user-extensions.mjs";
import { childEnvironment } from "../transport.mjs";
import { decodeCoordinationEnvelope, BOOTSTRAP_COMMAND_NAME, PARENT_TOOL_NAME } from "../coordination.mjs";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(extensionDir));
const envPackage = process.env.RPC_SUBAGENTS_PI_PACKAGE;
const packageDir = envPackage ?? join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const pi = await import(pathToFileURL(join(packageDir, "dist", "index.js")).href);
const cliPath = envPackage ? resolveCliEntrypoint(envPackage) : undefined;
const realSkip = !envPackage && "Set RPC_SUBAGENTS_PI_PACKAGE to run real Pi children";
let taskCounter = 0;
const binding = { taskId: "ux-task", ownerId: "ux-owner", nonce: "ux-nonce" };

const probeSource = `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerProvider("testprov", { baseUrl: process.env.PROBE_BASE_URL, api: "openai-completions", apiKey: "probe-key",
    models: [{ id: "probe-model", name: "Probe", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  pi.on("session_start", () => writeFileSync(process.env.PROBE_OUT, JSON.stringify({
    tools: pi.getAllTools().map((tool) => tool.name), commands: pi.getCommands().map((command) => command.name) })));
}
`;
const toolSource = (name) => `export default function (pi) {
  pi.registerTool({ name: "${name}", label: "${name}", description: "${name}", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "${name}" }], details: {} }) });
}
`;

async function fixture(t, packages) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-user-ext-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const pkg = join(root, "pkg");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(pkg, { recursive: true });
  await writeFile(join(agentDir, "extensions", "probe.ts"), probeSource);
  await writeFile(join(cwd, ".pi", "extensions", "proj.ts"), toolSource("proj_tool"));
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "filtered-pkg", keywords: ["pi-package"], pi: { extensions: ["./a.ts", "./b.ts"] } }));
  await writeFile(join(pkg, "a.ts"), toolSource("pkg_a"));
  await writeFile(join(pkg, "b.ts"), toolSource("pkg_b"));
  const alias = join(root, "alias");
  await mkdir(alias);
  await writeFile(join(alias, "package.json"), JSON.stringify({ name: "my-extras", keywords: ["pi-package"], pi: { extensions: ["./extensions/*/index.ts"] } }));
  await symlink(join(repoRoot, "extensions"), join(alias, "extensions"));
  await symlink(join(repoRoot, "node_modules"), join(alias, "node_modules"));
  const sources = { repo: repoRoot, alias, filtered: { source: pkg, extensions: ["a.ts"] } };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: packages.map((key) => sources[key]) }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: pkg }] }));
  return { root, agentDir, cwd, pkg, alias };
}

function startProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push({ url: request.url, body: raw });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "probe-model" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "probe done" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const preparerFor = (f, notices = []) => createTaskPreparer({ extensionDir, agentDir: f.agentDir, cliPath: cliPath ?? "pi", config: { commandTimeoutMs: 30000 },
  resolveUserExtensions: (cwd) => userExtensionPaths({ pi, cwd, agentDir: f.agentDir }), notify: (message) => notices.push(message) });

async function prepareChild(f, { notices = [], extraArgs = [], prepare = preparerFor(f, notices) } = {}) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  try {
    const spec = normalizeTaskSpec({ prompt: "probe", name: "probe", cwd: f.cwd, tools: ["read"], model: { provider: "testprov", id: "probe-model" } });
    const prepared = await prepare(spec, { directory: join(f.root, `task-${++taskCounter}`), ...binding });
    const tools = prepared.args.indexOf("--tools") + 1;
    prepared.args[tools] = `${prepared.args[tools]},rpc_subagents,pkg_a,pkg_b,proj_tool`;
    prepared.args.push(...extraArgs);
    return prepared;
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

const extensionsOf = (args) => args.flatMap((value, index) => value === "--extension" ? [args[index + 1]] : []);

async function runChild(t, f, prepared) {
  const provider = await startProvider();
  const out = join(f.root, "probe.json");
  const child = spawn(process.execPath, [cliPath, "--mode", "rpc", ...prepared.args], { cwd: f.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"],
    env: childEnvironment({ ...prepared.env, PI_CODING_AGENT_DIR: f.agentDir, PROBE_OUT: out, PROBE_BASE_URL: provider.url, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }) });
  const records = [];
  let stderr = "";
  let buffer = "";
  const waiters = new Set();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try { records.push(JSON.parse(line)); } catch {}
      for (const waiter of waiters) waiter();
    }
  });
  t.after(async () => {
    child.kill("SIGKILL");
    provider.server.closeAllConnections?.();
    await new Promise((resolve) => provider.server.close(resolve));
  });
  const waitFor = (check, label, ms = 60000) => new Promise((resolve, reject) => {
    const waiter = () => { if (check()) { waiters.delete(waiter); clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out on ${label}: ${stderr.slice(-2000)} ${JSON.stringify(records.slice(-5)).slice(0, 2000)}`)); }, ms);
    waiters.add(waiter);
    waiter();
  });
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  send({ id: "bootstrap", type: "prompt", message: `/${BOOTSTRAP_COMMAND_NAME}` });
  const inventory = () => records.filter((r) => r.type === "extension_ui_request" && r.method === "notify")
    .map((r) => decodeCoordinationEnvelope(r.message, binding)).find((e) => e?.kind === "inventory");
  await waitFor(() => inventory() !== undefined, "child bridge inventory");
  const probe = JSON.parse(await readFile(out, "utf8"));
  send({ id: "run", type: "prompt", message: "say hi" });
  await waitFor(() => records.some((r) => r.type === "agent_settled") || records.some((r) => r.type === "agent_end"), "agent end");
  const text = JSON.stringify(records.filter((r) => r.type === "message_end" || r.type === "agent_end"));
  return { probe, inventory: inventory().inventory, requests: provider.requests, answered: text.includes("probe done") };
}

function assertChildBasics(result) {
  assert.equal(result.probe.tools.includes("rpc_subagents"), false, JSON.stringify(result.probe.tools));
  assert.equal(result.probe.commands.some((name) => name.startsWith("rpc-subagents") && name !== BOOTSTRAP_COMMAND_NAME), false, JSON.stringify(result.probe.commands));
  assert.equal(result.probe.tools.includes(PARENT_TOOL_NAME), true, JSON.stringify(result.probe.tools));
  assert.equal(result.inventory.registered.includes(PARENT_TOOL_NAME), true);
  assert.ok(result.requests.length >= 1, "test provider from agentDir extensions must receive the child request");
  assert.equal(result.answered, true);
}

test("auto list keeps user-scope enabled extensions, honours package filters, and drops excluded pi-extras ids", async (t) => {
  const f = await fixture(t, ["repo", "filtered"]);
  const paths = await userExtensionPaths({ pi, cwd: f.cwd, agentDir: f.agentDir });
  assert.ok(paths.includes(join(f.agentDir, "extensions", "probe.ts")), JSON.stringify(paths));
  assert.ok(paths.includes(join(f.pkg, "a.ts")));
  assert.equal(paths.includes(join(f.pkg, "b.ts")), false);
  assert.equal(paths.some((path) => path.startsWith(join(f.cwd, ".pi"))), false);
  for (const id of EXCLUDED_EXTENSION_IDS) assert.equal(paths.includes(join(repoRoot, "extensions", id.split("/")[1], "index.ts")), false, id);
  assert.ok(paths.includes(join(repoRoot, "extensions", "ralph", "index.ts")), JSON.stringify(paths));
});

test("providerSources are deduped against the auto list by realpath and missing explicit sources still throw", async (t) => {
  const f = await fixture(t, ["filtered"]);
  const link = join(f.root, "a-link.ts");
  await symlink(join(f.pkg, "a.ts"), link);
  const config = { projects: { [f.cwd]: { providerSources: [link] } } };
  const paths = providerExtensionPaths({ extensionDir, agentDir: f.agentDir, cwd: f.cwd, config, autoExtensions: [join(f.pkg, "a.ts")] });
  assert.deepEqual(paths.filter((path) => path === join(f.pkg, "a.ts")), [join(f.pkg, "a.ts")]);
  assert.throws(() => providerExtensionPaths({ extensionDir, agentDir: f.agentDir, cwd: f.cwd, config: { projects: { [f.cwd]: { providerSources: ["/missing/provider"] } } } }), /Provider bootstrap source does not exist/);
  assert.throws(() => providerExtensionPaths({ extensionDir, agentDir: f.agentDir, cwd: f.cwd, config: { projects: { [f.cwd]: { providerSources: [extensionDir] } } } }), /cannot bootstrap itself/);
});

test("auto entries resolving inside rpc-subagents are skipped with a single notice instead of throwing", async (t) => {
  const f = await fixture(t, ["alias"]);
  const notices = [];
  const prepare = preparerFor(f, notices);
  const first = await prepareChild(f, { prepare });
  await prepareChild(f, { prepare });
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.equal(extensionsOf(first.args).some((path) => path === join(extensionDir, "index.ts")), false);
});

test("real child loads user extensions only, without pi-extras spawning tools, /annotate, project or filtered extensions", { skip: realSkip }, async (t) => {
  const f = await fixture(t, ["repo", "filtered"]);
  const prepared = await prepareChild(f);
  assert.equal(prepared.args.includes("--no-extensions"), true);
  const result = await runChild(t, f, prepared);
  assertChildBasics(result);
  assert.equal(result.probe.commands.includes("annotate"), false, JSON.stringify(result.probe.commands));
  assert.equal(result.probe.tools.includes("pkg_a"), true);
  assert.equal(result.probe.tools.includes("pkg_b"), false);
  assert.equal(result.probe.tools.includes("proj_tool"), false);
  t.diagnostic(JSON.stringify({ check: "user-extensions", extensions: extensionsOf(prepared.args), tools: result.probe.tools, commands: result.probe.commands, providerRequests: result.requests.length }));
});

test("real child with pi-extras symlinked under another package name still starts and reports through child.ts", { skip: realSkip }, async (t) => {
  const f = await fixture(t, ["alias"]);
  const notices = [];
  const prepared = await prepareChild(f, { notices });
  assert.equal(notices.length, 1);
  const result = await runChild(t, f, prepared);
  assertChildBasics(result);
  t.diagnostic(JSON.stringify({ check: "symlink-alias", notices, tools: result.probe.tools, commands: result.probe.commands }));
});

test("real child with layers 1 and 2 bypassed still registers nothing from rpc-subagents", { skip: realSkip }, async (t) => {
  const f = await fixture(t, []);
  const prepared = await prepareChild(f, { extraArgs: ["--extension", join(extensionDir, "index.ts")] });
  const result = await runChild(t, f, prepared);
  assertChildBasics(result);
  assert.equal(result.probe.commands.some((name) => name.startsWith("subagent")), false, JSON.stringify(result.probe.commands));
  t.diagnostic(JSON.stringify({ check: "layer3-only", tools: result.probe.tools, commands: result.probe.commands }));
});
