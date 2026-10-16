import assert from "node:assert/strict";
import type { Report } from "../schema.ts";

type OwnershipReport = Pick<Report, "reason" | "actionsUsed">;

export async function verifyOwnershipStop(begun: OwnershipReport, observe: () => Promise<OwnershipReport>) {
  assert.ok(["begun", "ownership_lost"].includes(begun.reason));
  assert.equal(begun.actionsUsed, 0);
  const result = begun.reason === "ownership_lost" ? begun : await observe();
  assert.equal(result.reason, "ownership_lost", "Agent-owned space does not prove ownership-stop");
  assert.equal(result.actionsUsed, 0);
}
