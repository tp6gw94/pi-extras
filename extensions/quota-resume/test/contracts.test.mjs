import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../index.ts";

function harness(t, entries = []) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
  const handlers = new Map();
  const providers = new Map();
  const commands = new Map();
  const sent = [], notices = [];
  let terminal, busy = false;
  const model = { id: "fixture", provider: "opencode-go", api: "openai-completions", baseUrl: "http://localhost/v1", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const ctx = { mode: "tui", model, ui: { notify: text => notices.push(text), setStatus() {}, onTerminalInput: handler => { terminal = handler; return () => terminal = undefined; } }, sessionManager: { getSessionId: () => "session", getBranch: () => entries }, isIdle: () => !busy, hasPendingMessages: () => false };
  extension({ registerProvider: p => providers.set(p.id, p), on: (name, fn) => handlers.set(name, fn), registerCommand: (name, command) => commands.set(name, command), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), sendUserMessage: text => { assert.equal(entries.at(-1).data.state, "consumed"); sent.push(text); } });
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  emit("session_start", { reason: "startup" });
  t.after(() => emit("session_shutdown", { reason: "quit" }));
  async function fail({ provider = "opencode-go", reset = "10", type = "GoUsageLimitError", headers = {}, stop = "error" } = {}) {
    const p = providers.get(provider);
    const m = provider === "opencode-go" ? model : { ...p.getModels()[0], baseUrl: "http://localhost/v1" };
    ctx.model = m;
    const body = { type: "error", error: { type, message: type === "usage_limit_reached" ? "The usage limit has been reached" : type, ...(provider === "openai-codex" && reset !== null ? { resets_at: Number(reset) } : {}) } };
    const stream = p.streamSimple(m, { messages: [{ role: "user", content: "original", timestamp: Date.now() }] }, { apiKey: provider === "openai-codex" ? `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.c` : "fixture", transport: "sse", maxRetries: 0, fetch: async () => new Response(JSON.stringify(body), { status: 429, headers: { ...(reset === null ? {} : { "retry-after": reset }), ...headers } }) });
    const message = await stream.result();
    assert.equal(message.stopReason, "error", message.errorMessage);
    message.stopReason = stop;
    const origin = `origin-${entries.length}`;
    entries.push({ type: "message", id: origin, message });
    emit("turn_end", { message, messageEntryId: origin });
    emit("agent_settled", { aborted: false });
    return message;
  }
  return { fail, emit, entries, sent, notices, ctx, providers, commands, escape: () => terminal("\u001b"), busy: value => busy = value };
}

test("native Go error dispatches exact English once after consume and repeated settlement", async t => {
  const h = harness(t);
  await h.fail();
  assert.equal(h.entries.at(-1).data.state, "pending");
  t.mock.timers.tick(9999);
  assert.deepEqual(h.sent, []);
  t.mock.timers.tick(1);
  h.emit("agent_settled", { aborted: false });
  t.mock.timers.tick(100000);
  assert.deepEqual(h.sent, ["Continue the unfinished task."]);
});

for (const kind of ["input", "before_agent_start", "user_bash", "session_before_switch", "session_before_fork", "session_before_tree", "escape", "command", "abort", "model"]) {
  test(`${kind} cancels waiting recovery`, async t => {
    const h = harness(t);
    await h.fail();
    if (kind === "escape") assert.equal(h.escape(), undefined);
    else if (kind === "command") await h.commands.get("quota-resume").handler("cancel", h.ctx);
    else if (kind === "abort") h.emit("agent_settled", { aborted: true });
    else if (kind === "model") h.emit("model_select", { source: "set", model: { id: "other", provider: "opencode-go" }, previousModel: h.ctx.model });
    else h.emit(kind);
    t.mock.timers.tick(20000);
    assert.deepEqual(h.sent, []);
    assert.equal(h.entries.at(-1).data.state, "cancelled");
  });
}

for (const reset of [null, "0", "invalid"]) test(`unusable reset ${reset} visibly declines without looping`, async t => {
  const h = harness(t);
  await h.fail({ reset });
  t.mock.timers.tick(100000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.entries.some(entry => entry.data?.state === "pending"), false);
  assert.match(h.notices.at(-1), /不會自動續跑/);
});

test("new stale Codex server reset is visible and never dispatches", async t => {
  const h = harness(t);
  await h.fail({ provider: "openai-codex", type: "usage_limit_reached", reset: String((Date.now() - 1000) / 1000) });
  t.mock.timers.tick(100000);
  assert.deepEqual(h.sent, []);
  assert.match(h.notices.at(-1), /不會自動續跑/);
});

test("Claude missing reset is visible while ordinary API rate limits remain excluded", async t => {
  const h = harness(t);
  await h.fail({ provider: "anthropic", type: "rate_limit_error", headers: { "anthropic-ratelimit-unified-status": "rate_limited" } });
  assert.match(h.notices.at(-1), /不會自動續跑/);
  await h.fail({ provider: "anthropic", type: "rate_limit_error", headers: { "anthropic-ratelimit-tokens-reset": "2099-01-01T00:00:00Z" } });
  t.mock.timers.tick(100000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.entries.some(entry => entry.data), false);
});

test("overdue reopen dispatches once, consumed reopen never dispatches again", async t => {
  const h = harness(t);
  await h.fail();
  h.emit("session_shutdown", { reason: "reload" });
  t.mock.timers.tick(20000);
  h.emit("session_start", { reason: "reload" });
  t.mock.timers.tick(0);
  assert.deepEqual(h.sent, ["Continue the unfinished task."]);
  h.emit("session_shutdown", { reason: "quit" });
  h.emit("session_start", { reason: "startup" });
  t.mock.timers.tick(20000);
  assert.equal(h.sent.length, 1);
});

test("busy expiration waits for settled and long timers are chunked", async t => {
  const h = harness(t);
  await h.fail({ reset: "3000000" });
  t.mock.timers.tick(2147483647);
  assert.deepEqual(h.sent, []);
  h.busy(true);
  t.mock.timers.tick(3000000000 - 2147483647);
  assert.deepEqual(h.sent, []);
  h.busy(false);
  h.emit("agent_settled", { aborted: false });
  t.mock.timers.tick(0);
  assert.deepEqual(h.sent, ["Continue the unfinished task."]);
});

for (const event of ["session_compact", "session_compact_failed"]) test(`${event} resumes overdue recovery without agent_settled`, async t => {
  const h = harness(t);
  await h.fail();
  h.busy(true);
  t.mock.timers.tick(10000);
  h.emit(event, { reason: "manual" });
  t.mock.timers.tick(0);
  assert.deepEqual(h.sent, []);
  t.mock.timers.tick(100);
  h.busy(false);
  t.mock.timers.tick(2000);
  assert.deepEqual(h.sent, ["Continue the unfinished task."]);
});

test("cancellation invalidates deferred manual compaction completion", async t => {
  const h = harness(t);
  await h.fail();
  h.busy(true);
  t.mock.timers.tick(10000);
  h.emit("session_compact", { reason: "manual" });
  t.mock.timers.tick(100);
  h.emit("input");
  h.busy(false);
  t.mock.timers.tick(10000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.entries.at(-1).data.state, "cancelled");
});

test("success replacement and unrelated quota kinds do not schedule", async t => {
  const h = harness(t);
  await h.fail({ stop: "stop" });
  await h.fail({ type: "insufficient_quota" });
  t.mock.timers.tick(20000);
  assert.deepEqual(h.sent, []);
  assert.equal(h.entries.some(entry => entry.data), false);
});

test("Claude rejected subscription headers schedule",  async t => {
  const h = harness(t);
  await h.fail({ provider: "anthropic", type: "rate_limit_error", headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String((Date.now() + 10000) / 1000) } });
  t.mock.timers.tick(10000);
  assert.deepEqual(h.sent, ["Continue the unfinished task."]);
});
