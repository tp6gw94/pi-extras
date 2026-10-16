import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Action, Candidate, Check, Condition, Facts, RoundDiagnostics } from "./schema.ts";

export type RoundCommand = {
  op: "begin" | "observe" | "act" | "finish";
  space: number | string;
  page: string;
  resultPath: string;
  snapshotPath: string;
  screenshotPath?: string;
  allowedOrigins: string[];
  candidates: Candidate[];
  checks: Check[];
  timeoutMs: number;
  action?: Action;
  text?: string;
  after?: Condition;
  expected?: Facts;
  expectedDocument?: Pick<Facts, "documentId" | "url">;
};
export type RoundResult = { diagnostics?: RoundDiagnostics; reason: string; spaceId?: number; facts?: Facts; receipt?: unknown; issue?: string; dispatched?: boolean };

export const inspectSource = `({candidates, checks, mode = "facts"}) => {
  const visible = e => !!e && !!(e.getClientRects().length) && getComputedStyle(e).visibility !== "hidden";
  const controls = Object.fromEntries(candidates.map(c => {
    const nodes = document.querySelectorAll(c.action.selector);
    const e = nodes[0];
    const tag = e?.tagName;
    let supported = ["INPUT","TEXTAREA","SELECT","BUTTON","A"].includes(tag);
    if (c.action.kind === "fill") supported = tag === "TEXTAREA" || (tag === "INPUT" && ["text","email","password","search","tel","url","number"].includes(e.type));
    else if (c.action.kind === "select") supported = tag === "SELECT";
    else if (c.action.kind === "click") supported = ["BUTTON","A"].includes(tag);
    return [c.id, { eligible: nodes.length === 1 && supported && visible(e) && !e.disabled && !e.readOnly, count: nodes.length, tag: tag || null, type: e?.type || null, visible: visible(e), disabled: !!e?.disabled, value: e?.value ?? null, text: (e?.innerText || "").slice(0,512), href: e?.href || null, html: e?.outerHTML.slice(0,4096) || null }];
  }));
  const results = checks.map(({id,condition:c}) => {
    const nodes = c.kind === "url" ? [] : document.querySelectorAll(c.selector);
    const e = nodes[0];
    let actual;
    if (c.kind === "url") actual = location.href;
    else if (c.kind === "visible") actual = nodes.length === 1 && visible(e);
    else if (c.kind === "value") actual = e?.value ?? null;
    else actual = e?.innerText ?? null;
    let pass;
    if (c.kind === "url") pass = actual === c.equals;
    else if (nodes.length === 1) {
      if (c.kind === "visible") pass = actual;
      else if (c.kind === "value") pass = actual === c.equals;
      else pass = visible(e) && typeof actual === "string" && actual.includes(c.includes);
    } else pass = false;
    return {id, status: pass ? "pass" : "fail", actual, expected:c};
  });
  if (mode === "checks") return results.length > 0 && results.every(r => r.status === "pass");
  return {url:location.href, documentId:String(performance.timeOrigin), controls, checks:results};
}`;

const terminationGraceMs = 200;

export async function runRound(command: RoundCommand, signal: AbortSignal, executable = "ego-browser"): Promise<RoundResult> {
  signal.throwIfAborted();
  const deadline = Date.now() + command.timeoutMs - terminationGraceMs;
  const source = `const c = ${JSON.stringify(command)};
const fs = await import("node:fs/promises");
const inspect = ${inspectSource};
let dispatched = false;
let spaceId;
const deadline = ${deadline};
const remaining = () => {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error("Round deadline exceeded");
  return timeout;
};
const diagnostics = {resultPath:c.resultPath,stage:"attach"};
const publish = async result => {
  const path = c.resultPath + ".tmp";
  await fs.writeFile(path,JSON.stringify({...result,diagnostics}));
  await fs.rename(path,c.resultPath);
};
const main = async () => {
  const task = await taskSpace(c.space);
  spaceId = task.spaceId;
  if (task.ownership !== "agent") return {reason:"ownership_lost",spaceId};
  if (c.op === "begin") return {reason:"begun",spaceId};
  const page = task.page(c.page);
  if ((await page.info()).dialog) return {reason:"browser_prompt",spaceId};
  const before = await page.evaluate(inspect, c);
  const allowed = url => c.allowedOrigins.includes(new URL(url).origin);
  if (c.action?.kind !== "navigate" && !allowed(before.url)) return {reason:"scope_violation",spaceId,facts:before,dispatched:false};
  if (c.expectedDocument && (before.documentId !== c.expectedDocument.documentId || before.url !== c.expectedDocument.url)) return {reason:"stale",spaceId,facts:before,dispatched:false};
  if (c.expected && JSON.stringify(before) !== JSON.stringify(c.expected)) return {reason:"stale",spaceId,facts:before,dispatched:false};
  let receipt;
  if (c.op === "act") {
    const a = c.action;
    const target = a.selector ?? a.target?.ref ?? a.target?.selector;
    if (a.kind === "navigate" && !allowed(a.url)) return {reason:"scope_violation",spaceId};
    dispatched = true;
    diagnostics.stage = "action";
    await publish({reason:"uncertain_effect",spaceId,dispatched});
    const options = {timeout:remaining()};
    if (a.kind === "navigate") receipt = await page.goto(a.url, options);
    if (a.kind === "click") receipt = await page.click(target, options);
    if (a.kind === "fill") receipt = await page.fill(target, c.text, options);
    if (a.kind === "select") receipt = await page.selectOption(target, {value:c.text}, options);
    if (a.kind === "press") receipt = await page.press(target, a.key, options);
    if (receipt?.dialog || receipt?.popups?.length || (await page.info()).dialog) return {reason:"browser_prompt",spaceId,receipt,dispatched};
    if (!allowed(await page.url())) return {reason:"scope_violation",spaceId,receipt,dispatched};
    if (c.after) {
      const predicate = {candidates:[],checks:[{id:"after",condition:c.after}]};
      diagnostics.stage = "after_inspection";
      await publish({reason:"uncertain_effect",spaceId,dispatched});
      const evidence = await page.evaluate(inspect, predicate);
      diagnostics.after = evidence.checks.map(check => ({...check,actual:typeof check.actual === "string" ? check.actual.slice(0,4096) : check.actual}));
      diagnostics.stage = "native_wait";
      await publish({reason:"uncertain_effect",spaceId,dispatched});
      await page.waitForFunction(inspect, {...predicate,mode:"checks"}, {timeout:remaining()});
    }
  }
  diagnostics.stage = "evidence";
  const facts = c.op === "finish" ? before : await page.evaluate(inspect,c);
  const snapshot = await page.snapshot();
  if (typeof snapshot !== "string") return {reason:"unsupported_observation",spaceId,dispatched};
  await fs.writeFile(c.snapshotPath,snapshot);
  if (c.screenshotPath) await page.screenshot({path:c.screenshotPath});
  if (!allowed(facts.url)) return {reason:"scope_violation",spaceId,facts,receipt,dispatched};
  if (c.op === "finish") {
    if (!facts.checks.length || !facts.checks.every(check => check.status === "pass")) return {reason:"check_failed",spaceId,facts,dispatched};
    dispatched = true;
    diagnostics.stage = "finish";
    await publish({reason:"uncertain_effect",spaceId,dispatched});
    receipt = await task.finish({keep:[]});
    return {reason:"finished",spaceId,facts,receipt,dispatched};
  }
  return {reason:c.op === "act" ? "acted" : "observed",spaceId,facts,receipt,dispatched};
};
let result;
try {
  result = await main();
} catch(error) {
  diagnostics.innerIssue = String(error);
  result = {reason:dispatched ? "uncertain_effect" : "browser_error",spaceId,dispatched,issue:String(error)};
}
await publish(result);
`;
  const inheritedKeys = ["PATH", "HOME", "USER", "TMPDIR", "SHELL", "LANG"];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => inheritedKeys.includes(key) || key.startsWith("EGO_")),
  );
  const transportIssue = await new Promise<string | undefined>((resolve) => {
    const child = spawn(executable, ["nodejs"], { env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), terminationGraceMs);
    };

    signal.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", data => {
      stderr = (stderr + data).slice(-4096);
    });
    child.stdin.on("error", () => {});
    child.on("error", error => resolve(String(error)));
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      clearTimeout(killTimer);
      if (signal.aborted) resolve(String(signal.reason));
      else if (code !== 0) resolve(`Ego exited ${code}: ${stderr}`);
      else resolve(undefined);
    });
    child.stdin.end(source);
    if (signal.aborted) abort();
  });
  let saved: RoundResult | undefined;
  let readIssue: string | undefined;
  try {
    const value: unknown = JSON.parse(await readFile(command.resultPath, "utf8"));
    const malformed = !value || typeof value !== "object" || !("reason" in value) || typeof value.reason !== "string";
    if (malformed) throw new Error("Malformed round result");
    saved = value as RoundResult;
  } catch (error) {
    readIssue = String(error);
  }
  if (!transportIssue && !readIssue && !signal.aborted) return saved!;
  const issue = [saved?.issue, transportIssue, readIssue].filter(Boolean).join("; ");
  const mutatingOp = command.op === "act" || command.op === "finish";
  const uncertain = saved?.dispatched === true || (saved?.dispatched !== false && mutatingOp);
  return {
    ...saved,
    reason: uncertain ? "uncertain_effect" : signal.aborted ? "cancelled" : "browser_error",
    issue,
    diagnostics: { resultPath: command.resultPath, stage: "unknown", ...saved?.diagnostics, transportIssue: transportIssue ?? readIssue },
  };
}
