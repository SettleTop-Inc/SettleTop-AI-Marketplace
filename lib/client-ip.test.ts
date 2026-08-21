import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "./client-ip.ts";

test("clientIp prefers x-real-ip (platform-set, non-spoofable) over x-forwarded-for", () => {
  assert.equal(
    clientIp(new Headers({ "x-real-ip": "5.6.7.8", "x-forwarded-for": "1.2.3.4, 10.0.0.1" })),
    "5.6.7.8"
  );
  assert.equal(clientIp(new Headers({ "x-real-ip": "5.6.7.8" })), "5.6.7.8");
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" })), "1.2.3.4");
  assert.equal(clientIp(new Headers()), "unknown");
});
