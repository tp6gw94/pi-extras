import test from "node:test";
import assert from "node:assert/strict";
import registerChildBridge, { collectToolInventory, readLaunchBinding } from "../child.ts";
import { BOOTSTRAP_COMMAND_NAME, PARENT_TOOL_NAME, decodeCoordinationEnvelope, verifyCapabilities } from "../coordination.mjs";
import { CHILD_BINDING_ENV } from "../runtime.mjs";

const binding = { taskId: "task-1", ownerId: "owner-1", nonce: "nonce-1" };
const launchEnv = (overrides = {}) => ({
  [CHILD_BINDING_ENV.flag]: "1",
  [CHILD_BINDING_ENV.taskId]: binding.taskId,
  [CHILD_BINDING_ENV.ownerId]: binding.ownerId,
  [CHILD_BINDING_ENV.nonce]: binding.nonce,
  [CHILD_BINDING_ENV.async]: "1",
  ...overrides,
});

const toolInventory = [
  { name: "read", exposure: "direct" },
  { name: "bash", exposure: "direct" },
  { name: "grep", exposure: "direct" },
  { name: "codemode", exposure: "model-only" },
  { name: "internal", exposure: "hidden" },
  { name: PARENT_TOOL_NAME, exposure: "model-only" },
];
const activeTools = ["read", "bash", "codemode", PARENT_TOOL_NAME];

function fakePi() {
  const state = { tools: new Map(), commands: new Map(), events: [], handlers: new Map(), allTools: toolInventory, active: activeTools };
  return {
    state,
    registerTool(definition) { state.tools.set(definition.name, definition); },
    registerCommand(name, definition) { state.commands.set(name, definition); },
    on(event, handler) {
      state.events.push(event);
      const list = state.handlers.get(event) ?? [];
      list.push(handler);
      state.handlers.set(event, list);
      return () => {};
    },
    async fire(event, ctx) { for (const handler of state.handlers.get(event) ?? []) await handler({}, ctx); },
    getAllTools() { return state.allTools; },
    getActiveTools() { return state.active; },
    setActiveTools(names) { state.active = names; },
  };
}

function fakeContext() {
  const notifications = [];
  const inputs = [];
  return {
    notifications,
    inputs,
    ui: {
      notify(message) { notifications.push(message); },
      input(title, placeholder, options) {
        const record = { title, placeholder, options };
        inputs.push(record);
        return new Promise((resolve) => {
          record.resolve = resolve;
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        });
      },
    },
  };
}

function bridge(env = launchEnv()) {
  const pi = fakePi();
  registerChildBridge(pi, env);
  return pi;
}

const parentTool = (pi) => pi.state.tools.get(PARENT_TOOL_NAME);

test("the bridge registers only under a complete explicit child launch binding", () => {
  const plain = fakePi();
  registerChildBridge(plain, {});
  registerChildBridge(plain, { ...launchEnv(), [CHILD_BINDING_ENV.flag]: "0" });
  registerChildBridge(plain, launchEnv({ [CHILD_BINDING_ENV.async]: "" }));
  assert.equal(plain.state.tools.size, 0);
  assert.equal(plain.state.commands.size, 0);

  const bound = fakePi();
  registerChildBridge(bound, launchEnv());
  assert.equal(parentTool(bound).exposure, "model-only");
  assert.deepEqual(parentTool(bound).parameters.properties.kind.enum, ["ask", "report"]);
  assert.ok(bound.state.commands.has(BOOTSTRAP_COMMAND_NAME));
  assert.deepEqual(bound.state.events, []);

  assert.deepEqual(readLaunchBinding(launchEnv()), { binding, asynchronous: true, webTools: [] });
  assert.equal(readLaunchBinding(launchEnv({ [CHILD_BINDING_ENV.async]: "0" })).asynchronous, false);
  assert.equal(readLaunchBinding({}), undefined);
  assert.equal(readLaunchBinding(launchEnv({ [CHILD_BINDING_ENV.nonce]: "" })), undefined);
});

test("the bootstrap command emits a verifiable inventory without a model call or session_start", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  await pi.state.commands.get(BOOTSTRAP_COMMAND_NAME).handler("", ctx);
  assert.equal(ctx.inputs.length, 0);
  assert.equal(ctx.notifications.length, 1);
  const envelope = decodeCoordinationEnvelope(ctx.notifications[0], binding);
  assert.equal(envelope.kind, "inventory");
  assert.deepEqual(envelope.inventory.registered, toolInventory.map((tool) => tool.name));
  assert.deepEqual(envelope.inventory.active, activeTools);
  assert.deepEqual(envelope.inventory.declared, activeTools);
  assert.deepEqual(envelope.inventory.callable, ["read", "bash"]);
  assert.equal(collectToolInventory(pi).exposures.codemode, "model-only");
  assert.deepEqual(verifyCapabilities(["read", "bash", "codemode"], [], envelope.inventory).reachable, ["bash", "codemode", "read", PARENT_TOOL_NAME]);
  assert.throws(() => verifyCapabilities(["read", "bash"], [], envelope.inventory), /unexpected \[codemode\]/);
  assert.equal(Object.hasOwn(envelope.inventory, "webTools"), false);
  assert.deepEqual(pi.state.events, []);
});

test("web access opts the bridge into inventory refresh after bootstrap and only on change", async () => {
  const ctx = fakeContext();
  const plain = bridge();
  await plain.state.commands.get(BOOTSTRAP_COMMAND_NAME).handler("", ctx);
  await plain.fire("tool_result", ctx);
  assert.deepEqual(plain.state.events, []);
  assert.equal(ctx.notifications.length, 1);

  const webPi = bridge(launchEnv({ [CHILD_BINDING_ENV.webTools]: "web_search,web_enable" }));
  assert.deepEqual(webPi.state.events, ["session_start", "session_tree", "tool_result", "before_agent_start"]);
  assert.deepEqual(readLaunchBinding(launchEnv({ [CHILD_BINDING_ENV.webTools]: "web_search,web_enable" })).webTools, ["web_search", "web_enable"]);
  assert.deepEqual(readLaunchBinding(launchEnv()).webTools, []);
  const webCtx = fakeContext();
  await webPi.fire("tool_result", webCtx);
  await webPi.fire("before_agent_start", webCtx);
  assert.deepEqual(webCtx.notifications, []);
  await webPi.state.commands.get(BOOTSTRAP_COMMAND_NAME).handler("", webCtx);
  assert.equal(webCtx.notifications.length, 1);
  await webPi.fire("before_agent_start", webCtx);
  assert.equal(webCtx.notifications.length, 1);
  webPi.state.allTools = [...toolInventory, { name: "web_search", exposure: "direct" }];
  webPi.state.active = [...activeTools, "web_search"];
  await webPi.fire("tool_result", webCtx);
  assert.equal(webCtx.notifications.length, 2);
  const refreshed = decodeCoordinationEnvelope(webCtx.notifications[1], binding).inventory;
  assert.equal(refreshed.registered.includes("web_search"), true);
  assert.equal(Object.hasOwn(refreshed, "webTools"), false);
  await webPi.fire("tool_result", webCtx);
  assert.equal(webCtx.notifications.length, 2);
});

test("web session handlers restore a reachable loader or the functional tools", async () => {
  const dynamic = bridge(launchEnv({ [CHILD_BINDING_ENV.webTools]: "web_search,web_enable" }));
  await dynamic.fire("session_start", fakeContext());
  assert.deepEqual(dynamic.state.active, [...activeTools, "web_enable"]);
  dynamic.state.active = [...activeTools, "web_search"];
  await dynamic.fire("session_tree", fakeContext());
  assert.deepEqual(dynamic.state.active, [...activeTools, "web_search"]);

  const eager = bridge(launchEnv({ [CHILD_BINDING_ENV.webTools]: "web_search,web_tools" }));
  await eager.fire("session_tree", fakeContext());
  assert.deepEqual(eager.state.active, [...activeTools, "web_search", "web_tools"]);
});

test("report emits one report envelope and returns after emission", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const result = await parentTool(pi).execute("call-1", { kind: "report", message: "Half done." }, undefined, undefined, ctx);
  assert.equal(ctx.inputs.length, 0);
  assert.equal(ctx.notifications.length, 1);
  const envelope = decodeCoordinationEnvelope(ctx.notifications[0], binding);
  assert.equal(envelope.kind, "report");
  assert.equal(envelope.message, "Half done.");
  assert.deepEqual(result.details, { status: "reported", messageId: envelope.messageId });
  assert.equal(result.content[0].text, JSON.stringify(result.details));
});

test("a synchronous task returns requires_async without opening a dialog", async () => {
  const pi = bridge(launchEnv({ [CHILD_BINDING_ENV.async]: "0" }));
  const ctx = fakeContext();
  const result = await parentTool(pi).execute("call-1", { kind: "ask", question: "Which approach?" }, undefined, undefined, ctx);
  assert.deepEqual(result.details, { status: "requires_async" });
  assert.equal(ctx.inputs.length, 0);
  assert.deepEqual(ctx.notifications, []);
});

test("an async ask carries its envelope on the RPC input dialog and resolves the answer", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const pending = parentTool(pi).execute("call-1", { kind: "ask", question: "Which approach?", timeoutMs: 2000 }, undefined, undefined, ctx);
  assert.equal(ctx.inputs.length, 1);
  const dialog = ctx.inputs[0];
  assert.equal(dialog.placeholder, "Answer for the blocked child task");
  assert.ok(dialog.options.timeout > 1500 && dialog.options.timeout <= 2000);
  assert.ok(dialog.options.signal instanceof AbortSignal);
  const ask = decodeCoordinationEnvelope(dialog.title, binding);
  assert.equal(ask.kind, "ask");
  assert.equal(ask.question, "Which approach?");
  assert.match(ask.requestId, /^ask-[0-9a-f-]{36}$/);
  assert.ok(ask.expiresAt > Date.now() && ask.expiresAt <= Date.now() + 2000);
  assert.equal(ctx.notifications.length, 0);
  dialog.resolve("Use approach A.");
  const result = await pending;
  assert.deepEqual(result.details, { status: "answered", value: "Use approach A." });
  const closed = decodeCoordinationEnvelope(ctx.notifications[0], binding);
  assert.equal(closed.kind, "ask_closed");
  assert.equal(closed.requestId, ask.requestId);
  assert.equal(closed.reason, "answered");
});

test("a dismissed ask reports cancelled and closes the request", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const pending = parentTool(pi).execute("call-1", { kind: "ask", question: "Continue?" }, undefined, undefined, ctx);
  const ask = decodeCoordinationEnvelope(ctx.inputs[0].title, binding);
  ctx.inputs[0].resolve(undefined);
  const result = await pending;
  assert.deepEqual(result.details, { status: "cancelled" });
  const closed = decodeCoordinationEnvelope(ctx.notifications[0], binding);
  assert.deepEqual({ requestId: closed.requestId, reason: closed.reason }, { requestId: ask.requestId, reason: "cancelled" });
});

test("an aborted turn dismisses the ask and closes it as aborted", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const controller = new AbortController();
  const pending = parentTool(pi).execute("call-1", { kind: "ask", question: "Continue?" }, controller.signal, undefined, ctx);
  assert.equal(ctx.inputs.length, 1);
  controller.abort();
  const result = await pending;
  assert.deepEqual(result.details, { status: "cancelled" });
  assert.equal(decodeCoordinationEnvelope(ctx.notifications[0], binding).reason, "aborted");
});

test("an unanswered ask expires as a timeout rather than as authorization", async () => {
  const pi = bridge();
  const ctx = fakeContext();
  const result = await parentTool(pi).execute("call-1", { kind: "ask", question: "Anyone there?", timeoutMs: 1000 }, undefined, undefined, ctx);
  assert.deepEqual(result.details, { status: "cancelled" });
  assert.equal(decodeCoordinationEnvelope(ctx.notifications[0], binding).reason, "timeout");
});
