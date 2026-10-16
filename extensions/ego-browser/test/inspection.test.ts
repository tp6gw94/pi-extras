import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { inspectSource } from "../ego-round.ts";

class Element {
  hidden = false;
  visibility = "visible";
  display = "block";
  text: string;
  children: Element[];
  constructor(text: string, children: Element[] = []) {
    this.text = text;
    this.children = children;
  }
  get textContent(): string {
    return this.text + this.children.map(child => child.textContent).join("");
  }
  get innerText(): string {
    if (this.hidden || this.display === "none" || this.visibility === "hidden") return "";
    return this.text + this.children.map(child => child.innerText).join("");
  }
  getClientRects() {
    return this.hidden || this.display === "none" ? [] : [{}];
  }
}

for (const hiding of ["hidden", "display", "visibility"] as const) {
  test(`inspection excludes ${hiding} success descendants and check mode returns a boolean`, () => {
    const success = new Element("Order confirmed");
    if (hiding === "hidden") success.hidden = true;
    if (hiding === "display") success.display = "none";
    if (hiding === "visibility") success.visibility = "hidden";
    const confirmation = new Element("Pending", [success]);
    const inspect = runInNewContext(`(${inspectSource})`, {
      document: { querySelectorAll: () => [confirmation] },
      location: { href: "http://localhost/" },
      performance: { timeOrigin: 123 },
      getComputedStyle: (element: Element) => element,
    });
    const condition = { kind: "text", selector: "#confirmation", includes: "Order confirmed" };
    const input = { candidates: [], checks: [{ id: "confirmed", condition }] };
    assert.equal(confirmation.textContent, "PendingOrder confirmed");
    assert.equal(inspect(input).checks[0].actual, "Pending");
    assert.equal(inspect(input).checks[0].status, "fail");
    assert.equal(inspect({ ...input, mode: "checks" }), false);
    success.hidden = false;
    success.display = "block";
    success.visibility = "visible";
    assert.equal(inspect(input).checks[0].actual, "PendingOrder confirmed");
    assert.equal(inspect(input).checks[0].status, "pass");
    assert.equal(inspect({ ...input, mode: "checks" }), true);
    assert.equal(inspect({ candidates: [], checks: [], mode: "checks" }), false);
  });
}
