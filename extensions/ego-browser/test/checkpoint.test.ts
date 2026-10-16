import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRound, type RoundCommand } from "../ego-round.ts";

for (const abort of [false, true]) test(`native wait checkpoint survives child close, abort=${abort}`, { timeout: 15000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-checkpoint-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({ url: "http://localhost/", done: true, waitError: abort ? undefined : "inner native failure", waitDelay: abort ? 10000 : 0 }));
  const executable = join(dir, "cli");
  await writeFile(executable, `#!/bin/sh\nEGO_FAKE_STATE='${statePath}' exec '${process.execPath}' '${resolve("extensions/ego-browser/test/fake-cli.mjs")}'\n`);
  await chmod(executable, 0o755);
  const command: RoundCommand = { op: "act", space: 93, page: "p1", resultPath: join(dir, "result.json"), snapshotPath: join(dir, "snapshot.txt"), allowedOrigins: ["http://localhost"], candidates: [], checks: [], timeoutMs: 20000, action: { kind: "click", target: { selector: "button" } }, after: { kind: "text", selector: "h1", includes: "Order confirmed" } };
  const controller = new AbortController();
  const pending = runRound(command, controller.signal, executable);
  if (abort) {
    while (!t.signal.aborted) {
      const saved = await readFile(command.resultPath, "utf8").then(JSON.parse, () => undefined);
      if (saved?.diagnostics?.stage === "native_wait") break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    controller.abort(new Error("outer cancellation"));
  }
  const result = await pending;
  assert.equal(result.reason, "uncertain_effect");
  assert.equal(result.diagnostics?.stage, "native_wait");
  assert.equal(result.diagnostics?.after?.[0]?.actual, "Order confirmed");
  assert.equal(result.diagnostics?.after?.[0]?.status, "pass");
  assert.match(result.issue!, abort ? /outer cancellation/ : /inner native failure/);
});

for (const output of ["missing", "malformed", "success", "inner"]) test(`abort never promotes ${output} output`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-abort-output-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resultPath = join(dir, "result.json");
  const executable = join(dir, "cli");
  const value = output === "malformed" ? "{" : JSON.stringify({ reason: output === "inner" ? "uncertain_effect" : "acted", dispatched: true, issue: output === "inner" ? "original inner error" : undefined, diagnostics: { resultPath, stage: "native_wait" } });
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nprocess.stdin.resume();\nprocess.on('SIGTERM',()=>{${output === "missing" ? "" : `writeFileSync(${JSON.stringify(resultPath)},${JSON.stringify(value)});`}process.exit(0);});\nwriteFileSync(${JSON.stringify(join(dir, "ready"))},'ready');\nsetInterval(()=>{},1000);\n`);
  await chmod(executable, 0o755);
  const controller = new AbortController();
  const pending = runRound({ op: "act", space: 93, page: "p1", resultPath, snapshotPath: "", allowedOrigins: [], candidates: [], checks: [], timeoutMs: 1000 }, controller.signal, executable);
  while (!await readFile(join(dir, "ready")).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(new Error("cancelled now"));
  const result = await pending;
  assert.equal(result.reason, "uncertain_effect");
  assert.match(result.issue!, /cancelled now/);
  if (output === "inner") { assert.match(result.issue!, /original inner error/); assert.equal(result.diagnostics?.stage, "native_wait"); }
});

test("child spawn delay does not renew the round budget", async t => {
  const dir = await mkdtemp(join(tmpdir(), "ego-spawn-delay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({ url: "http://localhost/", done: true }));
  const executable = join(dir, "cli");
  await writeFile(executable, `#!/bin/sh\nsleep 1\nEGO_FAKE_STATE='${statePath}' exec '${process.execPath}' '${resolve("extensions/ego-browser/test/fake-cli.mjs")}'\n`);
  await chmod(executable, 0o755);
  const command: RoundCommand = { op: "act", space: 93, page: "p1", resultPath: join(dir, "result.json"), snapshotPath: join(dir, "snapshot.txt"), allowedOrigins: ["http://localhost"], candidates: [], checks: [], timeoutMs: 800, action: { kind: "click", target: { selector: "button" } } };
  const result = await runRound(command, new AbortController().signal, executable);
  assert.equal(result.reason, "uncertain_effect");
  assert.match(result.issue!, /Round deadline exceeded/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).mutations, undefined);
});
