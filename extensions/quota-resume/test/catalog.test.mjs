import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const extension = fileURLToPath(new URL("../index.ts", import.meta.url));

test("Pi lists cache-only Codex models with quota-resume enabled", async t => {
  const agentDir = await mkdtemp(join(tmpdir(), "quota-catalog-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const model = {
    id: "codex-cache-only-fixture",
    name: "Cached Codex Model",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    contextWindow: 500000,
    maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const expires = Date.now() + 3600000;
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture", refresh: "fixture", expires } }));
  await writeFile(join(agentDir, "models-store.json"), JSON.stringify({ "openai-codex": { models: [model], lastModified: Date.UTC(2099, 0, 1) } }));
  const { stdout, stderr } = await run(process.execPath, [cli, "--no-extensions", "-e", extension, "--list-models", model.id], {
    cwd: agentDir,
    env: { PATH: process.env.PATH, HOME: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(stderr, "");
  assert.match(stdout, /^openai-codex\s+codex-cache-only-fixture\s+500K\b/m);
});
