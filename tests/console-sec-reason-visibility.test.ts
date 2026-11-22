/**
 * OPS1 security review (info item): an operator's reason on a workspace action lands in that workspace's own activity
 * log, which its admins read. Every reason dialog says so (the generic line, one for all dialogs).
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasonDialog, REASON_VISIBILITY } from "../src/web/pages/console/components/reason-dialog";

const render = (reasonHint?: string) => renderToStaticMarkup(createElement(ReasonDialog, {
  open: true, onClose: () => undefined, onSubmit: () => undefined, title: "Suspend Acme?", reasonHint,
}));

describe("reason dialog: who can see the reason", () => {
  it("says it under the reason field, with or without a custom hint", () => {
    expect(REASON_VISIBILITY).toBe("Reasons are recorded. For actions on a workspace, its admins can see the reason.");
    const plain = render();
    expect(plain).toContain(REASON_VISIBILITY);
    const custom = render("Shown to the customer in their invoice.");
    expect(custom).toContain("Shown to the customer in their invoice.");
    expect(custom).toContain(REASON_VISIBILITY);
  });
});
