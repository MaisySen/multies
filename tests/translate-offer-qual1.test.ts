/**
 * QUAL1 (audit row 29): Translate offered "Translate to English" on mail that was already in English. The mail
 * toolbar now leaves that button out for mail already in the reader's language; the language list stays and picking
 * another language there translates at once.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { detectLanguage, translateOffer } from "@/shared/translate-r116";

const ENGLISH = "Hi Maria, thanks for your note. Can we move the team this week? Please let me know what you need from us.";
const NEPALI = "नमस्ते, तपाईंलाई कस्तो छ? हामी यो हप्ता टोली सार्न सक्छौं? कृपया हामीलाई के चाहिन्छ भन्नुहोस्।";

describe("which Translate the mail toolbar offers (QUAL1, row 29)", () => {
  it("mail already in the reader's language gets no Translate button, and picking another language translates", () => {
    expect(detectLanguage(ENGLISH)).toBe("en");
    expect(translateOffer("en", "en", false)).toEqual({ button: false, note: false, pickTranslates: true });
  });

  it("mail in another language gets the button and the 'This looks like' note", () => {
    expect(detectLanguage(NEPALI)).toBe("ne");
    expect(translateOffer("ne", "en", false)).toEqual({ button: true, note: true, pickTranslates: false });
  });

  it("a language the check can't name keeps the button (nothing is hidden on a guess), and a translation keeps Translate again", () => {
    expect(translateOffer(null, "en", false)).toMatchObject({ button: true, note: false });
    expect(translateOffer("en", "en", true)).toMatchObject({ button: true });
  });

  it("the mail pane renders no 'Translate to English' for English mail, and keeps it for Nepali mail", async () => {
    const { MailBodyR116 } = await import("@/web/components/lang-tools-r116");
    const render = (text: string) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MailBodyR116, { id: "msg_1", text }))));
    const en = render(ENGLISH);
    expect(en).not.toContain("data-testid=\"translate-mail\"");
    expect(en).not.toContain("Translate to English");
    expect(en).toContain("Translate into");
    const ne = render(NEPALI);
    expect(ne).toContain("data-testid=\"translate-mail\"");
    expect(ne).toContain("Translate to English");
  });
});
