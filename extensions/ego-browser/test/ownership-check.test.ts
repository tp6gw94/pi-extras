import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyOwnershipStop } from "./ownership-check.ts";

test("ownership harness accepts rejection at begin without observing", async () => {
  await verifyOwnershipStop({ reason: "ownership_lost", actionsUsed: 0 }, async () => {
    throw new Error("Rejected begin must not admit observe");
  });
});

test("ownership harness accepts an explicit observe stop", async () => {
  await verifyOwnershipStop({ reason: "begun", actionsUsed: 0 }, async () => ({ reason: "ownership_lost", actionsUsed: 0 }));
});

for (const reason of ["observed", "checks_passed", "browser_error"]) {
  test(`ownership harness rejects ${reason} rather than recording success`, async () => {
    await assert.rejects(verifyOwnershipStop({ reason: "begun", actionsUsed: 0 }, async () => ({ reason, actionsUsed: 0 })), /Agent-owned space does not prove ownership-stop/);
  });
}

test("ownership harness rejects mutation even with an ownership stop", async () => {
  await assert.rejects(verifyOwnershipStop({ reason: "begun", actionsUsed: 0 }, async () => ({ reason: "ownership_lost", actionsUsed: 1 })), /1 !== 0/);
});
