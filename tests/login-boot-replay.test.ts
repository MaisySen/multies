/**
 * public/login-boot.js (R35) keeps a tap made on the prerendered sign in card and replays it on the live control once
 * React has drawn the page. Under load (e2e page-history-r39, suite-r7, ui-r45-board, social-login-r25) the tap was
 * lost: the replay looked once, 50 ms after the marker came off, and React had not drawn the button yet; a tap on the
 * "Other ways to sign up" fold was never kept at all, and a replay could press the drawn button again (it stays in the
 * page until React's first commit). Now it keeps buttons and summaries, skips the drawn card, and looks again for up to
 * 5 s.
 * The script runs here in a small stand in for the page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  parent: El | null = null;
  clicks = 0;
  constructor(public tagName: string, public textContent = "") {}
  getAttribute(n: string) { return this.attrs.get(n) ?? null; }
  hasAttribute(n: string) { return this.attrs.has(n); }
  setAttribute(n: string, v: string) { this.attrs.set(n, v); }
  removeAttribute(n: string) { this.attrs.delete(n); }
  append(...els: El[]) { for (const e of els) { e.parent = this; this.children.push(e); } }
  get firstElementChild() { return this.children[0] ?? null; }
  contains(e: El | null): boolean { for (let p = e; p; p = p.parent) if (p === this) return true; return false; }
  closest(sel: string): El | null { const tags = sel.split(",").map((x) => x.trim().toUpperCase()); return tags.includes(this.tagName) ? this : this.parent?.closest(sel) ?? null; }
  querySelectorAll(sel: string): El[] { const tag = sel.toUpperCase(); const out: El[] = []; const walk = (e: El) => { for (const c of e.children) { if (c.tagName === tag) out.push(c); walk(c); } }; walk(this); return out; }
  click() { this.clicks++; }
}

function page() {
  const root = new El("DIV");
  root.setAttribute("id", "root");
  root.setAttribute("data-prerendered", "auth");
  const script = new El("SCRIPT");
  script.setAttribute("data-entry", "/assets/index.js");
  const listeners: ((e: { target: El; preventDefault(): void; stopPropagation(): void }) => void)[] = [];
  const observers: (() => void)[] = [];
  const document = {
    currentScript: script,
    getElementById: (id: string) => (id === "root" ? root : null),
    addEventListener: (_t: string, f: (typeof listeners)[number]) => listeners.push(f),
    createElement: (t: string) => new El(t.toUpperCase()),
    head: { appendChild: () => undefined },
  };
  class MutationObserver { constructor(private f: () => void) {} observe() { observers.push(this.f); } disconnect() { /* one shot here */ } }
  vm.runInNewContext(readFileSync("public/login-boot.js", "utf8"), { document, MutationObserver, setTimeout, requestAnimationFrame: undefined });
  const tap = (el: El) => { for (const f of listeners) f({ target: el, preventDefault() {}, stopPropagation() {} }); };
  const takeOver = () => { root.removeAttribute("data-prerendered"); for (const f of observers) f(); };
  return { root, tap, takeOver };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("login-boot: a tap on the drawn card is replayed on the live page", () => {
  it("replays on a button React draws well after the marker came off", async () => {
    const p = page();
    const drawn = new El("BUTTON", "Explore a demo workspace");
    p.root.append(drawn);
    p.tap(drawn);
    expect(drawn.getAttribute("aria-busy")).toBe("true");
    p.takeOver();
    p.root.children = [];
    await wait(400); // React has not drawn the page yet
    const live = new El("BUTTON", "Explore a demo workspace");
    p.root.append(live);
    await wait(150);
    expect(live.clicks).toBe(1);
  });

  it("never presses the drawn button again while React has not replaced the card yet", async () => {
    const p = page();
    const card = new El("DIV");
    const drawn = new El("BUTTON", "Explore a demo workspace");
    card.append(drawn);
    p.root.append(card);
    p.tap(drawn);
    p.takeOver(); // the marker is off, the drawn card is still there for a while
    await wait(300);
    expect(drawn.clicks).toBe(0);
    p.root.children = [];
    const live = new El("BUTTON", "Explore a demo workspace");
    p.root.append(live);
    await wait(150);
    expect(live.clicks).toBe(1);
    expect(drawn.clicks).toBe(0);
  });

  it("keeps a tap on a fold's summary and opens the live fold", async () => {
    const p = page();
    const details = new El("DETAILS");
    const summary = new El("SUMMARY", "Other ways to sign up");
    details.append(summary);
    p.root.append(details);
    p.tap(summary);
    p.takeOver();
    p.root.children = [];
    const liveDetails = new El("DETAILS");
    const liveSummary = new El("SUMMARY", "Other ways to sign up");
    liveDetails.append(liveSummary);
    p.root.append(liveDetails);
    await wait(150);
    expect(liveSummary.clicks).toBe(1);
  });
});
