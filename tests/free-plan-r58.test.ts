import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * R58 (MB-237): every number on the public free plan page comes from src/shared/plans.ts.
 * The plan is mocked with different limits; the page must show the mocked numbers and none of the real ones.
 */
vi.mock("@/shared/plans", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/shared/plans")>();
  const starter = { ...real.PLANS.starter, limits: { ...real.PLANS.starter.limits, domains: 2, mailboxes: 11, seats: 7, dailySends: 123, storageMb: 5 * 1024, agentInboxes: 4, agentMessagesMonthly: 4321, automationRunsMonthly: 2222 } };
  const mailboxes = { ...real.ADDONS.mailboxes, priceMonthly: 9, unit: "6 mailboxes", grants: { mailboxes: 6, seats: 6, aliases: 50 } };
  return { ...real, PLANS: { ...real.PLANS, starter }, ADDONS: { ...real.ADDONS, mailboxes } };
});

const render = async () => {
  const { StartupsPage } = await import("../src/web/pages/startups");
  const qc = new QueryClient();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(StartupsPage))));
};

describe("free plan page numbers (R58 MB-237)", () => {
  it("shows the limits from plans.ts, not typed numbers", async () => {
    const html = (await render()).replace(/<!-- -->/g, "");
    expect(html).toContain("2 domains, 11 mailboxes and 7 people, free for good.");
    for (const v of ["7 people", "11 mailboxes", "123 a day", "5 GB", "4 agent inboxes", "4,321 agent messages a month", "2,222 a month"]) expect(html, v).toContain(v);
    expect(html).toContain("Past 7 people, a mailbox pack adds 6 mailboxes and 6 more people for A$9 a month.");
    expect(html).toContain("6 more come with each mailbox pack");
    // The real Free numbers must not appear anywhere: they would mean a number was typed by hand.
    for (const v of ["3 people", "3 mailboxes", "100 a day", "3 GB", "3 agent inboxes", "1,000 a month", "3,000 agent messages"]) expect(html, v).not.toContain(v);
  });

  it("free plan facts match the real plan", async () => {
    const real = await vi.importActual<typeof import("../src/shared/plans")>("../src/shared/plans");
    const { freeLimits, freeHeadline } = await import("../src/shared/free-plan");
    const l = real.PLANS.starter.limits;
    expect(l.seats).toBe(3); // the owner's decision (MB-44): Free stays at 3 seats
    const byKey = Object.fromEntries(freeLimits(real.PLANS.starter, real.ADDONS).map((x) => [x.key, x.value]));
    expect(byKey).toEqual({
      domains: `${l.domains} domain`, mailboxes: `${l.mailboxes} mailboxes`, seats: `${l.seats} people`, dailySends: `${l.dailySends} a day`,
      storage: `${l.storageMb / 1024} GB`, agentInboxes: `${l.agentInboxes} agent inboxes`, automation: `${l.automationRunsMonthly.toLocaleString("en-AU")} a month`,
    });
    expect(freeHeadline(real.PLANS.starter)).toBe("1 domain, 3 mailboxes and 3 people, free for good.");
  });
});
