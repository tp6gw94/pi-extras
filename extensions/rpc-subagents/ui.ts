import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TaskResult, ScheduleRecord, Dialog, CoordinationRequest } from "./domain.d.ts";
import { terminalTaskStates } from "./domain.mjs";
import { safeText, singleLineText } from "./viewer.mjs";

export type FleetUIModel = {
  tasks(): TaskResult[];
  schedules(): ScheduleRecord[];
  subscribe(listener: () => void): () => void;
};
export type FleetActions = {
  cancelTask(id: string): Promise<unknown>;
  viewTask(task: TaskResult): Promise<unknown>;
  respond(taskId: string, dialogId: string, answer: { cancelled?: boolean; confirmed?: boolean; value?: string }): Promise<unknown>;
  reply(taskId: string, requestId: string, answer: { cancelled?: boolean; value?: string }): Promise<unknown>;
  pauseSchedule(id: string): Promise<unknown>;
  resumeSchedule(id: string): Promise<unknown>;
  cancelSchedule(id: string, abortRunning: boolean): Promise<unknown>;
};

const stateLabels: Record<string, string> = {
  queued: "\uf017", starting: "\uf135", running: "\uf04b", waiting_input: "\uf075", cancelling: "\uf110",
  completed: "\uf00c", failed: "\uf057", cancelled: "\uf05e", interrupted: "\uf04d", active: "\uf205", paused: "\uf04c", missed: "\uf071",
};
const label = (status: string) => stateLabels[status] ?? singleLineText(status);
export const STATUS_WIDTH = Math.max(...Object.values(stateLabels).map((text) => visibleWidth(text)));
const statusCell = (status: string) => {
  const text = row(label(status));
  return text + " ".repeat(Math.max(0, STATUS_WIDTH - visibleWidth(text)));
};
const elapsed = (task: TaskResult) => `${Math.max(0, Math.floor(((task.finishedAt ?? Date.now()) - task.createdAt) / 1000))}s`;
const timeoutLabel = (task: TaskResult) => task.timeoutMs === undefined ? "" : ` \uf252${task.timeoutMs / 1000}s`;
const tpsLabel = (task: TaskResult) => {
  const tps = task.tps;
  const known = typeof tps === "number" && Number.isFinite(tps) && tps > 0;
  return `\uf0e7 ${known ? tps.toFixed(1) : "—"} tok/s`;
};
const tpsSuffix = (task: TaskResult) => terminalTaskStates.has(task.status) ? "" : ` ${tpsLabel(task)}`;
const formatTime = (time: number) => new Date(time).toLocaleString("sv-SE");
const shortId = (id: string) => id.slice(0, 4);
const clean = (text: unknown) => safeText(text);
const row = (text: unknown) => singleLineText(text);

export type FleetWidgetController = { toggle(): void };

export function installFleetWidget(ctx: ExtensionContext, model: FleetUIModel): FleetWidgetController | undefined {
  if (ctx.mode !== "tui") return;
  let expanded = false;
  let toolsExpanded = ctx.ui.getToolsExpanded();
  let disposed = false;
  let requestRender = () => {};
  const cache = new Map<string, { text: string; width: number; lines: string[] }>();
  const controller = { toggle() { if (disposed) return; expanded = !expanded; if (!expanded) cache.clear(); requestRender(); } };
  ctx.ui.setWidget("rpc-subagents", (tui, theme) => {
    requestRender = () => tui.requestRender();
    const unsubscribe = model.subscribe(() => tui.requestRender());
    const timer = setInterval(() => tui.requestRender(), 1000);
    return {
      render(width: number) {
        const currentToolsExpanded = ctx.ui.getToolsExpanded();
        if (currentToolsExpanded !== toolsExpanded) {
          toolsExpanded = currentToolsExpanded;
          expanded = !expanded;
          if (!expanded) cache.clear();
        }
        const tasks = model.tasks();
        const active = tasks.filter((task) => !terminalTaskStates.has(task.status));
        const previews = expanded ? active.slice(0, 3) : [];
        if (expanded && !active.length) {
          const latest = tasks.filter((task) => terminalTaskStates.has(task.status))
            .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))[0];
          if (latest) previews.push(latest);
        }
        const next = model.schedules().filter((record) => record.state.status === "active" && record.nextAt !== null)
          .sort((a, b) => a.nextAt! - b.nextAt!)[0];
        if (!active.length && !next && !previews.length) return [];
        const usable = Math.max(1, width);
        const lines = [theme.fg("accent", `RPC subagents  \uf0ae ${active.length}  ${expanded ? "\uf078 expanded" : "\uf054 collapsed"} Ctrl+O  /rpc-subagents`)];
        for (const task of active.slice(0, 3)) {
          lines.push(`${statusCell(task.status)} ${shortId(task.taskId)} ${row(task.name)} ${row(task.model.provider)}/${row(task.model.id)} ${row(task.thinking ?? "unknown")} ${elapsed(task)}${timeoutLabel(task)} ${row(task.currentTools.join(", "))}${tpsSuffix(task)}`);
        }
        if (active.length > 3) lines.push(`${active.length - 3} more tasks`);
        if (next) lines.push(`Next schedule ${shortId(next.scheduleId)} ${row(next.name)} ${formatTime(next.nextAt!)}`);
        const maxHeight = Math.max(0, Math.min(20, tui.terminal.rows - 8));
        if (expanded) lines.splice(maxHeight);
        let budget = Math.max(0, Math.min(15, maxHeight - lines.length));
        for (const id of cache.keys()) if (!previews.some((task) => task.taskId === id)) cache.delete(id);
        for (let index = 0; index < previews.length && budget >= 2; index++) {
          const task = previews[index];
          const height = Math.min(5, Math.floor(budget / (previews.length - index)));
          if (height < 2) break;
          let preview = cache.get(task.taskId);
          if (!preview || preview.text !== task.text || preview.width !== usable) {
            const text = safeText(task.text, 65536).replace(/\t/g, " ");
            const tail = text.slice(-Math.max(4096, usable * 8)).replace(/^[\uDC00-\uDFFF]/, "");
            const wrapped = tail.split(/[\n\u2028\u2029]/).slice(-4)
              .flatMap((line) => wrapTextWithAnsi(line, usable));
            preview = { text: task.text, width: usable, lines: text.trim() ? wrapped.slice(-4) : ["(no output yet)"] };
            cache.set(task.taskId, preview);
          }
          lines.push(theme.fg("muted", `${shortId(task.taskId)} output ${row(label(task.status))}${task.truncated ? " (retained text truncated)" : ""}${tpsSuffix(task)}`));
          const output = preview.lines.slice(-(height - 1));
          lines.push(...output);
          budget -= output.length + 1;
        }
        return lines.map((line) => truncateToWidth(line, usable));
      },
      invalidate() {},
      dispose() { disposed = true; cache.clear(); requestRender = () => {}; unsubscribe(); clearInterval(timer); },
    };
  });
  return controller;
}

type ScreenChoice = { kind: "task" | "schedule"; id: string; action: "cancel" | "view" | "respond" | "pause" | "resume" | "abort" };

export async function showFleetScreen(ctx: ExtensionContext, model: FleetUIModel, actions: FleetActions) {
  if (ctx.mode !== "tui") throw new Error("The RPC subagents screen is only available in TUI mode.");
  let selectedId: string | undefined;
  let tab: "task" | "schedule" = "task";
  for (;;) {
    const choice = await ctx.ui.custom<ScreenChoice | undefined>((tui, theme, _keybindings, done) => {
      let index = 0;
      let detail = false;
      let scroll = 0;
      const unsubscribe = model.subscribe(() => tui.requestRender());
      const timer = setInterval(() => tui.requestRender(), 1000);
      const entries = () => tab === "task" ? model.tasks().slice().reverse() : model.schedules();
      const itemId = (item: TaskResult | ScheduleRecord) => "taskId" in item ? item.taskId : item.scheduleId;
      const initial = entries().findIndex((entry) => itemId(entry) === selectedId);
      if (initial >= 0) index = initial;
      function selected() {
        const list = entries();
        index = Math.min(index, Math.max(0, list.length - 1));
        return list[index];
      }
      function finish(action: ScreenChoice["action"]) {
        const item = selected();
        if (!item) return;
        selectedId = itemId(item);
        done({ kind: tab, id: selectedId, action });
      }
      return {
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) {
            if (detail) { detail = false; scroll = 0; tui.requestRender(); } else done(undefined);
          } else if (matchesKey(data, Key.tab)) {
            tab = tab === "task" ? "schedule" : "task";
            index = 0; detail = false; scroll = 0;
            tui.requestRender();
          } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            const step = matchesKey(data, Key.up) ? -1 : 1;
            if (detail) scroll = Math.max(0, scroll + step);
            else index = Math.max(0, Math.min(entries().length - 1, index + step));
            tui.requestRender();
          } else if (matchesKey(data, Key.enter)) { detail = !detail; scroll = 0; tui.requestRender(); }
          else if (data === "c") finish("cancel");
          else if (tab === "task" && data === "v") finish("view");
          else if (tab === "task" && data === "r") finish("respond");
          else if (tab === "schedule" && data === "a") finish("abort");
          else if (tab === "schedule" && data === "p") {
            const item = selected() as ScheduleRecord | undefined;
            if (item) finish(item.state.status === "paused" ? "resume" : "pause");
          }
        },
        render(width: number) {
          const usable = Math.max(1, width);
          const rows = Math.max(4, Math.min(24, tui.terminal.rows - 6));
          const list = entries();
          const item = selected();
          const lines = [theme.fg("accent", `RPC subagents  ${tab === "task" ? "Tasks" : "Schedules"}`)];
          if (!item) lines.push("Nothing here yet.");
          else if (detail) {
            let text: string;
            if (tab === "task") {
              const task = item as TaskResult;
              const requests = task.state.status === "waiting_input" ? task.state.requests ?? [] : [];
              text = `${clean(task.taskId)} latest response${tpsSuffix(task)}\n${clean(task.name)}\nModel ${clean(task.model.provider)}/${clean(task.model.id)} ${row(task.thinking ?? "unknown")}\n${label(task.status)} ${elapsed(task)}${timeoutLabel(task)}\nDirectory ${clean(task.cwd)}\nTools ${clean(task.currentTools.join(", "))}\n${task.capabilities ? `Capabilities ${clean(task.capabilities.reachable.join(", "))}\n` : ""}${task.sessionId ? `Session ${clean(task.sessionId)}${task.sessionReusable === true ? " (resumable)" : " (not resumable)"}\n` : ""}${task.error ? `Error ${clean(task.error)}\n` : ""}${requests.length ? `Pending requests ${requests.map((request) => `${clean(request.requestId)} ${clean(request.question)}`).join("\n")}\n` : ""}${task.state.status === "waiting_input" && task.state.dialogs.length ? `Pending dialogs ${task.state.dialogs.map((dialog) => `${clean(dialog.id)} ${clean(dialog.title ?? dialog.method)}`).join("\n")}\n` : ""}\n${safeText(task.text, 65536)}${task.truncated ? "\n[Text truncated; open the viewer for the full log]" : ""}`;
            } else {
              const schedule = item as ScheduleRecord;
              text = `${clean(schedule.scheduleId)}\n${clean(schedule.name)}\n${label(schedule.state.status)}\n${clean(JSON.stringify(schedule.trigger))}\nNext ${schedule.nextAt === null ? "none" : formatTime(schedule.nextAt)}\n${label("running")} ${schedule.activeTaskIds.map(clean).join(", ")}\n${schedule.error ? `Error ${clean(schedule.error)}\n` : ""}\n${schedule.history.slice(-20).map((run) => `${formatTime(run.at)} ${label(run.status)} ${run.taskId ? row(run.taskId) : ""}`).join("\n")}`;
            }
            const wrapped = text.split(/[\n\u2028\u2029]/).flatMap((line) => wrapTextWithAnsi(line, usable));
            scroll = Math.min(scroll, Math.max(0, wrapped.length - rows));
            lines.push(...wrapped.slice(scroll, scroll + rows));
          } else {
            const start = Math.max(0, index - Math.floor(rows / 2));
            for (let i = start; i < Math.min(list.length, start + rows); i++) {
              const entry = list[i];
              const text = tab === "task" ? `${statusCell((entry as TaskResult).status)} ${shortId((entry as TaskResult).taskId)} ${row(entry.name)} ${elapsed(entry as TaskResult)}${timeoutLabel(entry as TaskResult)} ${row((entry as TaskResult).model.id)} ${row((entry as TaskResult).thinking ?? "unknown")}${tpsSuffix(entry as TaskResult)}`
                : `${shortId((entry as ScheduleRecord).scheduleId)} ${row(entry.name)} ${row(label(entry.state.status))} ${(entry as ScheduleRecord).nextAt ? formatTime((entry as ScheduleRecord).nextAt!) : ""}`;
              lines.push((i === index ? theme.fg("accent", "> ") : "  ") + text);
            }
          }
          lines.push(theme.fg("muted", tab === "task" ? "Tab switch  ↑↓ select or scroll  Enter details  c cancel  v Herdr  r respond  Esc back" : "Tab switch  ↑↓ select or scroll  Enter details  p pause/resume  c cancel  a cancel and abort tasks  Esc back"));
          return lines.map((line) => truncateToWidth(line, usable));
        },
        invalidate() {},
        dispose() { unsubscribe(); clearInterval(timer); },
      };
    });
    if (!choice) return;
    try {
      if (choice.kind === "task") {
        if (choice.action === "cancel") await actions.cancelTask(choice.id);
        else if (choice.action === "view") {
          const task = model.tasks().find((task) => task.taskId === choice.id);
          if (task) await actions.viewTask(task);
        } else if (choice.action === "respond") {
          const task = model.tasks().find((task) => task.taskId === choice.id);
          if (task?.state.status !== "waiting_input") { ctx.ui.notify("This task has no pending dialog.", "info"); continue; }
          const dialog = task.state.dialogs[0];
          if (dialog) await actions.respond(task.taskId, dialog.id, await answerDialog(ctx, dialog));
          else {
            const request = task.state.requests?.[0];
            if (!request) { ctx.ui.notify("This task has no pending dialog.", "info"); continue; }
            await actions.reply(task.taskId, request.requestId, await answerRequest(ctx, request));
          }
        }
      } else if (choice.action === "pause") await actions.pauseSchedule(choice.id);
      else if (choice.action === "resume") await actions.resumeSchedule(choice.id);
      else if (choice.action === "cancel" || choice.action === "abort") await actions.cancelSchedule(choice.id, choice.action === "abort");
    } catch (error) { ctx.ui.notify(clean(error instanceof Error ? error.message : error), "error"); }
  }
}

async function answerRequest(ctx: ExtensionContext, request: CoordinationRequest) {
  const value = await ctx.ui.input(`Subagent coordination request ${clean(request.requestId)}`, row(request.question));
  return value === undefined ? { cancelled: true } : { value };
}

async function answerDialog(ctx: ExtensionContext, dialog: Dialog) {
  const title = `Subagent request ${clean(dialog.title ?? dialog.method)}`;
  if (dialog.method === "confirm") return { confirmed: await ctx.ui.confirm(title, clean(dialog.message)) };
  let value: string | undefined;
  if (dialog.method === "select") {
    const options = dialog.options ?? [];
    const displays = options.map((option, index) => `${index + 1}. ${clean(option)}`);
    const selected = await ctx.ui.select(title, displays);
    value = selected === undefined ? undefined : options[displays.indexOf(selected)];
  } else if (dialog.method === "input") value = await ctx.ui.input(title, clean(dialog.placeholder));
  else value = await ctx.ui.editor(title, clean(dialog.prefill));
  return value === undefined ? { cancelled: true } : { value };
}
