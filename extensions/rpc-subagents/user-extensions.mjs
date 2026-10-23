import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export const EXCLUDED_EXTENSION_IDS = Object.freeze(["pi-extras/rpc-subagents", "pi-extras/annotation", "pi-extras/ux", "pi-extras/hooks"]);

function packageName(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof manifest.name === "string" ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

export function owningPackageName(path) {
  let current = path;
  while (true) {
    const name = packageName(current);
    if (name !== undefined) return name;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function extensionId(resource) {
  const root = resource.metadata?.packageRoot;
  if (!root) return undefined;
  const name = packageName(root);
  if (!name) return undefined;
  const parts = relative(root, resource.path).split(sep);
  const folder = parts[0] === "extensions" && parts.length > 2 ? parts[1] : parts.length > 1 ? parts[0] : undefined;
  return folder ? `${name}/${folder}` : name;
}

export function isWithin(path, dir) {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function userExtensionPaths({ pi, cwd, agentDir, excluded = EXCLUDED_EXTENSION_IDS }) {
  const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const manager = new pi.DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await manager.resolve(async () => "skip");
  return resolved.extensions
    .filter((resource) => resource.enabled && resource.metadata?.scope === "user")
    .filter((resource) => !resource.path.startsWith("builtin:") && existsSync(resource.path))
    .filter((resource) => !excluded.includes(extensionId(resource)))
    .map((resource) => resource.path);
}

export function guardAutoExtensions(paths, extensionDir) {
  const self = realpathSync(extensionDir);
  const kept = [];
  const skipped = [];
  for (const path of paths) {
    const real = realpathSync(path);
    if (isWithin(real, self)) skipped.push(path);
    else kept.push(real);
  }
  return { kept, skipped };
}
