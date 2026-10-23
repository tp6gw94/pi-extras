import { COORDINATION_LIMITS, DEFAULT_EXECUTION_TOOLS, WEB_LOADER_TOOL_NAME, normalizeTools } from "./coordination.mjs";
import { WEB_DEFAULT_TOOL_NAMES } from "./web-policy.mjs";

const signedEntryPattern = /^([+-])([A-Za-z_][A-Za-z0-9_.:-]*)$/;
const knownExecutionNames = new Set([...DEFAULT_EXECUTION_TOOLS, "grep", "find", "ls"]);
const defaultWebNames = new Set([...WEB_DEFAULT_TOOL_NAMES, WEB_LOADER_TOOL_NAME]);

function literalName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > COORDINATION_LIMITS.maxToolNameChars ||
    value.includes("\0") || /\s/.test(value)) {
    throw new Error("tools entries must be literal tool names");
  }
  return value;
}

function selectedName(value) {
  const name = value[0] === "+" || value[0] === "-" ? value.slice(1) : value;
  normalizeTools([name]);
  return name;
}

function rejectWebNames(names, readCatalog) {
  for (const name of names) {
    if (defaultWebNames.has(name)) throw new Error(`Web tool ${name} is not allowed in tools; use webAccess instead`);
  }
  if (names.every((name) => knownExecutionNames.has(name))) return;
  const catalog = readCatalog();
  for (const name of names) {
    if (catalog.reserved.has(name)) throw new Error(`Web tool ${name} is not allowed in tools; use webAccess instead`);
  }
}

function parseToolExpression(value, readCatalog) {
  if (value === undefined) return { form: "omitted" };
  if (!Array.isArray(value) || value.length > COORDINATION_LIMITS.maxTools) {
    throw new Error(`tools must be an array of at most ${COORDINATION_LIMITS.maxTools} names`);
  }
  if (value.length === 0) return { form: "replace", names: [] };
  const forms = new Set();
  for (const entry of value) {
    const name = literalName(entry);
    if (name === "+" || name === "-") throw new Error("tools entries must be literal tool names");
    forms.add(name[0] === "+" || name[0] === "-" ? "adjust" : "replace");
  }
  rejectWebNames(value.map((entry) => entry[0] === "+" || entry[0] === "-" ? entry.slice(1) : entry), readCatalog);
  if (forms.size > 1) throw new Error("tools must be all plain replacement names or all +name/-name adjustments, never mixed");

  if (forms.has("adjust")) {
    const ops = value.map((entry) => {
      const signed = signedEntryPattern.exec(entry);
      if (!signed) throw new Error(`Invalid tools entry: ${entry}`);
      return { op: signed[1] === "+" ? "add" : "remove", name: selectedName(entry) };
    });
    return { form: "adjust", ops };
  }

  const names = value.map((entry) => selectedName(entry));
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`tools contains duplicate tool ${name}`);
    seen.add(name);
  }
  return { form: "replace", names };
}

export function resolveTaskCapabilities(input, readCatalog) {
  if (input.webAccess !== undefined && typeof input.webAccess !== "boolean") throw new Error("webAccess must be boolean");
  const expression = parseToolExpression(input.tools, readCatalog);
  const execution = new Set(expression.form === "replace" ? [] : DEFAULT_EXECUTION_TOOLS);
  let operations = [];
  if (expression.form === "replace") operations = expression.names.map((name) => ({ op: "add", name }));
  else if (expression.form === "adjust") operations = expression.ops;

  for (const { op, name } of operations) {
    if (op === "add") execution.add(name);
    else execution.delete(name);
  }
  const tools = [...execution];
  if (tools.length > COORDINATION_LIMITS.maxTools) throw new Error(`Resolved execution tools exceed ${COORDINATION_LIMITS.maxTools} names`);
  return { tools, webAccess: input.webAccess ?? false };
}

export function resolveWebTools({ tools }, catalog) {
  const collision = tools.find((name) => catalog.reserved.has(name));
  if (collision) throw new Error(`Execution tool ${collision} collides with an installed pi-web-access name`);
  if (catalog.enabled.length === 0) throw new Error("Web access requested but all installed web tools are disabled");
  return [...catalog.enabled, ...(catalog.mode === "eager" ? [] : [WEB_LOADER_TOOL_NAME])];
}
