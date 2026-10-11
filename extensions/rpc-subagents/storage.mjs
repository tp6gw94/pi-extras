import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { readJSON } from "./store.mjs";

// rpc-subagents keeps its runtime data and config.json under <agentDir>/rpc-subagents, outside any
// extension or package directory, so reinstalling or updating the package never touches them.
//
//	<agentDir>/rpc-subagents/data/          tasks, projects, schedules, templates, session catalog
//	<agentDir>/rpc-subagents/config.json    optional local config
//	<agentDir>/rpc-subagents/migration.json what was copied from an old location, and when
//
// Before rpc-subagents shipped in the pi-extras package it lived in <agentDir>/extensions/rpc-subagents
// (and earlier still in <agentDir>/extensions/rpc-fleet, of which only data/ was kept). When the new
// location has no data, the first runtime start copies the old data once; the same goes for
// config.json. The old files are never changed or removed. After a copy, migration.json records it
// and nothing is copied again, even if the new data is later deleted.

export function storageLayout(agentDir) {
  const base = join(resolve(agentDir), "rpc-subagents");
  return { base, dataRoot: join(base, "data"), configFile: join(base, "config.json"), marker: join(base, "migration.json") };
}

/** Old locations, most preferred first. The old code preferred rpc-fleet/data when it existed. */
export function legacyLayout(agentDir) {
  const extensions = join(resolve(agentDir), "extensions");
  return {
    dataRoots: [join(extensions, "rpc-fleet", "data"), join(extensions, "rpc-subagents", "data")],
    configFiles: [join(extensions, "rpc-subagents", "config.json")],
  };
}

async function hasEntries(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    return (await readdir(directory)).length > 0;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return false; throw error; }
}

const PATH_KEYS = new Set(["canonicalPath", "templatePath", "sessionFile", "eventFile"]);

function rebase(value, roots) {
  for (const [from, to] of roots) {
    if (value === from) return to;
    if (value.startsWith(from + sep)) return to + value.slice(from.length);
  }
  return value;
}

/** Rewrite the known absolute-path fields that point into the old data root. */
function rebaseDocument(value, roots) {
  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => { const next = rebaseDocument(item, roots); changed ||= next !== item; return next; });
    return changed ? result : value;
  }
  if (!value || typeof value !== "object") return value;
  let changed = false;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const next = PATH_KEYS.has(key) && typeof item === "string" ? rebase(item, roots) : rebaseDocument(item, roots);
    changed ||= next !== item;
    result[key] = next;
  }
  return changed ? result : value;
}

async function* jsonFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield path;
  }
}

async function writeKeepingMode(file, text) {
  const { mode } = await stat(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: mode & 0o777 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function sessionKey(file) { return createHash("sha256").update(file).digest("hex"); }

/**
 * Copy an old data root to `target`. Records that hold absolute paths into the old root (session
 * catalog, session leases, schedule template paths, task snapshots) are moved to the new root, the
 * session catalog is re-keyed by the new session path, and a catalog's recorded file identity is
 * carried over when it matched the old session file. Event logs and session transcripts are copied
 * byte for byte. The copy is staged next to the target and renamed into place, so a failed copy
 * leaves no partial data behind.
 */
export async function copyDataRoot(source, target) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const staging = `${target}.migrating-${randomUUID()}`;
  try {
    await cp(source, staging, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    const realSource = await realpath(source);
    const realTarget = join(await realpath(dirname(target)), basename(target));
    const roots = [[realSource, realTarget], [resolve(source), resolve(target)]].sort((a, b) => b[0].length - a[0].length);
    for await (const file of jsonFiles(staging)) {
      let document;
      try { document = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
      const next = rebaseDocument(document, roots);
      if (next !== document) await writeKeepingMode(file, JSON.stringify(next) + "\n");
    }
    const catalog = join(staging, "session-catalog");
    if (await hasEntries(catalog)) {
      for (const name of await readdir(catalog)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = join(catalog, name);
        let record;
        try { record = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
        if (typeof record?.canonicalPath !== "string" || !isAbsolute(record.canonicalPath)) continue;
        const relativeSession = record.canonicalPath.startsWith(realTarget + sep) ? record.canonicalPath.slice(realTarget.length + 1) : undefined;
        if (relativeSession === undefined) continue;
        if (record.fileIdentity) {
          try {
            const old = await stat(join(realSource, relativeSession));
            const copied = await stat(join(staging, relativeSession));
            if (record.fileIdentity.dev === String(old.dev) && record.fileIdentity.ino === String(old.ino)) {
              record.fileIdentity = { dev: String(copied.dev), ino: String(copied.ino) };
              await writeKeepingMode(file, JSON.stringify(record) + "\n");
            }
          } catch {}
        }
        const renamed = join(catalog, `${sessionKey(record.canonicalPath)}.json`);
        if (renamed !== file) await rename(file, renamed);
      }
    }
    try { await rmdir(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Copy an old config.json. Relative providerSources were relative to the old extension directory,
 * so they are made absolute against it; the rest of the file is kept as is. A file that is not a
 * JSON object is copied byte for byte, and loading it reports the same error as before.
 */
export async function copyConfig(source, target) {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const text = await readFile(source, "utf8");
  let config;
  try { config = JSON.parse(text); } catch {}
  const staging = `${target}.${randomUUID()}.tmp`;
  try {
    if (config && typeof config === "object" && !Array.isArray(config) && config.projects && typeof config.projects === "object") {
      for (const project of Object.values(config.projects)) {
        if (Array.isArray(project?.providerSources)) {
          project.providerSources = project.providerSources.map((item) => typeof item === "string" && !isAbsolute(item) ? resolve(dirname(source), item) : item);
        }
      }
      await writeFile(staging, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } else {
      await copyFile(source, staging, constants.COPYFILE_EXCL);
    }
    await rename(staging, target);
  } finally { await rm(staging, { force: true }); }
}

/**
 * Resolve the storage location and run the one-time copy from an old location. Returns the layout
 * and what was copied: { data?: from, config?: from }.
 */
export async function prepareStorage({ agentDir, now = Date.now }) {
  const layout = storageLayout(agentDir);
  const legacy = legacyLayout(agentDir);
  let marker = {};
  try { marker = await readJSON(layout.marker, {}); } catch {}
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) marker = {};
  const migrated = {};
  if (!marker.data && !(await hasEntries(layout.dataRoot))) {
    for (const from of legacy.dataRoots) {
      if (!(await hasEntries(from))) continue;
      await copyDataRoot(from, layout.dataRoot);
      migrated.data = from;
      break;
    }
  }
  if (!marker.config && !(await isFile(layout.configFile))) {
    for (const from of legacy.configFiles) {
      if (!(await isFile(from))) continue;
      await copyConfig(from, layout.configFile);
      migrated.config = from;
      break;
    }
  }
  if (migrated.data || migrated.config) {
    const at = new Date(now()).toISOString();
    const next = { version: 1, ...marker };
    if (migrated.data) next.data = { from: migrated.data, to: layout.dataRoot, at };
    if (migrated.config) next.config = { from: migrated.config, to: layout.configFile, at };
    const temporary = `${layout.marker}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, layout.marker);
    } finally { await rm(temporary, { force: true }); }
  }
  return { ...layout, configDir: layout.base, migrated };
}
