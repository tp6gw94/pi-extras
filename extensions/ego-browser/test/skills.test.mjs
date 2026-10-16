import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, formatSkillsForPrompt, getAgentDir } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { ToolParametersSchema } from "../schema.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Pi advertises ego-browser-tools to a bound session", async () => {
  const settingsManager = SettingsManager.inMemory({ defaultTools: [] });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [extension],
  });
  await loader.reload();
  const { session } = await createAgentSession({ resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(), tools: [] });
  try {
    await session.bindExtensions({});
    const { skills, diagnostics } = session.resourceLoader.getSkills();
    assert.deepEqual(diagnostics, []);
    const skill = skills.find((item) => item.name === "ego-browser-tools");
    assert.ok(skill, "ego-browser-tools is not advertised");
    assert.equal(skill.disableModelInvocation, false);
    const prompt = formatSkillsForPrompt(skills);
    assert.ok(prompt.includes("<name>ego-browser-tools</name>"));
    assert.ok(prompt.includes("ego_browser"));
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
});

test("skill frontmatter, links and JSON examples are structurally valid", async () => {
  const skillDir = join(root, "skills/ego-browser-tools");
  const skillSource = await readFile(join(skillDir, "SKILL.md"), "utf8");
  assert.match(skillSource, /^---\nname: ego-browser-tools\ndescription: .+\n---\n/);
  const visited = new Set();
  const pending = [join(skillDir, "SKILL.md"), join(root, "README.md"), join(root, "README.zh-TW.md")];
  const ops = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (!target || /^[a-z]+:\/\//i.test(target)) continue;
      const resolved = resolve(dirname(path), target);
      await access(resolved);
      if (resolved.startsWith(skillDir + "/") && resolved.endsWith(".md")) pending.push(resolved);
    }
    for (const match of source.matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const parsed = JSON.parse(match[1]);
      assert.ok(Value.Check(ToolParametersSchema, parsed), `Invalid request payload in ${path}: ${match[1]}`);
      ops.add(parsed.request.op);
    }
  }
  assert.deepEqual([...ops].sort(), ["act", "begin", "finish", "observe", "release", "run"]);
});
