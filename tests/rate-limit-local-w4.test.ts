/**
 * W4 (e2e): since Wave 1 (client IP on self host) a Node request with no forwarded header is keyed by its socket
 * address, so on a local E2E server every request from the browser came from 127.0.0.1 and shared one counter. R34's
 * local opt out (E2E_LOCAL_RATE_KEYS) only matched "unknown", so the demo limit (5 an hour) and the sign up limit
 * tripped about 70 specs into a full run. A loopback socket address now counts as addressless on such servers only.
 */
import { describe, expect, it } from "vitest";
import { requestIp } from "../src/server/app";

describe("W4: local E2E servers treat loopback as addressless", () => {
  it("gives each loopback request its own key only with the local flag", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const a = requestIp(ip, true);
      expect(a).toMatch(/^unknown:/);
      expect(requestIp(ip, true)).not.toBe(a);
      expect(requestIp(ip, false)).toBe(ip);
      expect(requestIp(ip)).toBe(ip);
    }
    // A forwarded address (an E2E spec's X-Forwarded-For) is limited as always.
    expect(requestIp("10.77.0.3", true)).toBe("10.77.0.3");
    expect(requestIp("127.0.0.2", true)).toMatch(/^unknown:/);
  });
});
