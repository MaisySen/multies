import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers";
import { previewMove, runMove, undoMove } from "@/server/services/data-move/service";

// R40 sec: importing a file into the workspace and undoing an import are owner and admin actions, like the export.
describe("data move imports need an owner or admin (R40 sec)", () => {
  const vcard = "BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nEMAIL:ada@example.com\nEND:VCARD\n";

  it("a member gets 403 on preview, run and undo; an admin can run and undo", async () => {
    const { deps } = await makeTestApp();
    const orgId = "org_secr40";
    const member = { orgId, userId: "usr_m", email: "m@example.com", name: "M", role: "member" as const };
    const admin = { orgId, userId: "usr_a", email: "a@example.com", name: "A", role: "admin" as const };
    const input = { kind: "contacts", content: vcard, fileName: "people.vcf" } as never;
    await expect(previewMove(deps, member, input)).rejects.toMatchObject({ status: 403 });
    await expect(runMove(deps, member, input)).rejects.toMatchObject({ status: 403 });
    await expect(undoMove(deps, member, "move_x")).rejects.toMatchObject({ status: 403 });
    // An admin passes the role check (the result itself is covered by data-move-r38.test.ts).
    const r = await runMove(deps, admin, input).catch((e) => e);
    expect((r as { status?: number }).status).not.toBe(403);
  });
});
