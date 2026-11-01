/**
 * R103: a pretend web for local end to end runs only (DOCS_PLUS_FAKE_WEB=1, never set on staging or prod). Every
 * name resolves to a public address except private.example.org (10.0.0.1), so the SSRF guard is exercised too.
 */
const page = (title: string, path: string) => `<!doctype html><html lang="en"><head><title>${title}</title><meta property="og:site_name" content="Harbour Journal">
<meta name="description" content="A short guide from the Harbour Journal."></head><body><nav><a href="/">Home</a></nav><main><article><h1>${title}</h1>
<p>Roasting turns green beans into the brown coffee we know. It takes about twelve minutes and close attention to sound and smell.</p>
<h2>First crack</h2><p>At around 196 degrees the beans crack and expand. Read <a href="/guide">our guide</a> for the full method.</p>
<ul><li>Light roast keeps more acidity and fruit notes.</li><li>Dark roast tastes of chocolate and smoke.</li></ul>
<p>Rest the beans for two days before brewing so the gas can escape. Path ${path.replace(/[<>&"]/g, "")}.</p></article></main><footer>Footer text</footer></body></html>`;

export const fakeWebFetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (url.hostname === "cloudflare-dns.com") {
    const name = url.searchParams.get("name") ?? "";
    const v6 = url.searchParams.get("type") === "AAAA";
    const ip = name === "private.example.org" ? "10.0.0.1" : "93.184.216.34";
    return new Response(JSON.stringify({ Status: 0, Answer: v6 ? [] : [{ type: 1, data: ip }] }), { headers: { "content-type": "application/dns-json" } });
  }
  if (url.pathname.includes("missing")) return new Response("Not found", { status: 404, headers: { "content-type": "text/html" } });
  const title = url.pathname.includes("brew") ? "How to brew filter coffee" : "How we roast coffee";
  return new Response(page(title, url.pathname), { headers: { "content-type": "text/html; charset=utf-8" } });
}) as typeof fetch;
