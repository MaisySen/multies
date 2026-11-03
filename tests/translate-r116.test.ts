import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { TRANSLATE_LANGUAGES } from "@/server/services/tools/ai-meter";
import { clearTranslateCache } from "@/server/services/translate-r116";
import { fakeAskAi } from "@/server/services/ask-fake";
import { messageActions } from "@/web/lib/message-actions";
import {
  R116_LANGUAGES, R116_LIMITS, batches, pickVoice, speechChunks, decodeEntities, detectLanguage, htmlPieces, joinHtml, joinPieces, readPrefs, splitLong, textPieces, uniqueTexts,
} from "@/shared/translate-r116";

/** R116 translate and read aloud: language guess, chunking, HTML text nodes only, the AI switch, meter, limits, cache. */

describe("pure rules", () => {
  it("offers exactly the languages the built in translation supports", () => {
    expect(R116_LANGUAGES).toEqual(TRANSLATE_LANGUAGES);
    expect(Object.keys(R116_LANGUAGES)).toEqual(expect.arrayContaining(["en", "ne", "hi"]));
  });

  it("guesses the language of a text", () => {
    expect(detectLanguage("Hi team, please send the invoice for this week and the report.")).toBe("en");
    expect(detectLanguage("२ कक्षाको हाजिरी अझै बाँकी छ। अहिलेसम्म कोही अनुपस्थित छैन।")).toBe("ne");
    expect(detectLanguage("यह रिपोर्ट आज भेजनी है और बिल भी भेजें, नहीं तो देर होगी।")).toBe("hi");
    expect(detectLanguage("今日の会議は三時からです。よろしくお願いします。")).toBe("ja");
    expect(detectLanguage("会议在三点开始")).toBe("zh");
    expect(detectLanguage("Hola, gracias por la factura de la semana, es para usted.")).toBe("es");
    expect(detectLanguage("Bonjour, merci pour la facture, nous avons besoin de vous.")).toBe("fr");
    expect(detectLanguage("안녕하세요 회의는 세 시입니다")).toBe("ko");
    expect(detectLanguage("12 34 https://x.example")).toBeNull();
  });

  it("splits long text at sentences and keeps line breaks", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const parts = splitLong(long, 200);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join("")).toBe(long);
    expect(parts[0].trimEnd().endsWith(".")).toBe(true);
    const pieces = textPieces("Hello there\n\nSecond line here\n42\n");
    expect(pieces.map((p) => p.s).join("")).toBe("Hello there\n\nSecond line here\n42\n");
    expect(uniqueTexts(pieces)).toEqual(["Hello there", "Second line here"]);
    const map = new Map([["Hello there", "Namaste"], ["Second line here", "Dosro line"]]);
    expect(joinPieces(pieces, map)).toBe("Namaste\n\nDosro line\n42\n");
    const hard = splitLong("x".repeat(500), 200);
    expect(hard.map((p) => p.length)).toEqual([200, 200, 100]);
  });

  it("groups strings into calls under the per call caps", () => {
    const texts = Array.from({ length: 100 }, () => "y".repeat(500));
    const groups = batches(texts);
    expect(groups.flat()).toHaveLength(100);
    for (const g of groups) {
      expect(g.length).toBeLessThanOrEqual(R116_LIMITS.batchTexts);
      expect(g.reduce((n, i) => n + texts[i].length, 0)).toBeLessThanOrEqual(R116_LIMITS.batchChars);
    }
    expect(R116_LIMITS.batchChars).toBeLessThanOrEqual(R116_LIMITS.callChars);
  });

  it("translates HTML text nodes only, keeps every tag, and never lets a translation become markup", () => {
    const html = '<p class="a">Hello <b>team</b>, the bill is &lt;due&gt; &amp; paid.</p><pre>keep this code</pre><style>p{color:red}</style><a href="https://x.example/?a=1&amp;b=2" title="a > b">Open link</a><!-- note -->';
    const pieces = htmlPieces(html);
    const texts = uniqueTexts(pieces);
    expect(texts).toEqual(["Hello", "team", ", the bill is <due> & paid.", "Open link"]);
    expect(texts.join(" ")).not.toContain("keep this code");
    expect(texts.join(" ")).not.toContain("color");
    const evil = new Map(texts.map((t) => [t, t === "team" ? '<img src=x onerror="alert(1)">' : `[ne] ${t}`]));
    const out = joinHtml(pieces, evil);
    expect(out).toContain('<p class="a">[ne] Hello <b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</b>');
    expect(out).toContain("[ne] , the bill is &lt;due&gt; &amp; paid.</p>");
    expect(out).toContain("<pre>keep this code</pre><style>p{color:red}</style>");
    expect(out).toContain('<a href="https://x.example/?a=1&amp;b=2" title="a > b">[ne] Open link</a><!-- note -->');
    expect(out).not.toMatch(/<img/);
    // Nothing translated: the same HTML comes back (text re-escaped, tags untouched).
    expect(joinHtml(pieces, new Map())).toBe(html);
  });

  it("decodes character references and reads preferences safely", () => {
    expect(decodeEntities("a&nbsp;b &#8217; &#x41; &bogus;")).toBe("a\u00a0b \u2019 A &bogus;");
    expect(readPrefs(null, "ne")).toEqual({ target: "ne", autoOffer: true });
    expect(readPrefs('{"target":"hi","autoOffer":false}')).toEqual({ target: "hi", autoOffer: false });
    expect(readPrefs('{"target":"xx"}')).toEqual({ target: "en", autoOffer: true });
    expect(readPrefs("not json")).toEqual({ target: "en", autoOffer: true });
  });

  it("reads aloud in parts and picks a voice of the text's language", () => {
    const parts = speechChunks("First line here.\n\n" + "Word ".repeat(120));
    expect(parts[0]).toBe("First line here.");
    expect(parts.every((p) => p.length <= 220)).toBe(true);
    const voices = [{ lang: "en-US", name: "US" }, { lang: "en_AU", name: "AU", localService: true }, { lang: "hi-IN", name: "Hindi" }, { lang: "fr-CA", name: "CA" }];
    expect(pickVoice(voices, "en").voice?.name).toBe("AU");
    expect(pickVoice(voices, "fr").voice?.name).toBe("CA");
    expect(pickVoice(voices, "ne")).toEqual({ voice: voices[2], fallback: "hi" });
    expect(pickVoice(voices, "ja")).toEqual({ voice: null, fallback: null });
  });

  it("puts Translate and Read aloud in the phone sheet only when on and the message has text", () => {
    const base = { deleted: false, inThread: false, mine: false, canPin: false, isReply: false, pinned: false, canTriage: false, hasText: true };
    expect(messageActions(base).map((a) => a.id)).not.toContain("translate");
    const on = messageActions({ ...base, lang: true }).map((a) => a.id);
    expect(on).toEqual(expect.arrayContaining(["translate", "read"]));
    expect(messageActions({ ...base, lang: true, hasText: false }).map((a) => a.id)).not.toContain("read");
  });

  it("the end to end stand in answers translation deterministically", async () => {
    const r = (await fakeAskAi.run("m", { messages: [{ role: "system", content: "You are a careful professional translator. Translate each string of the JSON array the user sends into Nepali" }, { role: "user", content: '["Hi"]' }] })) as { response: string };
    expect(JSON.parse(r.response)).toEqual(["[Nepali] Hi"]);
  });
});

describe("POST /api/translate", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  let orgId: string;
  let calls: { model: string; input: unknown }[];
  async function setup(env: Record<string, string>) {
    clearTranslateCache();
    ctx = await makeTestApp(env);
    calls = [];
    ctx.deps.ai = {
      async run(model: string, input: unknown) {
        calls.push({ model, input });
        const msgs = (input as { messages?: { role: string; content: string }[] }).messages;
        if (msgs) {
          const arr = JSON.parse(msgs.find((m) => m.role === "user")!.content) as string[];
          return { response: JSON.stringify(arr.map((s) => `NE ${s}`)), usage: { prompt_tokens: 100, completion_tokens: 50 } };
        }
        return { translated_text: "NE" };
      },
    } as never;
    c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    orgId = (await c.get("/api/account/me")).body.organization.id;
  }
  const units = async () => Number((await ctx.db.all<{ u: number }>(sql`select coalesce(sum(units), 0) as u from ai_usage_daily where org_id = ${orgId}`))[0]?.u ?? 0);

  describe("flag off", () => {
    beforeEach(() => setup({}));
    it("is no such endpoint and the config says off", async () => {
      const r = await c.post("/api/translate", { texts: ["Hello"], target: "ne" });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("not_found");
      expect((await c.get("/api/config")).body.translateR116).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe("flag on", () => {
    beforeEach(() => setup({ TRANSLATE_R116: "on", ASK_TD1: "on" }));

    it("needs a signed in person", async () => {
      const anon = new Client(ctx.app);
      expect((await anon.post("/api/translate", { texts: ["Hello"], target: "ne" })).status).toBe(401);
    });

    it("translates through the built in AI on the single meter, then serves the same text from the cache", async () => {
      expect((await c.get("/api/config")).body.translateR116).toBe(true);
      const before = await units();
      const r = await c.post("/api/translate", { texts: ["Please send the invoice today.", "Thanks"], target: "ne" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ texts: ["NE Please send the invoice today.", "NE Thanks"], source: "en", target: "ne", cached: false });
      expect(calls.length).toBeGreaterThan(0);
      expect(await units()).toBeGreaterThan(before); // the one shared meter (ai_usage_daily) counted it
      const n = calls.length, u = await units();
      const again = await c.post("/api/translate", { texts: ["Please send the invoice today.", "Thanks"], target: "ne" });
      expect(again.body.cached).toBe(true);
      expect(calls.length).toBe(n);
      expect(await units()).toBe(u);
    });

    it("AI switch OFF: a plain message and zero provider calls, cache or not", async () => {
      expect((await c.post("/api/translate", { texts: ["Cached before the switch"], target: "hi" })).status).toBe(200);
      calls.length = 0;
      expect((await c.put("/api/ai-trust", { enabled: false })).status).toBe(200);
      for (const texts of [["Cached before the switch"], ["Something new"]]) {
        const r = await c.post("/api/translate", { texts, target: "hi" });
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe("ai_off");
        expect(r.body.error.message).toMatch(/AI is off/i);
      }
      expect(calls).toHaveLength(0);
    });

    it("same language needs no AI", async () => {
      const r = await c.post("/api/translate", { texts: ["२ कक्षाको हाजिरी अझै बाँकी छ।"], target: "ne" });
      expect(r.body).toMatchObject({ same: true, source: "ne" });
      expect(calls).toHaveLength(0);
    });

    it("caps the size of a call and checks the language", async () => {
      expect((await c.post("/api/translate", { texts: ["x".repeat(2_500), "y".repeat(2_000)], target: "ne" })).status).toBe(413);
      expect((await c.post("/api/translate", { texts: Array.from({ length: 61 }, () => "hi there"), target: "ne" })).status).toBe(413);
      expect((await c.post("/api/translate", { texts: ["Hello"], target: "xx" })).status).toBe(400);
      expect((await c.post("/api/translate", { texts: ["   "], target: "ne" })).status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("limits each person per minute", async () => {
      let last = 0;
      for (let i = 0; i <= R116_LIMITS.perMinute; i++) last = (await c.post("/api/translate", { texts: [`Message number ${i} for you`], target: "ne" })).status;
      expect(last).toBe(429);
    });

    it("says plainly when today's free AI is used up", async () => {
      const day = ctx.deps.now().toISOString().slice(0, 10);
      await ctx.db.run(sql`insert into ai_usage_daily (day, org_id, units, calls) values (${day}, ${orgId}, 100000, 1) on conflict do update set units = 100000`);
      const r = await c.post("/api/translate", { texts: ["A brand new message to translate"], target: "ne" });
      expect(r.status).toBe(429);
      expect(r.body.error.message).toMatch(/free AI limit/);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("R116 FEATURES list (production text binding limit)", () => {
  it("a switch is on by its own var or by its name in FEATURES", async () => {
    const { flagOn } = await import("../src/server/config");
    expect(flagOn(undefined, "TRANSLATE_R116", undefined)).toBe(false);
    expect(flagOn("on", "TRANSLATE_R116", undefined)).toBe(true);
    expect(flagOn(undefined, "TRANSLATE_R116", "VIDEO_REC_VID2, TRANSLATE_R116")).toBe(true);
    expect(flagOn(undefined, "TRANSLATE_R116", "VIDEO_REC_VID2")).toBe(false);
    expect(flagOn("off", "VIDEO_REC_VID2", "")).toBe(false);
  });
  it("production keeps VID2 and R116 on through FEATURES and stays within 85 vars", () => {
    const toml = readFileSync("wrangler.toml", "utf8");
    const prod = toml.slice(toml.indexOf("\n[vars]"), toml.indexOf("\n[", toml.indexOf("\n[vars]") + 3));
    // POL4: later rounds add their own names to the same list (R104 added LANG_R104), so check membership, not the whole value.
    const features = (prod.match(/^FEATURES = "([^"]*)"/m)?.[1] ?? "").split(",").map((s) => s.trim());
    expect(features).toEqual(expect.arrayContaining(["VIDEO_REC_VID2", "TRANSLATE_R116"]));
    expect(prod).not.toMatch(/^(VIDEO_REC_VID2|TRANSLATE_R116|LANG_R104) =/m);
    expect(prod.split("\n").filter((l) => /^[A-Z0-9_]+\s*=/.test(l)).length).toBeLessThanOrEqual(85);
  });
});
