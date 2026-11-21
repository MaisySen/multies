import { describe, expect, it } from "vitest";
import { signInDestination } from "../src/web/lib/pending-invite";

describe("Mnet post-login destinations", () => {
  it("keeps the exact local Mnet approval query and device-management path", () => {
    const next = "/mnet/authorize?deviceKey=key&challenge=proof&state=state&redirectUri=http%3A%2F%2F127.0.0.1%3A32145%2Fmnet%2Fcallback";
    expect(signInDestination(next, "/app")).toBe(next);
    expect(signInDestination("/mnet/enroll-v1?attemptId=fixture", "/app")).toBe("/mnet/enroll-v1?attemptId=fixture");
    expect(signInDestination("/mnet/devices", "/app")).toBe("/mnet/devices");
    expect(signInDestination("/mnet/enroll?attemptId=fixture", "/app")).toBe("/mnet/enroll?attemptId=fixture");
  });
  it("does not widen the return destination to arbitrary Mnet paths or origins", () => {
    for (const next of ["/mnet/enroll-v1-other?attemptId=x", "/mnet/enroll-v1/other?attemptId=x", "/mnet/other", "/mnet/devices/other", "/mnet/devices?redirect=https://example.test", "//example.test/mnet/authorize?state=x", "https://example.test/mnet/authorize?state=x"]) {
      expect(signInDestination(next, "/app")).toBe("/app");
    }
  });
});
