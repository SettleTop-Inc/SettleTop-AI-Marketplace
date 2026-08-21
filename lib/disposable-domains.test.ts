import { test } from "node:test";
import assert from "node:assert/strict";
import { isDisposableDomain } from "./disposable-domains.ts";

test("isDisposableDomain flags known throwaway domains, allows real ones", () => {
  assert.equal(isDisposableDomain("a@mailinator.com"), true);
  assert.equal(isDisposableDomain("a@guerrillamail.com"), true);
  assert.equal(isDisposableDomain("niles@settletop.com"), false);
  assert.equal(isDisposableDomain("not-an-email"), false);
});
