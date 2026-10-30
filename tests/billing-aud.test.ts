import { describe, expect, it } from "vitest";
import { formatCents, formatMoney, localizeStripeText } from "@/shared/money";
import { formatPlanPrice } from "@/shared/plans";

describe("billing money (A$)", () => {
  it("formats AUD as A$ with cents from Stripe and whole dollars for plan prices", () => {
    expect(formatCents(350, "aud")).toBe("A$3.50");
    expect(formatCents(4650, "AUD")).toBe("A$46.50");
    expect(formatCents(-210, "aud")).toBe("-A$2.10");
    expect(formatCents(0, "aud")).toBe("A$0.00");
    expect(formatCents(null, undefined)).toBe("A$0.00");
    expect(formatCents(123456, "aud")).toBe("A$1,234.56");
    expect(formatPlanPrice(3)).toBe("A$3");
    expect(formatPlanPrice(1.5)).toBe("A$1.50");
    expect(formatMoney(3, "aud", { cents: "always" })).toBe("A$3.00");
  });

  it("shows another currency's own code", () => {
    expect(formatCents(350, "usd")).toBe("USD 3.50");
    expect(formatCents(1000, "jpy")).toBe("JPY 1,000");
    expect(formatCents(-99, "nzd")).toBe("-NZD 0.99");
  });

  it("localises the bare $ in Stripe's line text and leaves prefixed amounts alone", () => {
    expect(localizeStripeText("1 \u00d7 Multies Mailbox pack (at $3.00 / month)", "aud")).toBe("1 \u00d7 Multies Mailbox pack (at A$3.00 / month)");
    expect(localizeStripeText("$5 then A$3 and US$4", "aud")).toBe("A$5 then A$3 and US$4");
    expect(localizeStripeText("at $3.00 / month", "usd")).toBe("at USD 3.00 / month");
    expect(localizeStripeText("Unused time after 30 Oct 2026", "aud")).toBe("Unused time after 30 Oct 2026");
  });
});
