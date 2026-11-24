/**
 * Round 2 (PR 20 leftover): Tools AI showed a refused or empty AI key only as plain text. Its uploads and file
 * downloads used raw fetch and threw a bare Error, losing the code. They now throw ApiError with the server's code, and
 * the page's problem line links to where the key is fixed, as the translate tools do.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ApiError } from "@/web/lib/api";

describe("Tools AI problem line", () => {
  it("links to the AI key settings for a key problem, and not for anything else", async () => {
    const { Problem } = await import("@/web/pages/app/tools-ai");
    const html = (error: unknown) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Problem, { error })));
    const refused = html(new ApiError(409, "ai_key_refused", "Anthropic refused your workspace's AI key."));
    expect(refused).toContain("Anthropic refused");
    expect(refused).toContain("tools-ai-fix-key");
    expect(refused).toContain("href=\"/app/settings#ai\"");
    expect(html(new ApiError(409, "ai_no_credit", "No credit left."))).toContain("tools-ai-fix-key");
    expect(html(new ApiError(502, "ai_provider_error", "Busy."))).not.toContain("tools-ai-fix-key");
    expect(html(new Error("The file could not be read."))).not.toContain("tools-ai-fix-key");
    expect(html(null)).toBe("");
  });
});
