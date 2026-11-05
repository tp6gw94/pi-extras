import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { textContent, terminalTaskStates } from "./domain.mjs";
import { COORDINATION_PREFIX } from "./coordination.mjs";

export class TerminalSanitizer {
  constructor() { this.state = "text"; }
  push(text) {
    let output = "";
    for (const char of String(text)) {
      const code = char.codePointAt(0);
      if (this.state === "text") {
        if (code === 0x1b) this.state = "escape";
        else if (code === 0x9b) this.state = "csi";
        else if (code === 0x9d) this.state = "osc";
        else if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) this.state = "string";
        else if (char === "\n" || char === "\t" || (code >= 0x20 && !(code >= 0x7f && code <= 0x9f) && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069))) output += char;
      } else if (this.state === "escape") {
        if (char === "[") this.state = "csi";
        else if (char === "]") this.state = "osc";
        else if (["P", "X", "^", "_"].includes(char)) this.state = "string";
        else if (code >= 0x30 && code <= 0x7e) this.state = "text";
      } else if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        else if (code === 0x1b) this.state = "escape";
      } else if (this.state === "osc" || this.state === "string") {
        if (code === 0x9c || (this.state === "osc" && code === 7)) this.state = "text";
        else if (code === 0x1b) { this.previous = this.state; this.state = "string_escape"; }
      } else if (this.state === "string_escape") {
        this.state = char === "\\" ? "text" : this.previous;
      }
    }
    return output;
  }
}

export function safeText(value, max = 8192) { return new TerminalSanitizer().push(String(value ?? "").slice(0, max)); }
export function singleLineText(value, max = 8192) { return safeText(value, max).replace(/[\n\t\u2028\u2029]/g, " "); }

const SGR = { bold: 1, dim: 2, italic: 3, red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36 };
const painter = (color) => (spec, text) => color && text ? `\x1b[${spec.split(" ").map((name) => SGR[name]).join(";")}m${text}\x1b[0m` : text;
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STATUS_TONES = { completed: "green", failed: "red", interrupted: "red", cancelled: "dim", cancelling: "dim", waiting_input: "yellow" };
const NOTIFY_TONES = { error: "red", warning: "yellow" };
const ARGUMENT_LINES = 30;

const statusLabel = (status) => safeText(status).replace("_", " ");
const statusTone = (status) => STATUS_TONES[status] ?? "cyan";

function duration(ms) {
  if (!(ms >= 1000)) return "";
  return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export class EventRenderer {
  constructor({ color = false } = {}) {
    this.paint = painter(color);
    this.streams = new Map();
    this.tools = new Map();
    this.terminal = false;
    this.said = "";
    this.tail = "\n\n";
  }

  render(record) {
    const text = this.event(record) ?? "";
    if (text) this.tail = (this.tail + text).slice(-2);
    return text;
  }

  gap() { return this.tail === "\n\n" ? "" : this.tail.endsWith("\n") ? "\n" : "\n\n"; }
  newline(text = "") { return (this.tail + text).endsWith("\n") ? "" : "\n"; }

  indent(text) { return text.split("\n").map((line) => `  ${line}`).join("\n"); }

  gutter(text, error, lineStart) {
    const bar = `${this.paint(error ? "red" : "dim", "│")} `;
    return (lineStart ? bar : "") + text.replace(/\n(?!$)/g, `\n${bar}`);
  }

  stream(index, delta, spoken) {
    if (!this.streams.has(index)) this.streams.set(index, { sanitizer: new TerminalSanitizer(), pending: "" });
    const stream = this.streams.get(index);
    const pushed = stream.sanitizer.push(delta);
    if (spoken) this.said += pushed;
    const text = stream.pending + pushed;
    const body = text.replace(/\n+$/, "");
    stream.pending = text.slice(body.length);
    return body;
  }

  argumentLines(args) {
    const p = this.paint;
    const text = (value, max = 2048) => safeText(value, max).split("\n");
    if (typeof args.command === "string") return text(args.command).map((line, i) => `${p("dim", i ? " " : "$")} ${line}`);
    if (typeof args.code === "string") return text(args.code);
    if (typeof args.path === "string") {
      const range = args.offset || args.limit ? p("dim", ` lines ${args.offset ?? 1}${args.limit ? `+${args.limit}` : ""}`) : "";
      const head = p("bold", singleLineText(args.path)) + range;
      if (Array.isArray(args.edits)) return [head, ...args.edits.flatMap((edit) => [
        ...text(edit.oldText, 1024).map((line) => p("red", `- ${line}`)),
        ...text(edit.newText, 1024).map((line) => p("green", `+ ${line}`)),
      ])];
      if (typeof args.content === "string") return [head + p("dim", ` ${args.content.split("\n").length} lines`)];
      return [head];
    }
    return Object.entries(args ?? {}).flatMap(([key, value]) => text(typeof value === "string" ? value : JSON.stringify(value))
      .map((line, i) => `${p("dim", i ? " ".repeat(key.length) : singleLineText(key))} ${line}`));
  }

  toolStart(event, at) {
    const p = this.paint;
    this.tools.set(event.toolCallId, { shown: "", at });
    const lines = this.argumentLines(event.args);
    const shown = lines.length > ARGUMENT_LINES ? [...lines.slice(0, ARGUMENT_LINES), p("dim", `… ${lines.length - ARGUMENT_LINES} more lines`)] : lines;
    return `${this.gap()}${p("bold cyan", "▸")} ${p("bold", safeText(event.toolName))}\n${shown.length ? `${this.indent(shown.join("\n"))}\n` : ""}`;
  }

  toolOutput(event, text, final) {
    const tool = this.tools.get(event.toolCallId) ?? { shown: "" };
    this.tools.set(event.toolCallId, tool);
    const continues = text.startsWith(tool.shown);
    if (!continues && !final) return "";
    const fresh = continues ? text.slice(tool.shown.length) : text;
    tool.shown = text;
    if (!fresh) return "";
    if (continues) return this.gutter(safeText(fresh, 4096), event.isError, this.tail.endsWith("\n"));
    return `${this.newline()}${this.paint("dim", "final output")}\n${this.gutter(safeText(fresh, 4096), event.isError, true)}`;
  }

  toolEnd(event, at) {
    const p = this.paint;
    const body = this.toolOutput(event, textContent(event.result?.content), true);
    const elapsed = duration(at - this.tools.get(event.toolCallId)?.at);
    this.tools.delete(event.toolCallId);
    const mark = event.isError ? p("bold red", `✗ ${safeText(event.toolName)} failed`) : p("green", `✓ ${safeText(event.toolName)}`);
    return `${body}${this.newline(body)}${mark}${elapsed ? p("dim", ` · ${elapsed}`) : ""}\n`;
  }

  fleet(event) {
    const p = this.paint;
    if (event.type === "task_created") {
      const task = event.task;
      return `${this.gap()}${p("bold", safeText(task.name))}\n${p("dim", `${safeText(task.taskId)} · ${safeText(task.model.provider)}/${safeText(task.model.id)}`)}\n`;
    }
    if (event.type === "task_state") {
      const status = event.state.status;
      return `${this.gap()}${p(statusTone(status), `● ${statusLabel(status)}`)}${status === "waiting_input" ? p("dim", " waiting for an explicit response") : ""}\n`;
    }
    if (event.type === "task_terminal") {
      if (this.terminal) return "";
      this.terminal = true;
      return `${this.gap()}${p(`bold ${statusTone(event.status)}`, `── Result · ${statusLabel(event.status)} ──`)}\n`;
    }
    if (event.type === "task_result") {
      this.terminal = true;
      const task = event.task;
      const text = safeText(task.text, 65536);
      return `${this.gap()}${[
        p(`bold ${statusTone(task.status)}`, `── Result · ${statusLabel(task.status)} ──`),
        text.trim() === this.said.trim() ? "" : text,
        task.truncated ? p("dim", "[Output truncated; the full events are kept in the log file]") : "",
        task.error ? p("red", `Error ${safeText(task.error)}`) : "",
        task.state.reason ? p("dim", `Reason ${safeText(task.state.reason)}`) : "",
      ].filter(Boolean).join("\n")}\n`;
    }
    if (event.type === "coordination_report") return `${this.gap()}${p("bold magenta", "↑ Report")}\n${this.indent(safeText(event.report?.message))}\n`;
    if (event.type === "dialog_responded") return `${this.gap()}${p("dim", `Dialog ${safeText(event.dialogId)} ${event.cancelled ? "cancelled" : "answered"}`)}\n`;
    return "";
  }

  event(record) {
    const event = record.event;
    if (!event) return "";
    if (record.source === "fleet") return this.fleet(event);
    const p = this.paint;
    if (record.source === "stderr") return `${this.gap()}${p("yellow", "stderr")} ${safeText(event.text)}\n`;
    if (event.type === "message_start" && event.message?.role === "assistant") { this.streams.clear(); this.said = ""; return ""; }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_start") return this.gap();
      if (update?.type === "text_delta") return this.stream(update.contentIndex, update.delta, true);
      if (update?.type === "thinking_delta") {
        const body = this.stream(update.contentIndex, update.delta);
        const stream = this.streams.get(update.contentIndex);
        const text = stream.opened ? body : body.replace(/^\n+/, "");
        if (!text) return "";
        const lead = stream.opened ? "" : `${this.gap()}${p("dim", "┊")} `;
        stream.opened = true;
        return lead + text.split("\n").map((line) => p("dim italic", line)).join(`\n${p("dim", "┊")} `);
      }
      if (update?.type === "text_end") return this.newline();
      if (update?.type === "thinking_end") return this.streams.get(update.contentIndex)?.opened ? this.newline() : "";
      return "";
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      this.streams.clear();
      return event.message.errorMessage ? `${this.gap()}${p("red", `Model error ${safeText(event.message.errorMessage)}`)}\n` : this.newline();
    }
    if (event.type === "tool_execution_start") return this.toolStart(event, record.at);
    if (event.type === "tool_execution_update") return this.toolOutput(event, textContent(event.partialResult?.content), false);
    if (event.type === "tool_execution_end") return this.toolEnd(event, record.at);
    if (event.type === "extension_ui_request") {
      if (DIALOG_METHODS.has(event.method)) return `${this.gap()}${p("bold yellow", "?")} ${p("yellow", safeText(event.title ?? event.message))}${p("dim", " waiting for an answer")}\n`;
      if (event.method === "notify" && !String(event.message).startsWith(COORDINATION_PREFIX)) return `${this.gap()}${p(NOTIFY_TONES[event.notifyType] ?? "cyan", "!")} ${safeText(event.message)}\n`;
      return "";
    }
    if (event.type === "auto_retry_start") return `${this.gap()}${p("yellow", `↻ Retry ${safeText(event.attempt)}`)} ${safeText(event.errorMessage)}\n`;
    if (event.type === "auto_retry_end" && !event.success) return `${this.gap()}${p("red", "Retry failed")} ${safeText(event.finalError)}\n`;
    if (event.type === "response" && event.success === false) return `${this.gap()}${p("red", `RPC failed ${safeText(event.command)}`)} ${safeText(event.error)}\n`;
    if (event.type === "extension_error") return `${this.gap()}${p("red", "Extension error")} ${safeText(event.error)}\n`;
    return "";
  }
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function replayAndFollow(file, { write, signal, maxReplayBytes = 1048576, pollMs = 250, follow = true, color = false } = {}) {
  const handle = await open(file, "r");
  const renderer = new EventRenderer({ color });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let offset;
  let discard;
  try {
    const size = (await handle.stat()).size;
    offset = Math.max(0, size - maxReplayBytes);
    discard = offset > 0;
    if (discard) await write(`[Skipped the first ${offset} bytes; replaying only the end of the log]\n`);
    const bytes = Buffer.alloc(65536);
    while (!signal?.aborted) {
      const read = await handle.read(bytes, 0, bytes.length, offset);
      if (!read.bytesRead) {
        if (!renderer.terminal) {
          let saved;
          try { saved = JSON.parse(await readFile(join(dirname(file), "state.json"), "utf8")); } catch {}
          if (terminalTaskStates.has(saved?.status)) {
            await write(renderer.render({ source: "fleet", event: { type: "task_result", task: saved } }));
          }
        }
        if (!follow || renderer.terminal) return;
        await sleep(pollMs, signal);
        continue;
      }
      offset += read.bytesRead;
      buffer += decoder.write(bytes.subarray(0, read.bytesRead));
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (discard) { discard = false; continue; }
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { await write("[Skipped an event that could not be parsed]\n"); continue; }
        const text = renderer.render(record);
        if (text) await write(text);
      }
      if (Buffer.byteLength(buffer) > 8388608) {
        buffer = "";
        discard = true;
        await write("[Skipped an event over the size limit]\n");
      }
    }
  } finally { await handle.close(); }
}

async function main() {
  const index = process.argv.indexOf("--events");
  if (index < 0 || !process.argv[index + 1]) throw new Error("Usage: node viewer.mjs --events /absolute/path/events.jsonl");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await replayAndFollow(process.argv[index + 1], {
      signal: controller.signal,
      color: Boolean(process.stdout.isTTY),
      write: (text) => new Promise((resolve, reject) => process.stdout.write(text, (error) => error ? reject(error) : resolve())),
    });
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(safeText(error.message) + "\n"); process.exitCode = 1; });
}
