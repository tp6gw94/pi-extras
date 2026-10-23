import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTaskSpec } from "../domain.mjs";
import { createTaskPreparer, resolveCliEntrypoint, resolveWebEntrypoint, CHILD_BINDING_ENV } from "../runtime.mjs";
import { childEnvironment } from "../transport.mjs";
import { decodeCoordinationEnvelope, verifyCapabilities, BOOTSTRAP_COMMAND_NAME, PARENT_TOOL_NAME } from "../coordination.mjs";

const packageDir = process.env.RPC_SUBAGENTS_PI_PACKAGE;
const agentDir = process.env.RPC_SUBAGENTS_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const extensionDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = packageDir ? resolveCliEntrypoint(packageDir) : undefined;
const webInstalled = existsSync(join(agentDir, "npm", "node_modules", "pi-web-access", "dist", "index.js"));
const skip = !packageDir ? "Set RPC_SUBAGENTS_PI_PACKAGE to the installed @earendil-works/pi-coding-agent package directory"
  : !webInstalled ? `Install pi-web-access under ${agentDir} to run the real Pi RPC web runtime check` : false;

const binding = { taskId: "real-web-task", ownerId: "real-web-owner", nonce: "real-web-nonce" };
const searchOnlyConfig = { toolActivation: "dynamic", tools: { sourceCheck: { enabled: false }, getSearchContent: { enabled: false } } };

function modelsConfig(port) {
  return {
    providers: {
      mock: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "mock-key",
        models: [{ id: "mock-model", name: "Mock Model", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    },
  };
}

function startProvider(script) {
  const requests = [];
  let step = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      requests.push({ url: request.url, body });
      const action = script[step] ?? { text: `unexpected request ${step + 1}` };
      step += 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
      const base = { id: `chatcmpl-${step}`, object: "chat.completion.chunk", created: 0, model: "mock-model" };
      if (action.tool) {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null,
          tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: action.tool, arguments: JSON.stringify(action.args ?? {}) } }] }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: action.text }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return { server, requests, listen: () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)),
    port: () => server.address().port };
}

function startRpc(args, cwd, env) {
  const child = spawn(process.execPath, [cliPath, "--mode", "rpc", ...args], { cwd, env: childEnvironment(env), shell: false,
    detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const records = [];
  const stderr = [];
  const waiters = [];
  let buffer = "";
  let spawnError;
  child.on("error", (error) => { spawnError = error; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      records.push(record);
      for (const waiter of [...waiters]) waiter();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const diagnostics = () => `spawnError=${spawnError?.message} stderr=${stderr.join("").slice(-3000)} recent=${JSON.stringify(records.slice(-6)).slice(0, 3000)}`;
  const waitFor = (check, label, timeoutMs = 30000) => {
    if (check()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = () => { if (check()) { clearTimeout(timer); waiters.splice(waiters.indexOf(waiter), 1); resolve(); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${label}. ${diagnostics()}`)); }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    try { child.stdin.end(); } catch {}
    const kill = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, 1000);
    kill.unref?.();
    return new Promise((resolve) => child.once("close", () => { clearTimeout(kill); resolve(); }));
  };
  return { child, records, stderr, waitFor, send, stop, diagnostics };
}

async function scenario(t, { config, input, script, sessionFile }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rpc-web-runtime-")));
  const configDir = join(root, "config");
  const taskDirectory = join(root, "tasks", "task-1");
  await mkdir(configDir, { recursive: true });
  const provider = startProvider(script);
  await provider.listen();
  await writeFile(join(configDir, "web-search.json"), JSON.stringify(config));
  await writeFile(join(configDir, "models.json"), JSON.stringify(modelsConfig(provider.port())));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = configDir;
  let prepared;
  try {
    const spec = normalizeTaskSpec({ prompt: "Run the real web access check", name: "real-web", cwd: root,
      model: { provider: "mock", id: "mock-model" }, ...input });
    const prepare = createTaskPreparer({ extensionDir, agentDir, cliPath, config: { commandTimeoutMs: 30000 } });
    prepared = await prepare(spec, { directory: taskDirectory, ...binding, ...(sessionFile ? { session: { kind: "resume", sessionFile } } : {}) });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  const rpc = startRpc(prepared.args, root, { ...prepared.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
  t.after(async () => {
    await rpc.stop();
    try { provider.server.closeAllConnections?.(); } catch {}
    await new Promise((resolve) => provider.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const envelopes = () => rpc.records
    .filter((record) => record.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string")
    .map((record) => decodeCoordinationEnvelope(record.message, binding))
    .filter((envelope) => envelope?.kind === "inventory");
  const waitInventory = async (count, timeoutMs = 30000) => {
    await rpc.waitFor(() => envelopes().length >= count, `${count} inventory envelopes`, timeoutMs);
    return envelopes()[count - 1].inventory;
  };
  const toolNames = (index) => (provider.requests[index]?.body?.tools ?? []).map((tool) => tool.function?.name ?? tool.name).sort();
  const bootstrap = async () => {
    rpc.send({ id: "bootstrap", type: "prompt", message: `/${BOOTSTRAP_COMMAND_NAME}` });
    return waitInventory(1);
  };
  const run = async () => {
    rpc.send({ id: "run", type: "prompt", message: "Use web research for the answer" });
    await rpc.waitFor(() => rpc.records.some((record) => record.type === "agent_settled"), "agent_settled", 60000);
  };
  const extensions = () => prepared.args.flatMap((value, index) => value === "--extension" ? [prepared.args[index + 1]] : []);
  const allowlist = () => prepared.args[prepared.args.indexOf("--tools") + 1].split(",");
  return { prepared, provider, rpc, bootstrap, run, waitInventory, envelopes, toolNames, extensions, allowlist };
}

function assertAbsent(inventory, names) {
  for (const name of names) {
    assert.equal(inventory.registered.includes(name), false, `registered must exclude ${name}: ${JSON.stringify(inventory.registered)}`);
    assert.equal(inventory.declared.includes(name), false, `declared must exclude ${name}: ${JSON.stringify(inventory.declared)}`);
    assert.equal(inventory.callable.includes(name), false, `callable must exclude ${name}: ${JSON.stringify(inventory.callable)}`);
  }
}

test("real Pi RPC web access loads the enabled family and its loader in dynamic mode", { skip }, async (t) => {
  const s = await scenario(t, { config: searchOnlyConfig, input: { tools: ["read"], webAccess: true },
    script: [{ tool: "web_enable" }, { text: "done" }] });

  assert.deepEqual(s.allowlist(), ["read", PARENT_TOOL_NAME, "web_search", "fetch_content", "web_enable"]);
  assert.deepEqual(s.prepared.webTools, ["web_search", "fetch_content", "web_enable"]);
  assert.deepEqual(s.extensions().filter((path) => path === resolveWebEntrypoint(agentDir)), [resolveWebEntrypoint(agentDir)]);
  assert.equal(s.prepared.env[CHILD_BINDING_ENV.webTools], ["web_search", "fetch_content", "web_enable"].join(","));
  assert.equal(s.prepared.env[CHILD_BINDING_ENV.taskId], binding.taskId);

  const initial = await s.bootstrap();
  verifyCapabilities(["read"], s.prepared.webTools, initial);
  assert.equal(initial.registered.includes("web_search"), true);
  assert.equal(initial.registered.includes("web_enable"), true);
  assert.equal(initial.declared.includes("web_enable"), true, JSON.stringify(initial.declared));
  assert.equal(initial.exposures[PARENT_TOOL_NAME], "model-only");
  assertAbsent(initial, ["source_check", "get_search_content"]);

  await s.run();
  await s.waitInventory(2);
  const loaderEnd = s.rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "web_enable");
  assert.equal(loaderEnd?.isError, false, JSON.stringify(loaderEnd));
  assert.deepEqual(loaderEnd.result.details, { enabled: ["web_search", "fetch_content"] });

  const activated = s.envelopes().at(-1).inventory;
  verifyCapabilities(["read"], s.prepared.webTools, activated);
  for (const name of ["web_search", "fetch_content", "web_enable", "read", PARENT_TOOL_NAME]) {
    assert.equal(activated.declared.includes(name), true, `${name} missing after activation: ${JSON.stringify(activated.declared)}`);
  }
  assertAbsent(activated, ["source_check", "get_search_content"]);

  const lastTools = s.toolNames(s.provider.requests.length - 1);
  for (const name of ["web_search", "fetch_content", "read", PARENT_TOOL_NAME]) assert.equal(lastTools.includes(name), true, JSON.stringify(lastTools));
  assertAbsent({ registered: lastTools, declared: lastTools, callable: lastTools }, ["source_check", "get_search_content"]);
  t.diagnostic(JSON.stringify({ check: "dynamic-family", argvTools: s.allowlist(),
    initial: { registered: initial.registered, declared: initial.declared, webTools: s.prepared.webTools },
    loader: { isError: loaderEnd.isError, details: loaderEnd.result.details },
    activated: { declared: activated.declared }, providerTools: lastTools }));
});

test("real Pi RPC eager mode registers the enabled family without a loader", { skip }, async (t) => {
  const s = await scenario(t, { config: { ...searchOnlyConfig, toolActivation: "eager" }, input: { tools: [], webAccess: true }, script: [{ text: "done" }] });

  assert.deepEqual(s.allowlist(), [PARENT_TOOL_NAME, "web_search", "fetch_content"]);
  assert.deepEqual(s.prepared.webTools, ["web_search", "fetch_content"]);
  const initial = await s.bootstrap();
  verifyCapabilities([], s.prepared.webTools, initial);
  assert.equal(initial.declared.includes("web_search"), true, JSON.stringify(initial.declared));
  assert.equal(initial.registered.includes("web_enable"), false, JSON.stringify(initial.registered));
  assertAbsent(initial, ["web_enable", "source_check", "get_search_content"]);
  await s.run();
  assert.equal(s.provider.requests.length, 1);
  assert.equal(s.toolNames(0).includes("web_search"), true, JSON.stringify(s.toolNames(0)));
  assert.equal(s.toolNames(0).includes("web_enable"), false);
  t.diagnostic(JSON.stringify({ check: "eager-family", argvTools: s.allowlist(),
    initial: { declared: initial.declared }, providerTools: s.toolNames(0) }));
});

test("real Pi RPC web access follows renamed and disabled names from the installed configuration", { skip }, async (t) => {
  const config = { ...searchOnlyConfig, toolNames: { fetchContent: "get_page" } };
  const s = await scenario(t, { config, input: { tools: ["read"], webAccess: true }, script: [{ tool: "web_enable" }, { text: "done" }] });

  assert.deepEqual(s.allowlist(), ["read", PARENT_TOOL_NAME, "web_search", "get_page", "web_enable"]);
  assert.deepEqual(s.prepared.webTools, ["web_search", "get_page", "web_enable"]);
  const initial = await s.bootstrap();
  verifyCapabilities(["read"], s.prepared.webTools, initial);
  assert.equal(initial.registered.includes("get_page"), true, JSON.stringify(initial.registered));
  assertAbsent(initial, ["fetch_content", "source_check", "get_search_content"]);

  await s.run();
  await s.waitInventory(2);
  const activated = s.envelopes().at(-1).inventory;
  verifyCapabilities(["read"], s.prepared.webTools, activated);
  assert.equal(activated.declared.includes("get_page"), true, JSON.stringify(activated.declared));
  assertAbsent(activated, ["fetch_content", "source_check", "get_search_content"]);
  t.diagnostic(JSON.stringify({ check: "renamed-family", argvTools: s.allowlist(), registered: initial.registered, declared: activated.declared }));
});

test("real Pi RPC none-to-web continuation reaches every enabled web tool", { skip }, async (t) => {
  const first = await scenario(t, { config: { ...searchOnlyConfig, toolActivation: "auto" }, input: { tools: ["read"], webAccess: false }, script: [{ text: "first" }] });
  await first.bootstrap();
  await first.run();

  const second = await scenario(t, { config: { ...searchOnlyConfig, toolActivation: "auto" }, input: { tools: ["read"], webAccess: true, session: first.prepared.sessionFile },
    script: [{ tool: "web_enable" }, { text: "second" }], sessionFile: first.prepared.sessionFile });
  assert.deepEqual(second.prepared.webTools, ["web_search", "fetch_content", "web_enable"]);
  assert.equal(second.prepared.env[CHILD_BINDING_ENV.webTools], second.prepared.webTools.join(","));
  const before = await second.bootstrap();
  verifyCapabilities(["read"], second.prepared.webTools, before);
  assert.equal(before.declared.includes("web_enable"), true, JSON.stringify(before.declared));
  assertAbsent(before, ["source_check", "get_search_content"]);

  await second.run();
  await second.waitInventory(2);
  const loaderEnd = second.rpc.records.find((record) => record.type === "tool_execution_end" && record.toolName === "web_enable");
  assert.equal(loaderEnd?.isError, false, JSON.stringify(loaderEnd));
  assert.deepEqual(loaderEnd.result.details, { enabled: ["web_search", "fetch_content"] });
  const activated = second.envelopes().at(-1).inventory;
  verifyCapabilities(["read"], second.prepared.webTools, activated);
  for (const name of ["web_search", "fetch_content", "web_enable", "read", PARENT_TOOL_NAME]) {
    assert.equal(activated.declared.includes(name), true, `${name} missing after activation: ${JSON.stringify(activated.declared)}`);
  }
  assertAbsent(activated, ["source_check", "get_search_content"]);
  t.diagnostic(JSON.stringify({ check: "none-to-web", before: { active: before.active, declared: before.declared, webTools: second.prepared.webTools },
    activated: { declared: activated.declared } }));
});

test("real Pi RPC continuing a web session with web access off loads no web tool", { skip }, async (t) => {
  const first = await scenario(t, { config: searchOnlyConfig, input: { tools: ["read"], webAccess: true }, script: [{ text: "first" }] });
  const before = await first.bootstrap();
  verifyCapabilities(["read"], first.prepared.webTools, before);
  await first.run();

  const second = await scenario(t, { config: searchOnlyConfig, input: { tools: ["read"], webAccess: false, session: first.prepared.sessionFile },
    script: [{ text: "second" }], sessionFile: first.prepared.sessionFile });
  assert.deepEqual(second.allowlist(), ["read", PARENT_TOOL_NAME]);
  assert.deepEqual(second.prepared.webTools, []);
  assert.equal(second.extensions().includes(resolveWebEntrypoint(agentDir)), false, second.prepared.args.join(" "));
  assert.equal(second.prepared.env[CHILD_BINDING_ENV.webTools], undefined);
  const continued = await second.bootstrap();
  assert.deepEqual(verifyCapabilities(["read"], [], continued).reachable, ["read", PARENT_TOOL_NAME]);
  assertAbsent(continued, ["web_search", "fetch_content", "web_enable"]);
  await second.run();
  assert.doesNotMatch(second.rpc.stderr.join(""), /conflicts/);
  t.diagnostic(JSON.stringify({ check: "web-to-off", sessionFile: second.prepared.sessionFile,
    first: { declared: before.declared }, continued: { registered: continued.registered } }));
});
