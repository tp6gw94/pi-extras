import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function fixture({ delay = 2, scenario = "resume" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "quota-resume-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => raw += chunk);
    request.on("end", async () => {
      const body = JSON.parse(raw);
      const item = { body, session: request.headers["x-opencode-session"], authorization: request.headers.authorization === "Bearer local-fixture" };
      requests.push(item);
      await appendFile(join(root, "requests.jsonl"), JSON.stringify(item) + "\n");
      const resumed = body.messages.some(message => message.role === "user" && (typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("")) === "Continue the unfinished task.");
      const hasTool = body.messages.some(message => message.role === "tool");
      if (hasTool && !resumed && scenario !== "normal") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": String(delay), "x-should-retry": "false" });
        response.end(JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: "GoUsageLimitError: subscription exhausted" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "quota-fixture" };
      const chunk = value => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, ...value }] })}\n\n`);
      if (!hasTool) {
        chunk({ delta: { role: "assistant", tool_calls: [{ index: 0, id: "tool-fixture", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(root, "retained.txt") }) } }] }, finish_reason: null });
        chunk({ delta: {}, finish_reason: "tool_calls" });
      } else {
        chunk({ delta: { role: "assistant", content: "Fixture task complete." }, finish_reason: null });
        chunk({ delta: {}, finish_reason: "stop" });
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(join(root, "retained.txt"), "completed-tool-result-marker\n");
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "opencode-go": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "local-fixture", api: "openai-completions", models: [{ id: "quota-fixture", name: "Quota fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, defaultProvider: "opencode-go", defaultModel: "quota-fixture", theme: "dark" }));
  const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const args = [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "-e", fileURLToPath(new URL("../index.ts", import.meta.url)), "--provider", "opencode-go", "--model", "quota-fixture", "--tools", "read", "--session", join(root, "session.jsonl")];
  const env = { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TERM: "xterm-256color" };
  return { root, agentDir, requests, args, env, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await fixture({ delay: Number(process.argv[2] ?? 20) });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `env -i ${Object.entries(f.env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${quote(process.execPath)} ${f.args.map(quote).join(" ")}`;
  await writeFile(join(f.root, "launch.sh"), `#!/bin/sh\ncd ${quote(f.root)}\nexec ${command}\n`);
  console.log(JSON.stringify({ root: f.root, launch: `sh ${quote(join(f.root, "launch.sh"))}`, prompt: "Finish the fixture task.", requests: join(f.root, "requests.jsonl"), session: join(f.root, "session.jsonl") }));
}
