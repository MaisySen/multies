import { metaFor, OG_IMAGE, SITE_URL } from "./seo-meta";

function tag(selector: string, create: () => HTMLElement): HTMLElement {
  return document.head.querySelector<HTMLElement>(selector) ?? document.head.appendChild(create());
}
function meta(attr: "name" | "property", key: string, content: string) {
  tag(`meta[${attr}="${key}"]`, () => { const m = document.createElement("meta"); m.setAttribute(attr, key); return m; }).setAttribute("content", content);
}

/** Sets the title, description, canonical, robots and social tags for a path. */
export function applyMeta(path: string) {
  const m = metaFor(path);
  const url = SITE_URL + (path === "/" ? "/" : path.replace(/\/+$/, ""));
  document.title = m.title;
  meta("name", "description", m.description);
  meta("name", "robots", m.noindex ? "noindex" : "index, follow");
  meta("property", "og:title", m.title);
  meta("property", "og:description", m.description);
  meta("property", "og:url", url);
  meta("property", "og:image", OG_IMAGE);
  meta("name", "twitter:title", m.title);
  meta("name", "twitter:description", m.description);
  (tag('link[rel="canonical"]', () => { const l = document.createElement("link"); l.rel = "canonical"; return l; }) as HTMLLinkElement).href = url;
}
