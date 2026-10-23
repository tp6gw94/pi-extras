import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeTaskSpec } from "../domain.mjs";
import { createTaskPreparer, resolveCliEntrypoint, resolveWebEntrypoint, CHILD_BINDING_ENV } from "../runtime.mjs";
import { userExtensionPaths } from "../user-extensions.mjs";
import { childEnvironment } from "../transport.mjs";
import { decodeCoordinationEnvelope, BOOTSTRAP_COMMAND_NAME } from "../coordination.mjs";

const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(extensionDir));
const packageDir = process.env.RPC_SUBAGENTS_PI_PACKAGE ?? join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const pi = await import(pathToFileURL(join(packageDir, "dist", "index.js")).href);
const cliPath = process.env.RPC_SUBAGENTS_PI_PACKAGE ? resolveCliEntrypoint(process.env.RPC_SUBAGENTS_PI_PACKAGE) : undefined;
const realSkip = !process.env.RPC_SUBAGENTS_PI_PACKAGE && "Set RPC_SUBAGENTS_PI_PACKAGE to run real Pi children";
const model = { provider: "mock", id: "mock-model" };
const binding = { taskId: "web-package-task", ownerId: "web-package-owner", nonce: "web-package-nonce" };
const expectedWebTools = ["web_search", "source_check", "fetch_content", "get_search_content", "web_enable"];

const webPackageSource = `import { appendFileSync } from "node:fs";
export default function (pi) {
  appendFileSync(process.env.RPC_WEB_PACKAGE_MARKER, "loaded\\n");
  for (const name of ["web_search", "source_check", "fetch_content", "get_search_content", "web_enable"]) {
    pi.registerTool({ name, label: name, description: name, parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: name }], details: {} }) });
  }
}
`;

function modelsConfig(port) {
  return {
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "mock-key",
        models: [{ id: "mock-model", name: "Mock Model", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-package-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const installed = join(agentDir, "npm", "node_modules", "pi-web-access");
  const marker = join(root, "loaded.txt");
  await mkdir(join(installed, "dist"), { recursive: true });
  await mkdir(cwd);
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "pi-web-access", version: "0.0.1", pi: { extensions: ["./dist"] } }));
  await writeFile(join(installed, "dist", "index.js"), webPackageSource);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));
  await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ toolActivation: "dynamic" }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const entrypoint = resolveWebEntrypoint(agentDir);
  const aliases = [installed, entrypoint];
  const prepare = (config = {}) => createTaskPreparer({ extensionDir, configDir: root, configFile: join(root, "config.json"), agentDir,
    cliPath: cliPath ?? "/installed/pi", config,
    resolveUserExtensions: (taskCwd) => userExtensionPaths({ pi, cwd: taskCwd, agentDir }) });
  const spec = (webAccess) => normalizeTaskSpec({ prompt: "Inspect the package load", name: "web-package", cwd, model, tools: [], webAccess });
  const extensionsOf = (args) => args.flatMap((value, index) => value === "--extension" ? [args[index + 1]] : []);
  const packageExtensions = (args) => extensionsOf(args).filter((path) => path === installed || path.startsWith(installed + "/"));
  return { root, agentDir, cwd, installed, marker, entrypoint, aliases, prepare, spec, extensionsOf, packageExtensions };
}

test("a pi-web-access package listed in user settings loads exactly once, only when webAccess is on", async (t) => {
  const f = await fixture(t);
  const withAliases = { projects: { [f.cwd]: { providerSources: f.aliases } } };
  for (const [index, config] of [withAliases, {}].entries()) {
    const prepare = f.prepare(config);
    const on = await prepare(f.spec(true), { directory: join(f.root, `on-${index}`) });
    assert.deepEqual(f.packageExtensions(on.args), [f.entrypoint], `web access on must load pi-web-access once: ${on.args.join(" ")}`);
    assert.equal(f.extensionsOf(on.args).includes(join(extensionDir, "web.ts")), false);
    const allowlist = on.args[on.args.indexOf("--tools") + 1].split(",");
    for (const name of expectedWebTools) assert.equal(allowlist.includes(name), true, `${name} missing: ${allowlist.join(",")}`);

    const off = await prepare(f.spec(false), { directory: join(f.root, `off-${index}`) });
    assert.deepEqual(f.packageExtensions(off.args), [], `web access off must not load pi-web-access: ${off.args.join(" ")}`);
    assert.equal(f.extensionsOf(off.args).includes(join(extensionDir, "web.ts")), false, off.args.join(" "));
  }
});

function startProvider() {
  let step = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      step += 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: `chatcmpl-${step}`, object: "chat.completion.chunk", created: 0, model: "mock-model" };
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return { server, listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)), port: () => server.address().port };
}

async function runChild(t, f, webAccess) {
  const provider = startProvider();
  await provider.listen();
  await writeFile(join(f.agentDir, "models.json"), JSON.stringify(modelsConfig(provider.port())));
  const prepared = await f.prepare()(f.spec(webAccess), { directory: join(f.root, `task-${webAccess}`), ...binding });
  const child = spawn(process.execPath, [cliPath, "--mode", "rpc", ...prepared.args], { cwd: f.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"],
    env: childEnvironment({ ...prepared.env, PI_CODING_AGENT_DIR: f.agentDir, RPC_WEB_PACKAGE_MARKER: f.marker,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }) });
  const records = [];
  let stderr = "";
  let buffer = "";
  const waiters = new Set();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      try { records.push(JSON.parse(line)); } catch {}
      for (const waiter of waiters) waiter();
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { provider.server.closeAllConnections?.(); } catch {}
    await new Promise((resolve) => provider.server.close(() => resolve()));
  });
  const envelopes = () => records.filter((record) => record.type === "extension_ui_request" && record.method === "notify")
    .map((record) => decodeCoordinationEnvelope(record.message, binding)).filter((envelope) => envelope?.kind === "inventory");
  child.stdin.write(JSON.stringify({ id: "bootstrap", type: "prompt", message: `/${BOOTSTRAP_COMMAND_NAME}` }) + "\n");
  await new Promise((resolve, reject) => {
    const waiter = () => { if (envelopes().length === 0) return; cleanup(); resolve(); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No child inventory. stderr=${stderr.slice(-3000)} recent=${JSON.stringify(records.slice(-5)).slice(0, 2000)}`));
    }, 60000);
    const cleanup = () => { waiters.delete(waiter); clearTimeout(timer); };
    waiters.add(waiter);
    waiter();
  });
  return { prepared, loaded: envelopes()[0].inventory, stderr };
}

test("real child loads the installed pi-web-access once when web access is on and never when it is off", { skip: realSkip }, async (t) => {
  const f = await fixture(t);
  const on = await runChild(t, f, true);
  assert.equal(on.loaded.registered.filter((name) => name === "web_search").length, 1, JSON.stringify(on.loaded.registered));
  assert.equal(on.loaded.registered.includes("web_enable"), true, JSON.stringify(on.loaded.registered));
  assert.doesNotMatch(on.stderr, /conflicts/);
  assert.equal(await readFile(f.marker, "utf8"), "loaded\n");

  const offMarker = join(f.root, "off-loaded.txt");
  const off = await runChild(t, { ...f, marker: offMarker }, false);
  assert.deepEqual(off.loaded.registered.filter((name) => name.startsWith("web")), [], JSON.stringify(off.loaded.registered));
  assert.equal(existsSync(offMarker), false);
  assert.equal(off.prepared.env[CHILD_BINDING_ENV.taskId], binding.taskId);
  t.diagnostic(JSON.stringify({ check: "web-package-load", on: { tools: on.prepared.args[on.prepared.args.indexOf("--tools") + 1],
    registered: on.loaded.registered }, off: { tools: off.prepared.args[off.prepared.args.indexOf("--tools") + 1], registered: off.loaded.registered } }));
});
