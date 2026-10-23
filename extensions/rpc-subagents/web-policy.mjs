import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_COMMAND_NAME, DEFAULT_EXECUTION_TOOLS, PARENT_TOOL_NAME, WEB_LOADER_TOOL_NAME } from "./coordination.mjs";

const webSlots = Object.freeze([
  { key: "webSearch", defaultName: "web_search" },
  { key: "sourceCheck", defaultName: "source_check" },
  { key: "fetchContent", defaultName: "fetch_content" },
  { key: "getSearchContent", defaultName: "get_search_content" },
]);

export const WEB_DEFAULT_TOOL_NAMES = Object.freeze(webSlots.map((slot) => slot.defaultName));

const toolNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const reservedExecutionNames = new Set([...DEFAULT_EXECUTION_TOOLS, "grep", "find", "ls", PARENT_TOOL_NAME, BOOTSTRAP_COMMAND_NAME]);

export function webConfigPath(env = process.env, home = homedir()) {
  if (env.PI_CODING_AGENT_DIR) return join(env.PI_CODING_AGENT_DIR, "web-search.json");
  const legacy = join(home, ".pi", "web-search.json");
  if (env.XDG_CONFIG_HOME) {
    const xdg = join(env.XDG_CONFIG_HOME, "pi", "web-search.json");
    return existsSync(xdg) ? xdg : existsSync(legacy) ? legacy : xdg;
  }
  const agent = join(home, ".pi", "agent", "web-search.json");
  return existsSync(agent) ? agent : existsSync(legacy) ? legacy : agent;
}

function slotEnabled(config, key) {
  const override = config.tools?.[key]?.enabled;
  if (typeof override === "boolean") return override;
  return !["webSearch", "sourceCheck"].includes(key) || config.webSearch?.enabled !== false;
}

export function readWebCatalog(env = process.env, home = homedir()) {
  const path = webConfigPath(env, home);
  let config = {};
  if (existsSync(path)) {
    try { config = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("Cannot parse installed pi-web-access configuration"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid pi-web-access configuration root");
  }
  const mode = config.toolActivation ?? "auto";
  if (!["auto", "dynamic", "eager"].includes(mode)) throw new Error("Invalid pi-web-access toolActivation");
  if (config.toolNames !== undefined && (!config.toolNames || typeof config.toolNames !== "object" || Array.isArray(config.toolNames))) {
    throw new Error("Invalid pi-web-access toolNames");
  }
  const slots = webSlots.map((slot) => {
    const raw = config.toolNames?.[slot.key] === undefined ? slot.defaultName : config.toolNames[slot.key];
    if (typeof raw !== "string" || !toolNamePattern.test(raw.trim())) throw new Error(`Invalid pi-web-access toolNames.${slot.key}`);
    return { ...slot, name: raw.trim() };
  });
  for (const slot of slots) {
    if (slot.name === WEB_LOADER_TOOL_NAME) throw new Error("Web tool uses reserved loader name");
    if (reservedExecutionNames.has(slot.name) || slot.name.startsWith("rpc_subagents_")) {
      throw new Error(`Web tool name ${slot.name} collides with a reserved tool`);
    }
  }
  const enabledSlots = slots.filter((slot) => slotEnabled(config, slot.key));
  const seen = new Set();
  for (const slot of enabledSlots) {
    if (seen.has(slot.name)) throw new Error(`Duplicate installed web tool name ${slot.name} from pi-web-access configuration`);
    seen.add(slot.name);
  }
  const reserved = new Set([...WEB_DEFAULT_TOOL_NAMES, ...slots.map((slot) => slot.name), WEB_LOADER_TOOL_NAME]);
  return Object.freeze({ mode, enabled: Object.freeze(enabledSlots.map((slot) => slot.name)), reserved });
}
