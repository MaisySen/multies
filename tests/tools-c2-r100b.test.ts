import { describe, expect, it } from "vitest";
import { canonicalImageQuery, DEFAULT_IMAGE_PARAMS, engineImageOptions, ImageParamError, imageLink, parseImageParams, readImageAddress } from "../src/shared/image-links";
import { assertPublicHost, checkUrlShape, isPrivateAddress, safeFetch, UnsafeUrlError } from "../src/server/lib/safe-fetch";
import { decodeEntities, fetchLinkPreview, fetchPreviewImage, imageTypeOf, parsePreview } from "../src/server/services/tools/link-preview-r100b";
import { imageCacheKey, MinuteCap } from "../src/server/services/tools/image-links-r100b";
import { SLIDE_PAIRS, planRoutes, routeTo } from "../src/shared/convert-routes";
import { toolDef } from "../src/shared/tools";

const q = (s: string) => new URLSearchParams(s);

describe("R100b image link params", () => {
  it("reads, caps and writes params in one order", () => {
    const p = parseImageParams(q("fmt=webp&h=200&w=300&fit=cover&crop=smart&q=70"));
    expect(p).toMatchObject({ w: 300, h: 200, fit: "cover", crop: "smart", fmt: "webp", q: 70, area: null });
    expect(canonicalImageQuery(p)).toBe("w=300&h=200&fit=cover&crop=smart&fmt=webp&q=70");
    expect(canonicalImageQuery(parseImageParams(q("crop=smart&w=10")))).toBe("w=10"); // crop only matters for cover
    expect(canonicalImageQuery(parseImageParams(q("fmt=png&q=50")))).toBe("fmt=png"); // quality is not a PNG setting
    expect(canonicalImageQuery(DEFAULT_IMAGE_PARAMS)).toBe("");
    expect(parseImageParams(q("area=1,2,30,40")).area).toEqual([1, 2, 30, 40]);
  });
  it("refuses bad, unknown and oversized params with plain words", () => {
    for (const bad of ["w=5000", "w=-1", "w=1.5", "h=abc", "fit=zoom", "crop=face", "fmt=gif", "q=10", "q=99", "area=1,2,3", "area=0,0,0,5", "x=1", "w=100&fit=cover"]) {
      expect(() => parseImageParams(q(bad)), bad).toThrow(ImageParamError);
    }
    expect(() => parseImageParams(q("w=100&fit=cover"))).toThrow(/both a width and a height/);
  });
  it("builds links and engine options, and reads pasted addresses", () => {
    const p = parseImageParams(q("w=64&h=64&fit=cover&crop=smart&fmt=webp"));
    expect(imageLink("file", "att_1", p)).toBe("/api/img/file/att_1?w=64&h=64&fit=cover&crop=smart&fmt=webp");
    expect(engineImageOptions(p)).toEqual({ w: "64", h: "64", fit: "cover", gravity: "smart", format: "webp", quality: "82" });
    expect(readImageAddress("https://multies.si/api/doc-images/dim123")).toMatchObject({ source: "doc", id: "dim123" });
    expect(readImageAddress("/api/mail/attachments/abc-9")).toMatchObject({ source: "file", id: "abc-9" });
    expect(readImageAddress("/api/img/file/x1?w=50")?.params.w).toBe(50);
    expect(readImageAddress("https://evil.example/x.png")).toBeNull();
    expect(readImageAddress("/api/img/doc/../../etc")).toBeNull();
  });
  it("keeps cache keys inside one workspace, and per person for mail files", () => {
    const p = parseImageParams(q("w=10"));
    const a = imageCacheKey("doc", "d1", p, { orgId: "o1", userId: "u1", role: "member" });
    expect(a).toContain("/o1/doc/d1?w=10");
    expect(imageCacheKey("doc", "d1", p, { orgId: "o2", userId: "u1", role: "member" })).not.toBe(a);
    expect(imageCacheKey("file", "f1", p, { orgId: "o1", userId: "u1", role: "member" })).not.toBe(imageCacheKey("file", "f1", p, { orgId: "o1", userId: "u2", role: "member" }));
  });
  it("caps requests per person per minute", () => {
    const cap = new MinuteCap(2);
    expect([cap.take("a", 0), cap.take("a", 1), cap.take("a", 2), cap.take("b", 2), cap.take("a", 60_001)]).toEqual([true, true, false, true, true]);
  });
});

describe("R100b SSRF guard", () => {
  it("knows private and public addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1", "[::1]", "2001:db8::1", "198.18.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it("refuses unsafe URL shapes before any network", () => {
    for (const u of ["ftp://x.org", "file:///etc/passwd", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest", "http://localhost:80/", "http://printer.local/", "http://intranet/",
      "http://2130706433/", "http://0x7f.0x0.0x0.0x1/", "https://a:b@site.org/", "https://site.org:8443/", "javascript:alert(1)", "not a url"]) expect(() => checkUrlShape(u), u).toThrow(UnsafeUrlError);
    expect(checkUrlShape("https://example.org/a").hostname).toBe("example.org");
    expect(checkUrlShape("http://93.184.216.34/").hostname).toBe("93.184.216.34");
  });
  it("refuses names that resolve to private addresses, and failed lookups", async () => {
    const dns = (answers: Record<string, string[]>) => (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      const name = u.searchParams.get("name")!, type = u.searchParams.get("type")!;
      const data = (answers[`${name}/${type}`] ?? []).map((d) => ({ type: type === "A" ? 1 : 28, data: d }));
      return Response.json({ Answer: data });
    }) as typeof fetch;
    await expect(assertPublicHost(dns({ "evil.org/A": ["10.0.0.5"] }), "evil.org")).rejects.toThrow(/private networks/);
    await expect(assertPublicHost(dns({ "mixed.org/A": ["1.2.3.4"], "mixed.org/AAAA": ["::1"] }), "mixed.org")).rejects.toThrow(/private/);
    await expect(assertPublicHost(dns({}), "nothing.org")).rejects.toThrow(/could not be found/);
    await expect(assertPublicHost(dns({ "ok.org/A": ["93.184.216.34"] }), "ok.org")).resolves.toBeUndefined();
    await expect(assertPublicHost((async () => { throw new Error("down"); }) as typeof fetch, "x.org")).rejects.toThrow(/could not be reached/);
  });
});

/** A small web: DNS answers plus pages, with redirects. */
function web(pages: Record<string, { status?: number; headers?: Record<string, string>; body?: string | Uint8Array }>, dnsMap: Record<string, string> = {}) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.hostname === "cloudflare-dns.com") {
      const name = u.searchParams.get("name")!, type = u.searchParams.get("type");
      const ip = dnsMap[name] ?? "93.184.216.34";
      return Response.json({ Answer: type === "A" ? [{ type: 1, data: ip }] : [] });
    }
    calls.push(`${u.toString()} ${init?.redirect ?? ""}`);
    const pg = pages[u.toString()];
    if (!pg) return new Response("nope", { status: 404 });
    return new Response(pg.body as BodyInit ?? "", { status: pg.status ?? 200, headers: pg.headers ?? { "content-type": "text/html; charset=utf-8" } });
  }) as typeof fetch;
  return { f, calls };
}

const HTML = `<!doctype html><html><head><title>Plain &amp; simple</title>
<meta property="og:title" content="Hello &quot;world&quot;"><meta name="description" content="Fallback">
<meta property="og:description" content="A   page about things &#58; nice">
<meta property="og:image" content="/img/cover.png"><meta property="og:site_name" content="Example">
<link rel="icon" href="/fav.png"></head><body><meta property="og:title" content="ignored in body"></body></html>`;

describe("R100b link preview", () => {
  it("reads Open Graph first, then plain title and description", () => {
    const p = parsePreview(HTML, "https://example.org/a/b");
    expect(p).toEqual({ title: 'Hello "world"', description: "A page about things : nice", siteName: "Example", imageUrl: "https://example.org/img/cover.png", favicon: "https://example.org/fav.png" });
    const q2 = parsePreview("<title> Only a title </title><meta name='description' content='Desc'>", "https://www.site.org/");
    expect(q2).toMatchObject({ title: "Only a title", description: "Desc", siteName: "site.org", imageUrl: null });
    expect(parsePreview("", "https://site.org/").title).toBe("site.org");
    expect(parsePreview(`<meta property="og:image" content="javascript:alert(1)">`, "https://s.org/").imageUrl).toBeNull();
    expect(decodeEntities("&lt;b&gt; &#x41;&#66; &bogus;")).toBe("<b> AB &bogus;");
  });
  it("fetches with redirects followed by hand, and refuses a redirect into a private network", async () => {
    const { f, calls } = web({
      "https://example.org/start": { status: 301, headers: { location: "/final" } },
      "https://example.org/final": { body: HTML },
      "https://example.org/bad": { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } },
      "https://example.org/sneaky": { status: 302, headers: { location: "https://inside.example.org/" } },
    }, { "inside.example.org": "10.0.0.7" });
    const p = await fetchLinkPreview(f, "example.org/start");
    expect(p).toMatchObject({ finalUrl: "https://example.org/final", title: 'Hello "world"', image: "/api/tools-c2/link-preview/image?u=https%3A%2F%2Fexample.org%2Fimg%2Fcover.png" });
    expect(calls.every((c) => c.endsWith("manual"))).toBe(true);
    await expect(fetchLinkPreview(f, "https://example.org/bad")).rejects.toThrow(/private networks/);
    await expect(fetchLinkPreview(f, "https://example.org/sneaky")).rejects.toThrow(/private networks/);
    await expect(fetchLinkPreview(f, "https://example.org/missing")).rejects.toThrow(/not found/);
  });
  it("stops after too many redirects and caps the body", async () => {
    const loop: Record<string, { status: number; headers: Record<string, string> }> = {};
    for (let i = 0; i < 8; i++) loop[`https://example.org/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    await expect(fetchLinkPreview(web(loop).f, "https://example.org/0")).rejects.toThrow(/redirects too many/);
    const big = web({ "https://example.org/big": { body: "x".repeat(50_000) } });
    const r = await safeFetch(big.f, "https://example.org/big", { maxBytes: 1000 });
    expect(r.bytes.byteLength).toBe(1000);
    expect(r.truncated).toBe(true);
  });
  it("names a file that is not a web page", async () => {
    const { f } = web({ "https://example.org/a.pdf": { headers: { "content-type": "application/pdf" }, body: "%PDF-1.7" } });
    expect((await fetchLinkPreview(f, "https://example.org/a.pdf")).description).toMatch(/application\/pdf file/);
  });
  it("proxies pictures only, up to 5 MB", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const { f } = web({
      "https://example.org/p.png": { headers: { "content-type": "image/png" }, body: png },
      "https://example.org/x.svg": { headers: { "content-type": "image/svg+xml" }, body: "<svg onload=alert(1)>" },
      "https://example.org/huge.png": { headers: { "content-type": "image/png" }, body: new Uint8Array(5 * 1024 * 1024 + 10) },
    });
    expect((await fetchPreviewImage(f, "https://example.org/p.png")).contentType).toBe("image/png");
    await expect(fetchPreviewImage(f, "https://example.org/x.svg")).rejects.toThrow(/not a picture/);
    await expect(fetchPreviewImage(f, "https://example.org/huge.png")).rejects.toThrow(/over 5 MB/);
    await expect(fetchPreviewImage(f, "http://10.0.0.1/p.png")).rejects.toThrow(/private/);
    expect(imageTypeOf(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("image/gif");
  });
});

describe("R100b slides and drawings in the Convert hub", () => {
  it("plans slides and drawing routes only when tools_c2 is on", () => {
    expect(SLIDE_PAIRS.length).toBe(8);
    expect(routeTo("odg", "pdf", { features: ["tools_c2"] })).toBeTruthy();
    expect(routeTo("ppt", "pdf", { features: ["tools_c2"] })).toBeTruthy();
    expect(routeTo("pptx", "odp", { features: ["tools_c2"] })).toBeTruthy();
    expect(routeTo("pdf", "odg", { features: ["tools_c2"] })).toBeTruthy();
    expect(planRoutes("odg", { features: [] }).length).toBe(0);
  });
  it("has a Slides and drawings card with one result type per target", () => {
    const t = toolDef("slides-convert");
    expect(t.feature).toBe("tools_c2");
    expect(Object.keys(t.extBy!.exts).sort()).toEqual(["odg", "odp", "pdf", "pptx", "svg"]);
  });
});
