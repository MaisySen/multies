import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { EditorState } from "@tiptap/pm/state";
import { aspectAttrs, docBlockSchemaExtensions, imageDim } from "@/web/lib/docs-blocks-schema";
import { applyImageSizes, imagesToSize } from "@/web/lib/docs-blocks";

const schema = getSchema([StarterKit, ...docBlockSchemaExtensions()]);

function docWith(attrs: Record<string, unknown>[]) {
  return schema.node("doc", null, attrs.map((a) => schema.nodes.image.create(a)));
}

describe("R33 doc images keep their shape", () => {
  it("stores width and height on the image node, defaulting to none", () => {
    const n = schema.nodes.image.create({ src: "https://x.example/a.png", width: 1600, height: 900 });
    expect(n.attrs.width).toBe(1600);
    expect(n.attrs.height).toBe(900);
    expect(schema.nodes.image.create({ src: "https://x.example/b.png" }).attrs.width).toBeNull();
  });

  it("accepts only sensible pixel sizes", () => {
    expect(imageDim("1200")).toBe(1200);
    expect(imageDim(640.4)).toBe(640);
    expect(imageDim(0)).toBeNull();
    expect(imageDim(50_000)).toBeNull();
    expect(imageDim("abc")).toBeNull();
    expect(imageDim(undefined)).toBeNull();
  });

  it("renders width, height and an aspect-ratio so the box is reserved before the file loads", () => {
    expect(aspectAttrs(1600, 900)).toEqual({ width: "1600", height: "900", style: "aspect-ratio: 1600 / 900" });
    expect(aspectAttrs(null, 900)).toEqual({});
    const spec = schema.nodes.image.spec.toDOM!(schema.nodes.image.create({ src: "https://x.example/a.png", width: 800, height: 600 })) as unknown as [string, Record<string, string>];
    expect(spec[0]).toBe("img");
    expect(spec[1]).toMatchObject({ width: "800", height: "600", style: "aspect-ratio: 800 / 600", "data-size": "fit" });
  });

  it("old images get their measured size with the next edit, and only those without one", () => {
    const doc = docWith([{ src: "https://x.example/old.png" }, { src: "https://x.example/new.png", width: 10, height: 20 }, { src: "https://x.example/unseen.png" }]);
    const measured = new Map([["https://x.example/old.png", { width: 1200, height: 800 }], ["https://x.example/new.png", { width: 1, height: 1 }]]);
    expect(imagesToSize(doc, measured).map(([, d]) => d)).toEqual([{ width: 1200, height: 800 }]);
    const state = EditorState.create({ schema, doc });
    const tr = state.tr;
    expect(applyImageSizes(tr, measured)).toBe(true);
    expect(tr.getMeta("addToHistory")).toBe(false);
    const imgs: Record<string, unknown>[] = [];
    tr.doc.descendants((n) => { if (n.type.name === "image") imgs.push(n.attrs); });
    expect(imgs[0]).toMatchObject({ width: 1200, height: 800 });
    expect(imgs[1]).toMatchObject({ width: 10, height: 20 });
    expect(imgs[2]).toMatchObject({ width: null });
    expect(applyImageSizes(state.apply(tr).tr, measured)).toBe(false);
  });
});
