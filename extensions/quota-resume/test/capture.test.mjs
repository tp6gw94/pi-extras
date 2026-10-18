import assert from "node:assert/strict";
import { test } from "node:test";
import { QuotaCapture } from "../capture.ts";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { WebSocketServer } from "ws";

const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.c`;

test("native Codex HTTP captures epoch reset before normalization and retains caller hooks", async () => {
  const capture = new QuotaCapture();
  const provider = capture.decorate(builtinProviders().find(provider => provider.id === "openai-codex"));
  const model = { ...provider.getModels()[0], baseUrl: "http://localhost/v1" };
  let hooks = 0;
  const response = new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "Please try again later.", resets_at: 1800000010 } }), { status: 429 });
  const result = await provider.streamSimple(model, { messages: [{ role: "user", content: "original", timestamp: Date.now() }] }, { apiKey: token, transport: "sse", maxRetries: 0, fetch: async () => response, onResponse: () => { hooks++; } }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(capture.evidence.get(result).resetAt, 1800000010000);
  assert.equal(hooks, 1);
});

for (const kind of ["error", "response.failed"]) test(`native Codex WebSocket ${kind} retains structured quota with arbitrary prose`, async t => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  server.on("connection", socket => socket.on("message", () => {
    socket.send(JSON.stringify({ type: "response.created", response: { id: "local-ws" } }));
    const error = { code: "usage_limit_reached", message: "Please try again later.", resets_at: 1800000010 };
    socket.send(JSON.stringify(kind === "error" ? { type: kind, error } : { type: kind, response: { error } }));
  }));
  const capture = new QuotaCapture();
  const provider = capture.decorate(builtinProviders().find(provider => provider.id === "openai-codex"));
  const model = { ...provider.getModels()[0], baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const result = await provider.streamSimple(model, { messages: [{ role: "user", content: "original", timestamp: Date.now() }] }, { apiKey: token, transport: "websocket", maxRetries: 0, fetch: async () => { throw new Error("Unexpected HTTP fallback"); } }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(capture.evidence.get(result)?.resetAt, 1800000010000, result.errorMessage);
});

for (const hook of ["onResponse", "onProviderStreamEvent"]) test(`native Codex ${hook} failure supersedes structured quota`, async () => {
  const capture = new QuotaCapture();
  const provider = capture.decorate(builtinProviders().find(provider => provider.id === "openai-codex"));
  const model = { ...provider.getModels()[0], baseUrl: "http://localhost/v1" };
  const error = { type: "usage_limit_reached", code: "usage_limit_reached", message: "Please try again later.", resets_at: 1800000010 };
  const response = hook === "onResponse"
    ? new Response(JSON.stringify({ error }), { status: 429 })
    : new Response(`data: ${JSON.stringify({ type: "error", error })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  const result = await provider.streamSimple(model, { messages: [{ role: "user", content: "original", timestamp: Date.now() }] }, {
    apiKey: token, transport: "sse", maxRetries: 0, fetch: async () => response,
    [hook]: () => { throw new Error("Unrelated callback failure"); },
  }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /Unrelated callback failure/);
  assert.equal(capture.evidence.has(result), false);
});

for (const shape of ["nested", "top", "response"]) test(`Codex raw ${shape} event keeps request-local reset and original final identity`, async () => {
  const capture = new QuotaCapture();
  const error = { code: "usage_limit_reached", message: "Please try again later.", resets_in_seconds: 10 };
  const event = shape === "top" ? { type: "error", ...error } : shape === "response" ? { type: "response.failed", response: { error } } : { type: "error", error };
  const message = { role: "assistant", stopReason: "error", errorMessage: error.message };
  const provider = capture.decorate({ id: "openai-codex", stream: run, streamSimple: run });
  function run(model, context, options) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      await options.onProviderStreamEvent(event, model);
      stream.push({ type: "error", reason: "error", error: message });
      stream.end();
    });
    return stream;
  }
  let observed = false;
  const stream = provider.streamSimple({}, {}, { onProviderStreamEvent: () => { observed = true; } });
  for await (const terminal of stream) assert.equal(terminal.error, message);
  assert.equal(await stream.result(), message);
  assert.equal(observed, true);
  assert.ok(capture.evidence.get(message).resetAt > Date.now());
});

for (const ending of ["network", "unrelated", "success"]) test(`later ${ending} attempt cannot replay earlier HTTP quota`, async () => {
  const capture = new QuotaCapture();
  const message = { role: "assistant", stopReason: ending === "success" ? "stop" : "error", errorMessage: "usage limit" };
  const provider = capture.decorate({ id: "openai-codex", stream: run, streamSimple: run });
  function run(model, context, options) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      await options.fetch("http://localhost/first");
      await options.fetch("http://localhost/second").catch(() => {});
      stream.end(message);
    });
    return stream;
  }
  let attempt = 0;
  const result = await provider.streamSimple({}, {}, { fetch: async () => {
    if (++attempt === 1) return new Response(JSON.stringify({ error: { type: "usage_limit_reached", resets_at: 1800000010 } }), { status: 429 });
    if (ending === "network") throw new Error("network");
    return new Response("{}", { status: ending === "success" ? 200 : 500 });
  } }).result();
  assert.equal(capture.evidence.has(result), false);
});
