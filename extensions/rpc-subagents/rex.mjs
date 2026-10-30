import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nonempty } from "./domain.mjs";
import { splitDirection, viewerCommand } from "./herdr.mjs";

const exec = promisify(execFile);

export function createRexCliAdapter({ binary = "rex", run = exec } = {}) {
  async function command(args) {
    const { stdout } = await run(binary, args, { shell: false, timeout: 15000, maxBuffer: 1048576 });
    const value = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rex response must be a JSON object");
    return value;
  }
  return {
    async inspect(sessionId, blockId) {
      let value;
      try { value = await command(["block", "inspect", "-s", sessionId, blockId, "--json"]); }
      catch (error) { if (/not found/i.test(String(error.stderr))) return undefined; throw error; }
      return value.block?.block_id === blockId ? { paneId: blockId } : undefined;
    },
    async size(sessionId, blockId) {
      const value = await command(["block", "call", "-s", sessionId, "-b", blockId, "size"]);
      return { width: value.columns, height: value.rows };
    },
    async split({ sessionId, callerPaneId, direction, cwd, label, argv }) {
      const value = await command(["split", "-s", sessionId, "-b", callerPaneId, `--split=${direction}`, "--focus=false", "--keep-open",
        "--shell=none", "-c", cwd, "--label", label, "--json", "--", ...argv]);
      const id = value.block_ids?.[0];
      if (typeof id !== "string" || !id) throw new Error("Rex split response contains no block ID");
      return id;
    },
  };
}

export class RexOpener {
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
    const sessionId = this.env.REX_SESSION;
    if (!sessionId) throw new Error("Rex viewer requires REX_SESSION");
    nonempty(callerPaneId, "callerPaneId", 256);
    const argv = [this.nodePath, this.viewerPath, "--events", task.eventFile];
    const command = viewerCommand({ nodePath: this.nodePath, viewerPath: this.viewerPath, eventFile: task.eventFile });
    const bound = this.bindings.get(task.taskId);
    if (bound) {
      if (await this.adapter.inspect(sessionId, bound)) return { taskId: task.taskId, paneId: bound, reused: true, command };
      this.bindings.delete(task.taskId);
    }
    if (!await this.adapter.inspect(sessionId, callerPaneId)) throw new Error("Explicit caller Rex block no longer exists");
    const placement = direction ?? splitDirection(await this.adapter.size(sessionId, callerPaneId));
    if (!["right", "down"].includes(placement)) throw new Error("Viewer direction must be right or down");
    const paneId = await this.adapter.split({ sessionId, callerPaneId, direction: placement === "down" ? "below" : "right", cwd: task.cwd,
      label: `rpc ${task.name || task.taskId}`, argv });
    this.bindings.set(task.taskId, paneId);
    return { taskId: task.taskId, paneId, reused: false, command };
  }
}
