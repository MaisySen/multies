/** OPS1: each Dialog names itself by its own title (useId), so a dialog over another dialog has the right name. */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "../src/web/components/ui/dialog";

const noop = () => {};

describe("Dialog ids", () => {
  it("two open dialogs each point aria-labelledby and aria-describedby at their own title and description", () => {
    const html = renderToStaticMarkup(createElement("div", null,
      createElement(Dialog, { open: true, onClose: noop, title: "Edit the workspace", description: "Change its name." }),
      createElement(Dialog, { open: true, onClose: noop, title: "Why are you doing this?" }),
    ));
    const dialogs = [...html.matchAll(/<dialog[^>]*aria-labelledby="([^"]+)"[^>]*>/g)];
    expect(dialogs).toHaveLength(2);
    const [a, b] = dialogs.map((m) => m[1]);
    expect(a).not.toBe(b);
    expect(html).not.toContain('id="dialog-title"');
    expect(html).toContain(`<h2 id="${a}" class="text-[17px] font-semibold">Edit the workspace</h2>`);
    expect(html).toContain(`<h2 id="${b}" class="text-[17px] font-semibold">Why are you doing this?</h2>`);
    const described = /<dialog[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeTruthy();
    expect(html).toContain(`<p id="${described}" class="mt-1 text-sm text-muted">Change its name.</p>`);
    expect([...html.matchAll(/aria-describedby=/g)]).toHaveLength(1);
  });
});
