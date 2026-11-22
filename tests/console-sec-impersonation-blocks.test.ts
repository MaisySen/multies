/**
 * OPS1 security review L1: routes that set where the workspace's data is sent, call such a URL, or mint an invite or
 * access link are refused to an impersonated session in BOTH modes. (tests/console-impersonation.test.ts walks every
 * rule's example through the real app; this pins the review's named routes and the sweep's additions.)
 */
import { describe, expect, it } from "vitest";
import { impersonationBlock } from "@/server/services/console/impersonation";

const ALWAYS: [string, string][] = [
  ["POST", "/api/guests"], ["POST", "/api/guests/gst_1/link"], ["PUT", "/api/forms-plus/forms/f1/settings"],
  ["POST", "/api/forms-plus/forms/f1/webhook/test"], ["PUT", "/api/auth-email-settings"], ["POST", "/api/connectors"],
  ["PATCH", "/api/connectors/con_1"], ["POST", "/api/connectors/con_1/test"], ["PUT", "/api/ai/key"], ["POST", "/api/agent-triggers"],
  ["POST", "/api/connections/test"], ["PUT", "/api/scheduling/page"], ["POST", "/api/booking/polls"], ["POST", "/api/booking/events"],
  // Already on the list before the review, kept: outbound webhooks, incoming hooks, portal links, the calendar feed.
  ["POST", "/api/developer/webhooks"], ["POST", "/api/incoming-hooks"], ["POST", "/api/portals/p/people/x/link"], ["POST", "/api/calendar/feed"],
];

describe("L1: outbound URLs and minted links while impersonating", () => {
  it("each is refused in view and act mode", () => {
    for (const [m, p] of ALWAYS) {
      expect(impersonationBlock("act", m, p), `act ${m} ${p}`).toBe("always");
      expect(impersonationBlock("view", m, p), `view ${m} ${p}`).toBe("always");
    }
  });

  it("nearby reads and ordinary writes stay as they were (act mode allows them)", () => {
    for (const [m, p] of [["GET", "/api/guests"], ["GET", "/api/forms-plus/forms/f1/settings"], ["POST", "/api/connections/live"], ["GET", "/api/scheduling/page"], ["POST", "/api/booking/polls/p1/pick"]] as const) {
      expect(impersonationBlock("act", m, p), `${m} ${p}`).toBeNull();
    }
  });
});
