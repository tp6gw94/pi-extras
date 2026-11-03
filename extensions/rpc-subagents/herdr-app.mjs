import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { splitDirection, viewerCommand } from "./herdr.mjs";

const exec = promisify(execFile);

export function createHerdrAppCliAdapter({ app = "herdr-app", core = "hc", run = exec } = {}) {
  async function command(binary, args) {
    let stdout;
    try { ({ stdout } = await run(binary, args, { shell: false, timeout: 15000, maxBuffer: 4194304 })); }
    catch (error) {
      let reply;
      try { reply = JSON.parse(error.stdout); } catch { throw error; }
      throw new Error(`${binary} ${args.slice(0, 2).join(" ")} failed: ${reply?.error ?? error.message}`);
    }
    const value = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${binary} response must be a JSON object`);
    if (value.error) throw new Error(`${binary} ${args.slice(0, 2).join(" ")} failed: ${value.error}`);
    return value;
  }
  return {
    async panes() {
      const panes = new Map();
      for (const space of (await command(app, ["ls"])).spaces ?? []) {
        for (const tab of space.tabs ?? []) {
          for (const item of tab.terminals ?? []) if (item.pane) panes.set(item.pane, { terminal: item.terminal, tab: tab.id });
        }
      }
      return panes;
    },
    async focusedPane() { return (await command(app, ["status"])).focused_pane ?? undefined; },
    async size(terminal) {
      const value = await command(core, ["get", terminal]);
      return { width: value.cols, height: value.rows };
    },
    async split({ callerPaneId, direction, argv }) {
      const value = await command(app, ["do", "pane.split", JSON.stringify({ direction, pane: callerPaneId, argv })]);
      if (typeof value.pane !== "string" || !value.pane) throw new Error("Herdr app split response contains no pane ID");
      return value.pane;
    },
    async focus(paneId) { await command(app, ["do", "pane.focus", JSON.stringify({ pane: paneId })]); },
  };
}

export class HerdrAppOpener {
  constructor({ adapter, viewerPath, nodePath = process.execPath, env = process.env }) {
    Object.assign(this, { adapter, viewerPath, nodePath, env: { ...env } });
    this.bindings = new Map();
    this.pending = new Map();
  }
  open(task, { callerPaneId, direction } = {}) {
    if (this.pending.has(task.taskId)) return this.pending.get(task.taskId);
    const opening = this.openPane(task, { callerPaneId, direction });
    this.pending.set(task.taskId, opening);
    opening.finally(() => this.pending.delete(task.taskId)).catch(() => {});
    return opening;
  }
  async openPane(task, { callerPaneId, direction }) {
    const terminal = this.env.HC_TERMINAL_ID;
    if (!terminal) throw new Error("Herdr app viewer requires HC_TERMINAL_ID");
    const argv = [this.nodePath, this.viewerPath, "--events", task.eventFile];
    const command = viewerCommand({ nodePath: this.nodePath, viewerPath: this.viewerPath, eventFile: task.eventFile });
    const panes = await this.adapter.panes();
    const bound = this.bindings.get(task.taskId);
    if (bound && panes.has(bound)) return { taskId: task.taskId, paneId: bound, reused: true, command };
    this.bindings.delete(task.taskId);
    const caller = callerPaneId ?? [...panes].find(([, pane]) => pane.terminal === terminal)?.[0];
    if (!caller) throw new Error(`Herdr app shows no pane for terminal ${terminal}`);
    if (!panes.has(caller)) throw new Error("Explicit caller Herdr app pane no longer exists");
    const placement = direction ?? splitDirection(await this.adapter.size(panes.get(caller).terminal));
    if (!["right", "down"].includes(placement)) throw new Error("Viewer direction must be right or down");
    const focused = await this.adapter.focusedPane();
    const paneId = await this.adapter.split({ callerPaneId: caller, direction: placement, argv });
    this.bindings.set(task.taskId, paneId);
    if (focused && panes.get(focused)?.tab === panes.get(caller).tab) await this.adapter.focus(focused);
    return { taskId: task.taskId, paneId, reused: false, command };
  }
}
