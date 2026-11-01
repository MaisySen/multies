import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@/web/lib/api";
import { LOAD_ERROR_BODY, LOAD_ERROR_TITLE } from "@/web/lib/load-errors-t1g";
import { LoadFailure, LoadErrorInline } from "@/web/components/load-error-t1g";
import { shouldAsk } from "@/web/components/tools/leave-guard";

/**
 * F12 (MB-299): one wording for a failed load everywhere in the app: "Couldn't load this. Something went wrong on our
 * side. Your work is safe." with Retry, from the shared card. Any other failed load string in a page fails here.
 * The few left are not reads of our data: a page's code file, a converter engine, a drawing or whiteboard renderer and
 * map tiles, each with its own words and retry.
 */
const ROOTS = ["src/web/pages/app", "src/web/layouts", "src/web/components"];
const FAILED_LOAD = /(did ?n['’]t|did not|could ?n['’]t|could not|can ?n['’]t|cannot|unable to|failed to) (load|be loaded)/i;
const ALLOWED: Record<string, RegExp> = {
  "src/web/components/lazy-page.tsx": /Could not load this page/,
  "src/web/pages/app/tools-convert/convert-hub.tsx": /Couldn't load the /,
  "src/web/pages/app/work/docs-visual/diagram-view.tsx": /Could not load the drawing/,
  "src/web/pages/app/work/docs-visual/whiteboard-view.tsx": /Could not load the whiteboard/,
  "src/web/pages/app/work/map-view-r115.tsx": /The map could not load|Failed to fetch/,
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(n) ? [p] : [];
  });
}

describe("one failed load wording (F12, MB-299)", () => {
  it("the shared card says the agreed words", () => {
    expect(`${LOAD_ERROR_TITLE}. ${LOAD_ERROR_BODY}`).toBe("Couldn't load this. Something went wrong on our side. Your work is safe.");
  });

  it("no page, layout or component has its own failed load string", () => {
    const root = process.cwd();
    const bad: string[] = [];
    for (const f of ROOTS.flatMap((d) => files(join(root, d)))) {
      const rel = relative(root, f);
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        const code = t.replace(/\/\/ .*$/, "").replace(/\{?\/\*.*?\*\/\}?/g, "");
        if (!FAILED_LOAD.test(code)) return;
        if (ALLOWED[rel]?.test(code)) return;
        bad.push(`${rel}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("a read that failed on our side shows the shared words with Retry", () => {
    for (const err of [new ApiError(500, "internal", "Something broke"), new ApiError(503, "unreachable", ""), new TypeError("Failed to fetch")]) {
      const html = renderToStaticMarkup(h(LoadFailure, { error: err, onRetry: () => undefined }));
      expect(html).toContain(LOAD_ERROR_TITLE.replace("'", "&#x27;"));
      expect(html).toContain("Your work is safe.");
      expect(html).toContain(">Retry<");
      expect(html).not.toContain("Something broke");
    }
  });

  it("a read the server refused keeps the server's own words", () => {
    const html = renderToStaticMarkup(h(LoadFailure, { error: new ApiError(403, "forbidden", "Connect this account first"), onRetry: () => undefined }));
    expect(html).toContain("Connect this account first");
    expect(html).not.toContain("Your work is safe.");
  });

  it("the one line version has the same words", () => {
    const html = renderToStaticMarkup(h(LoadErrorInline, { onRetry: () => undefined }));
    expect(html).toContain("Something went wrong on our side. Your work is safe.");
    expect(html).toContain('data-testid="load-error-retry"');
  });
});

describe("office editor leave guard (F12, MB-296)", () => {
  const editor = { pathname: "/app/files/office/abc" };
  it("asks before leaving with unsaved edits, by rail, link or Back", () => {
    expect(shouldAsk(true, editor, { pathname: "/app/tasks" }, 0)).toBe(true);
    expect(shouldAsk(true, editor, { pathname: "/app/files" }, 0)).toBe(true);
  });
  it("does not ask once saved, or for a move within the same page", () => {
    expect(shouldAsk(false, editor, { pathname: "/app/tasks" }, 0)).toBe(false);
    expect(shouldAsk(true, editor, { pathname: "/app/files/office/abc" }, 0)).toBe(false);
  });
});
