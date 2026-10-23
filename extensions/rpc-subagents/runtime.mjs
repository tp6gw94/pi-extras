import { existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { readJSON } from "./store.mjs";
import { writeChildSession } from "./snapshot.mjs";
import { boundedInteger, normalizeTools } from "./domain.mjs";
import { readWebCatalog } from "./web-policy.mjs";
import { resolveWebTools } from "./capability.mjs";
import { PARENT_TOOL_NAME } from "./coordination.mjs";
import { guardAutoExtensions, owningPackageName } from "./user-extensions.mjs";

export function resolveCliEntrypoint(packageDir, argvEntry = process.argv[1]) {
  const root = realpathSync(packageDir);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (manifest.name !== "@earendil-works/pi-coding-agent") throw new Error("Unsupported Pi package. RPC subagents requires the current installed Pi CLI.");
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (typeof entry !== "string" || isAbsolute(entry)) throw new Error("Installed Pi has no valid local CLI entrypoint in package.json");
  const expected = resolve(root, entry);
  const withinRoot = relative(root, expected);
  if (withinRoot.startsWith("..") || isAbsolute(withinRoot) || !existsSync(expected) || !statSync(expected).isFile()) throw new Error("Installed Pi CLI entrypoint is unavailable. Compiled binaries are not supported; no PATH or SDK fallback is allowed.");
  const cliPath = realpathSync(expected);
  const realRelative = relative(root, cliPath);
  if (realRelative.startsWith("..") || isAbsolute(realRelative)) throw new Error("Pi CLI entrypoint resolves outside the installed package");
  if (argvEntry && existsSync(argvEntry) && statSync(argvEntry).isFile() && realpathSync(argvEntry) === cliPath) return realpathSync(argvEntry);
  return cliPath;
}

export async function loadLocalConfig(configFile) {
  const config = await readJSON(configFile, {});
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error("RPC subagents config.json must be an object");
  return {
    concurrency: boundedInteger(config.concurrency ?? 4, "concurrency", 1, 32),
    commandTimeoutMs: boundedInteger(config.commandTimeoutMs ?? 30000, "commandTimeoutMs", 100, 120000),
    dialogTimeoutMs: boundedInteger(config.dialogTimeoutMs ?? 120000, "dialogTimeoutMs", 1000, 600000),
    maxEventBytes: boundedInteger(config.maxEventBytes ?? 67108864, "maxEventBytes", 1048576, 1073741824),
    projects: config.projects ?? {},
  };
}

export function providerExtensionPaths({ extensionDir, configDir = extensionDir, configFile = join(configDir, "config.json"), agentDir, cwd, config, autoExtensions = [], onSelfSkipped }) {
  const defaults = ["npm/node_modules/pi-claude-bridge"].map((name) => join(agentDir, name)).filter(existsSync);
  const additional = config.projects?.[cwd]?.providerSources ?? [];
  if (!Array.isArray(additional) || additional.some((item) => typeof item !== "string")) throw new Error("Project providerSources must be an array of explicit local paths");
  const explicit = additional.map((entry) => {
    const source = resolve(configDir, entry);
    if (!existsSync(source)) throw new Error(`Provider bootstrap source does not exist: ${source} (from providerSources of ${cwd} in ${configFile})`);
    return source;
  });
  const auto = guardAutoExtensions(autoExtensions, extensionDir);
  if (auto.skipped.length) onSelfSkipped?.(auto.skipped);
  const paths = [...defaults, ...explicit].map((source) => {
    const path = realpathSync(source);
    if (path === realpathSync(extensionDir)) throw new Error("RPC subagents cannot bootstrap itself in a child");
    return path;
  });
  return [...new Set([...auto.kept, ...paths])].filter((path) => owningPackageName(path) !== "pi-web-access");
}

export async function canonicalCwd(cwd) {
  const path = await realpath(cwd);
  if (!(await stat(path)).isDirectory()) throw new Error("Task cwd must be an existing directory");
  return path;
}

export const CHILD_BINDING_ENV = Object.freeze({
  flag: "RPC_SUBAGENTS_CHILD",
  webTools: "RPC_SUBAGENTS_WEB_TOOLS",
  taskId: "RPC_SUBAGENTS_TASK_ID",
  ownerId: "RPC_SUBAGENTS_OWNER_ID",
  nonce: "RPC_SUBAGENTS_NONCE",
  async: "RPC_SUBAGENTS_ASYNC",
});

function resolveLaunchBinding({ taskId, ownerId, nonce }) {
  const values = [taskId, ownerId, nonce];
  if (values.every((value) => value === undefined)) return undefined;
  if (!values.every((value) => typeof value === "string" && value.length > 0 && value.length <= 160 && !value.includes("\0"))) {
    throw new Error("Launch binding requires taskId, ownerId, and nonce");
  }
  return { taskId, ownerId, nonce };
}

function resolveSessionFile(spec, session, directory) {
  if (session !== undefined && (!session || typeof session !== "object" || Array.isArray(session))) {
    throw new Error("Owned session must be a session lease object");
  }
  const file = session?.sessionFile;
  if (file !== undefined && (typeof file !== "string" || !isAbsolute(file))) throw new Error("Owned session file must be an absolute path");
  if (session?.kind !== undefined && (session.kind === "resume") !== (spec.session !== undefined)) {
    throw new Error("Owned session kind does not match the task source");
  }
  if (spec.session === undefined) return file ?? join(directory, "session.jsonl");
  if (typeof file !== "string") throw new Error("Resume tasks require the exact owned session file");
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Owned resume session file is unavailable: ${file}`);
  return file;
}

export function resolveWebEntrypoint(agentDir) {
  try {
    const root = realpathSync(join(agentDir, "npm", "node_modules", "pi-web-access"));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (manifest.name !== "pi-web-access" || !Array.isArray(manifest.pi?.extensions)
      || !manifest.pi.extensions.includes("./dist")) throw new Error("Unsupported installed package manifest");
    const entry = realpathSync(join(root, "dist", "index.js"));
    const withinRoot = relative(root, entry);
    if (withinRoot.startsWith("..") || isAbsolute(withinRoot) || !statSync(entry).isFile()) {
      throw new Error("Entrypoint must be a local file within the installed package");
    }
    return entry;
  } catch (error) {
    throw new Error(`Web access requires the trusted installed pi-web-access dist/index.js: ${error.message}`);
  }
}

export function createTaskPreparer({ extensionDir, configDir = extensionDir, configFile = join(configDir, "config.json"), agentDir, cliPath, config, resolveUserExtensions, notify }) {
  let selfNoticeShown = false;
  const onSelfSkipped = (skipped) => {
    if (selfNoticeShown) return;
    selfNoticeShown = true;
    notify?.(`RPC subagents did not load itself in children (found via your settings at ${skipped.join(", ")}).`);
  };
  const bridgeExtension = join(extensionDir, "child.ts");
  return async (spec, { directory, template, taskId, ownerId, nonce, session } = {}) => {
    await canonicalCwd(spec.cwd);
    const autoExtensions = resolveUserExtensions ? await resolveUserExtensions(spec.cwd) : [];
    const providers = providerExtensionPaths({ extensionDir, configDir, configFile, agentDir, cwd: spec.cwd, config, autoExtensions, onSelfSkipped });
    if (!existsSync(bridgeExtension) || !statSync(bridgeExtension).isFile()) throw new Error("RPC subagents child bridge is unavailable");
    const binding = resolveLaunchBinding({ taskId, ownerId, nonce });
    const tools = normalizeTools(spec.tools);
    const sessionFile = resolveSessionFile(spec, session, directory);
    const webTools = spec.webAccess ? resolveWebTools(spec, readWebCatalog()) : [];
    const webSource = spec.webAccess ? resolveWebEntrypoint(agentDir) : undefined;
    if (spec.session === undefined) {
      await writeChildSession(sessionFile, { cwd: spec.cwd, template: spec.context === "fork" ? template : undefined });
    }
    const args = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--provider", spec.model.provider, "--model", spec.model.id, "--thinking", spec.thinking,
      "--session", sessionFile, "--session-dir", dirname(sessionFile), "--name", spec.name,
      "--tools", [...tools, PARENT_TOOL_NAME, ...webTools].join(",")];
    if (tools.includes("codemode")) args.push("--extension", "builtin:codemode");
    if (webSource) args.push("--extension", webSource);
    args.push("--extension", bridgeExtension);
    for (const path of providers) args.push("--extension", path);
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("RPC_SUBAGENTS_")) delete env[key];
    if (webSource) env[CHILD_BINDING_ENV.webTools] = webTools.join(",");
    if (binding) {
      env[CHILD_BINDING_ENV.taskId] = binding.taskId;
      env[CHILD_BINDING_ENV.ownerId] = binding.ownerId;
      env[CHILD_BINDING_ENV.nonce] = binding.nonce;
      env[CHILD_BINDING_ENV.async] = spec.async ? "1" : "0";
    }
    return { cliPath, cwd: spec.cwd, sessionFile, args, env, binding, webTools, commandTimeoutMs: config.commandTimeoutMs };
  };
}
