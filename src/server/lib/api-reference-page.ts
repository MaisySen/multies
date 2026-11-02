import { SCALAR_ASSET } from "./security-headers";

/**
 * R30: the API reference page without inline script. The page loads /api/v1/reference.js, which
 * turns off Zod's JIT probe (it calls Function() once and trips script-src without 'unsafe-eval')
 * and then loads the pinned Scalar renderer from our own origin (F13: no CDN script host).
 */
export function apiReferenceHtml(title = "Multies API reference", specUrl = "/api/v1/openapi.json"): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <div id="app" data-spec-url="${specUrl}"></div>
    <noscript><a href="${specUrl}">OpenAPI document</a></noscript>
    <script type="module" src="/api/v1/reference.js"></script>
  </body>
</html>
`;
}

export function apiReferenceBootJs(specUrl = "/api/v1/openapi.json"): string {
  return `globalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true });
const s = document.createElement("script");
s.src = ${JSON.stringify(SCALAR_ASSET)};
s.onload = () => window.Scalar.createApiReference("#app", { url: ${JSON.stringify(specUrl)}, theme: "default", withDefaultFonts: false });
document.head.appendChild(s);
`;
}
