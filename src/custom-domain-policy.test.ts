import assert from "node:assert/strict";
import test from "node:test";
import { decideCutover } from "./custom-domain-policy.ts";

test("payment links remain on the incumbent hostname until verification finishes", () => {
  assert.deepEqual(decideCutover(false), {
    state: "awaiting_dns",
    customerMessage: "DNS verification is still pending."
  });
  assert.equal(decideCutover(true).state, "ready");
});
