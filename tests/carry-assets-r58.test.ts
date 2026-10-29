import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs deploy script without types
import { referenced } from "../scripts/carry-assets.mjs";

/** R58: the deploy carries the live release's /assets files into the new build; this is how it finds them. */
describe("R58 carry-assets: files the live release names", () => {
  it("reads index.html script and style tags", () => {
    const html = `<script type="module" src="/assets/index-C9gcpVKP.js"></script><link rel="stylesheet" href="/assets/index-0NVa8gVl.css"><link rel="icon" href="/favicon.ico">`;
    expect(referenced(html, false).sort()).toEqual(["index-0NVa8gVl.css", "index-C9gcpVKP.js"]);
  });

  it("reads vite's preload map, relative dynamic imports and css font urls inside chunks", () => {
    const js = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/my-work-BNq3R86z.js","assets/cn-5cqPxRB3.js"])));import("./search-Vd4fRI2W.js");`;
    expect(referenced(js, true).sort()).toEqual(["cn-5cqPxRB3.js", "my-work-BNq3R86z.js", "search-Vd4fRI2W.js"]);
    const css = `@font-face{src:url(/assets/inter-latin-400-AbC123.woff2) format("woff2")}.x{background:url(./dot-9Zz.svg)}`;
    expect(referenced(css, true).sort()).toEqual(["dot-9Zz.svg", "inter-latin-400-AbC123.woff2"]);
  });

  it("never follows a path outside /assets or a name with a slash", () => {
    expect(referenced(`"assets/../_worker.js" "./../secret.js" "/api/assets/x.js"`, true)).toEqual([]);
  });
});
