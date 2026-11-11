/**
 * QUAL1 (audit rows 12 and 14), the web side: a key the provider refused is never a green "Connected" in Settings,
 * never "Ready on your key" in Team AI, and the mail assistant says what is wrong with a link to fix it. Every AI
 * failure in the assistant stays on the page with Retry (it was a toast only, or nothing).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { aiKeyProblemText } from "@/shared/ai-connect-ai2";
import type { TeamAiState } from "@/shared/teamai-td8";

const REFUSED = aiKeyProblemText("key_refused", "Anthropic");
const builtin = { available: true, active: false, paused: false, percent: 0, calls: 0, message: null };
const status = (extra: Record<string, unknown> = {}) => ({
  connected: true, provider: "anthropic", providerName: "Anthropic", model: "claude-haiku-5-5", keyHint: "WXYZ",
  providers: [], ai2: true, cards: [], builtin, mcp: { url: "https://x/api/v1/mcp", docs: "/agents" }, message: "", ...extra,
});

function render(el: ReturnType<typeof createElement>, seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient();
  seed?.(qc);
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client: qc }, el)));
}

describe("Settings, AI: the real state of the saved key (QUAL1)", () => {
  it("a refused key shows a red Key refused badge, the plain sentence and what to do, not Connected", async () => {
    const { AiConnectPanel } = await import("@/web/pages/app/ai-connect-ai2");
    const html = render(createElement(AiConnectPanel, { status: status({ problem: "key_refused", problemAt: "2026-11-11T02:00:00.000Z", problemMessage: REFUSED }) as never, isAdmin: true }));
    expect(html).toContain("Key refused");
    expect(html).toContain("data-testid=\"ai2-key-problem\"");
    expect(html).toContain(REFUSED.replace(/'/g, "&#x27;"));
    expect(html).not.toMatch(/>Connected</);
    // Built-in AI says it is answering in the key's place.
    expect(html).toContain("Answering while your key is refused");
  });

  it("a working key still shows Connected", async () => {
    const { AiConnectPanel } = await import("@/web/pages/app/ai-connect-ai2");
    const html = render(createElement(AiConnectPanel, { status: status() as never, isAdmin: true }));
    expect(html).toMatch(/>Connected</);
    expect(html).not.toContain("ai2-key-problem");
  });
});

describe("Team AI status (QUAL1)", () => {
  const state = (ai: Partial<TeamAiState["ai"]>): TeamAiState => ({
    isAdmin: true, usedToday: 0, caps: { runsPerDay: 50, routinesMax: 10, memoryMax: 50 }, channels: [], forms: [], projects: [],
    ai: { on: true, key: true, provider: "Anthropic", source: "own_key", freeUsed: 0, freeLimit: 50, freePeriod: "day", ...ai },
  } as TeamAiState);

  it("a refused key is never Ready: it says why, that built-in AI answers, and links to the fix", async () => {
    const { AiStatus } = await import("@/web/pages/app/teamai-td8");
    const html = render(createElement(AiStatus, { s: state({ source: "built_in", keyProblem: "key_refused", keyProblemMessage: REFUSED }) }));
    expect(html).toContain("teamai-key-problem");
    expect(html).toContain("built in AI is answering for now");
    expect(html).toContain("href=\"/app/settings#ai\"");
    expect(html).not.toContain("teamai-ready");
  });

  it("with nothing to stand in, it says nothing can run", async () => {
    const { AiStatus } = await import("@/web/pages/app/teamai-td8");
    const html = render(createElement(AiStatus, { s: state({ source: "none", keyProblem: "key_refused", keyProblemMessage: REFUSED }) }));
    expect(html).toContain("nothing can run");
  });

  it("a working key is still Ready on your key", async () => {
    const { AiStatus } = await import("@/web/pages/app/teamai-td8");
    expect(render(createElement(AiStatus, { s: state({}) }))).toContain("teamai-ready");
  });
});

describe("the mail assistant (QUAL1, row 12)", () => {
  it("shows the refused key with a link to fix it instead of 'On your Anthropic key'", async () => {
    const { Assistant } = await import("@/web/pages/app/webmail");
    const html = render(createElement(Assistant, { messageId: "msg_1", onDraft: () => {} }), (qc) => qc.setQueryData(["ai-status"], status({ problem: "key_refused", problemMessage: REFUSED })));
    expect(html).toContain("mail-ai-key-problem");
    expect(html).toContain("href=\"/app/settings#ai\"");
    expect(html).not.toContain("On your Anthropic key");
    // The three buttons are there (each shows a spinner while it works).
    for (const label of ["Summarise", "Draft a reply", "Sort it"]) expect(html).toContain(label);
  });

  it("a working key keeps the quiet 'On your key' line", async () => {
    const { Assistant } = await import("@/web/pages/app/webmail");
    const html = render(createElement(Assistant, { messageId: "msg_1", onDraft: () => {} }), (qc) => qc.setQueryData(["ai-status"], status()));
    expect(html).toContain("On your Anthropic key");
    expect(html).not.toContain("mail-ai-key-problem");
  });

  it("every failure of Summarise, Draft a reply and Sort it stays on the page with Retry, not only a toast", () => {
    const src = readFileSync(join(process.cwd(), "src/web/pages/app/webmail.tsx"), "utf8");
    const body = src.slice(src.indexOf("export function Assistant("), src.indexOf("function ThreadMessage("));
    expect(body).toContain("data-testid=\"mail-ai-retry\"");
    expect(body).toContain("failed.mutate()");
    expect(body).not.toMatch(/onError: \(e\) => showError\(e\)/);
    // The answer from built-in AI says so.
    expect(body).toContain("data-testid=\"mail-ai-fallback\"");
  });
});
