/**
 * MPLAT-110 (Sentry MYMAIL-WEB-18): Settings, Apps, Mail crashed for owners and admins once PRIV1b (P46) started
 * sending them a reduced row for a personal connected mailbox they can't open. The page read counts and settings
 * from every row ("Cannot read properties of undefined (reading 'toLocaleString')"). A reduced row is now a short read
 * only row, and every screen that lists connections skips or handles it.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isFullConnection, type ConnectionListItem, type ConnectionView } from "@/shared/mail-connect";

const full: ConnectionView & { openable: true } = {
  id: "con_full", mailboxId: "mbx_full", email: "me@gmail.com", displayName: "Me", provider: "gmail", providerLabel: "Gmail",
  authKind: "password", status: "active", lastError: null, lastSyncAt: "2026-11-12T10:00:00.000Z", initialDone: true,
  messagesSynced: 1234, imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com", createdAt: "2026-11-01T00:00:00.000Z",
  backfill: { done: false, counted: true, synced: 10, total: 100, paused: false, wait: null }, openable: true,
};
const reduced: ConnectionListItem = { id: "con_pat", mailboxId: "mbx_pat", email: "pat.private@gmail.com", status: "active", openable: false };

function render(el: ReturnType<typeof createElement>, connections: ConnectionListItem[]) {
  const qc = new QueryClient();
  qc.setQueryData(["connections"], { enabled: true, oauth: [], connections });
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/app/settings/apps/mail"] }, createElement(QueryClientProvider, { client: qc }, el)));
}

describe("MPLAT-110: connections list with reduced rows", () => {
  it("isFullConnection: reduced rows are not full; rows from an older server (no openable) are full", () => {
    expect(isFullConnection(full)).toBe(true);
    expect(isFullConnection(reduced)).toBe(false);
    const { openable: _drop, ...older } = full;
    expect(isFullConnection(older)).toBe(true);
  });

  it("the Mail accounts page renders a reduced row read only, next to a full row, without crashing", async () => {
    const { ConnectionsSettings } = await import("@/web/pages/app/connections");
    const html = render(createElement(ConnectionsSettings), [full, reduced]);
    expect(html).toContain("data-testid=\"connection-row-limited\"");
    expect(html).toContain("pat.private@gmail.com");
    expect(html).toContain("Personal mailbox, owner only");
    // The full row is still the full row, with its count and actions.
    expect(html).toContain("me@gmail.com");
    expect(html).toContain("1,234 messages");
    expect(html).toContain("Sync now me@gmail.com");
    // No actions for the reduced row.
    expect(html).not.toContain("Sync now pat.private@gmail.com");
    expect(html).not.toContain("Remove pat.private@gmail.com");
    expect(html).not.toContain("mailbox=mbx_pat");
  });

  it("a page with only reduced rows renders too", async () => {
    const { ConnectionsSettings } = await import("@/web/pages/app/connections");
    const html = render(createElement(ConnectionsSettings), [reduced, { ...reduced, id: "con_x", email: "x@y.io", status: "auth_failed" }]);
    expect(html.match(/connection-row-limited/g)).toHaveLength(2);
    expect(html).toContain("Needs reconnect");
  });

  it("the sync banner at the top of Mail skips reduced rows", async () => {
    const { MailSyncBanner } = await import("@/web/components/mail-sync-progress");
    expect(() => render(createElement(MailSyncBanner), [reduced])).not.toThrow();
    expect(render(createElement(MailSyncBanner), [reduced])).toBe("");
    expect(render(createElement(MailSyncBanner), [reduced, full])).toContain("mail-sync-banner");
  });

  it("num() shows a missing count as 0 instead of throwing", async () => {
    const { num } = await import("@/web/lib/format");
    expect(() => num(undefined as unknown as number)).not.toThrow();
    expect(num(undefined as unknown as number)).toBe("0");
  });
});
