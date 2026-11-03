/**
 * SOCFIX: photos shrink to fit each network (12 MB JPEG and 8 MB PNG stand ins), aspect kept, EXIF orientation read,
 * default board and remembered community, LinkedIn images and Instagram carousels through the mocked networks.
 */
import { describe, expect, it } from "vitest";
import { encodeUnder, fitSize, jpegInfo, NETWORK_IMAGE_LIMITS, orientedSize, photoBudget, photoNote } from "../src/shared/social-image";
import { composerChecks, defaultTarget, formatFit } from "../src/shared/social-p2";
import { SOCIAL_IMAGE_MAX_BYTES } from "../src/shared/integrations";

/** Stand in for the canvas: bytes grow with pixels and quality like a photo JPEG (about 3.4 bytes per pixel at q 0.95). */
const fakeJpeg = (bytesPerPixelAtTop: number) => async (w: number, h: number, q: number) => ({ bytes: Math.round(w * h * bytesPerPixelAtTop * q * q) });

/** A JPEG with an EXIF orientation tag and a SOF size. */
function jpegWith(orientation: number, w: number, h: number, le = true): Uint8Array {
  const u16 = (n: number) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const u32 = (n: number) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24] : [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const sof = [8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xc0, (sof.length + 2) >> 8, (sof.length + 2) & 255, ...sof, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

describe("SOCFIX photo budget and shrink", () => {
  it("fits under the stored limit and every network's own limit", () => {
    const b = photoBudget();
    expect(b.bytes).toBeLessThanOrEqual(SOCIAL_IMAGE_MAX_BYTES);
    for (const l of Object.values(NETWORK_IMAGE_LIMITS)) expect(b.bytes).toBeLessThan(l.bytes);
    expect(b.edge).toBe(2048);
  });

  it("a 12 MB 4000x3000 JPEG comes out under every limit with its shape kept", async () => {
    const start = fitSize(4000, 3000, 2048);
    expect(start).toEqual({ w: 2048, h: 1536 });
    // 12 MB at 12 MP is about 1 byte per pixel at top quality.
    const r = await encodeUnder(start.w, start.h, photoBudget().bytes, fakeJpeg(1.1));
    expect(r.out.bytes).toBeLessThanOrEqual(photoBudget().bytes);
    for (const l of Object.values(NETWORK_IMAGE_LIMITS)) expect(r.out.bytes).toBeLessThan(l.bytes);
    expect(Math.abs(r.w / r.h - 4 / 3)).toBeLessThan(0.01);
  });

  it("an 8 MB 3264x2448 PNG (dense pixels) steps down size too, aspect kept", async () => {
    const start = fitSize(3264, 2448, 2048);
    const r = await encodeUnder(start.w, start.h, photoBudget().bytes, fakeJpeg(2.4));
    expect(r.out.bytes).toBeLessThanOrEqual(photoBudget().bytes);
    expect(r.w).toBeLessThan(start.w);
    expect(Math.abs(r.w / r.h - 3264 / 2448)).toBeLessThan(0.01);
  });

  it("a tall phone photo keeps portrait and never upscales a small one", () => {
    expect(fitSize(3024, 4032, 2048)).toEqual({ w: 1536, h: 2048 });
    expect(fitSize(800, 600, 2048)).toEqual({ w: 800, h: 600 });
  });

  it("reads EXIF orientation and the stored size, both byte orders", () => {
    expect(jpegInfo(jpegWith(6, 4032, 3024))).toEqual({ w: 4032, h: 3024, orientation: 6 });
    expect(jpegInfo(jpegWith(8, 4032, 3024, false))).toEqual({ w: 4032, h: 3024, orientation: 8 });
    expect(jpegInfo(jpegWith(1, 10, 20))?.orientation).toBe(1);
    expect(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    // A quarter turn swaps the sides: the upright photo is portrait.
    const i = jpegInfo(jpegWith(6, 4032, 3024))!;
    expect(orientedSize(i.w, i.h, i.orientation)).toEqual({ w: 3024, h: 4032 });
    expect(orientedSize(4032, 3024, 3)).toEqual({ w: 4032, h: 3024 });
  });

  it("gives up in plain words only when nothing fits", async () => {
    await expect(encodeUnder(400, 400, 10, async () => ({ bytes: 1e9 }))).rejects.toThrow(/could not be made small enough/);
  });

  it("says optimised in plain words", () => {
    expect(photoNote(12 * 1024 * 1024, 900 * 1024, true)).toBe("Optimised for posting, 12.0 MB to 900 KB");
    expect(photoNote(1, 1, false)).toBeNull();
  });
});

describe("SOCFIX targets and checks", () => {
  const boards = [{ id: "b1", name: "Visas" }, { id: "b2", name: "Study" }];
  it("picks the only board, or the one used last when it is still there", () => {
    expect(defaultTarget(true, [boards[0]!], null)).toEqual(boards[0]);
    expect(defaultTarget(true, boards, null)).toBeNull();
    expect(defaultTarget(true, boards, { id: "b2", name: "old name" })).toEqual(boards[1]);
    expect(defaultTarget(true, boards, { id: "gone", name: "Gone" })).toBeNull();
    expect(defaultTarget(true, [], null)).toBeNull();
  });
  it("offers the community used last", () => {
    expect(defaultTarget(false, [], { id: "r/AusVisa", name: "r/AusVisa" })).toEqual({ id: "r/AusVisa", name: "r/AusVisa" });
    expect(defaultTarget(false, [], null)).toBeNull();
  });
  it("LinkedIn takes images and Instagram takes a carousel, so both read ready", () => {
    expect(formatFit("linkedin", "image")).toEqual({ fit: "yes" });
    expect(formatFit("instagram", "carousel")).toEqual({ fit: "yes" });
    const imgs = [{ w: 1080, h: 1350 }, { w: 1080, h: 1350 }];
    const checks = composerChecks({ format: "carousel", main: "Visa news", images: imgs, accounts: [{ id: "l", app: "linkedin" }, { id: "i", app: "instagram" }, { id: "p", app: "pinterest", needsTarget: true, target: "b1" }, { id: "r", app: "reddit", needsTarget: true, target: "r/AusVisa" }] });
    expect(checks.find((c) => c.app === "linkedin")?.state).toBe("ready");
    expect(checks.find((c) => c.app === "instagram")?.state).toBe("ready");
    expect(checks.find((c) => c.app === "pinterest")?.notes).toEqual(["First image only"]);
    expect(checks.find((c) => c.app === "reddit")?.notes).toEqual(["Text only, the image is left off"]);
  });
  it("a LinkedIn poll says the image is left off", () => {
    const [c] = composerChecks({ format: "image", main: "Q", images: [{ w: 1, h: 1 }], extras: { poll: { question: "Which?", options: ["A", "B"], days: 3 } }, accounts: [{ id: "l", app: "linkedin" }] });
    expect(c!.notes).toContain("A poll post carries no image, so the image is left off");
  });
});

import { beforeEach } from "vitest";
import { Client, makeTestApp } from "./helpers";
import { mockComposioFetch, newMockState, type MockComposioState } from "../src/server/services/integrations/mock";

const ENV = { COMPOSIO_API_KEY: "ak_test_key_never_shown", COMPOSIO_BASE_URL: "https://composio.mock", APP_URL: "https://app.example.com" };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let mock: MockComposioState;
let owner: Client;
async function connect(c: Client, app: string) {
  const r = await c.post("/api/apps/connect", { app });
  const id = new URL(r.body.redirectUrl).searchParams.get("connected_account_id")!;
  await c.post(`/api/apps/accounts/${id}/confirm`);
  return id;
}
const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms));

describe("SOCFIX publishing on the stand in networks", () => {
  beforeEach(async () => {
    mock = newMockState();
    ctx = await makeTestApp(ENV, { fetch: mockComposioFetch(async () => { throw new Error("network disabled in tests"); }, mock) });
    owner = new Client(ctx.app);
    await owner.signup("owner-socfix@acme.io");
  });

  it("LinkedIn posts one image: registered, bytes sent, then the post names it", async () => {
    const li = await connect(owner, "linkedin");
    const r = await owner.post("/api/social/posts", { text: "Visa update", format: "image", images: [{ contentType: "image/png", dataB64: PNG }], targets: [{ accountId: li }] });
    expect(r.status).toBe(201);
    await wait();
    expect(mock.proxied.filter((p) => p.endpoint.includes("/rest/images?action=initializeUpload"))).toHaveLength(1);
    const put = mock.proxied.find((p) => p.method === "PUT")!;
    expect(put.endpoint).toMatch(/^https:\/\/www\.linkedin\.com\/dms-uploads\//);
    expect(put.binary).toBeGreaterThan(10);
    const body = mock.proxied.find((p) => p.endpoint.endsWith("/rest/posts") && p.method === "POST")!.body as { content?: { media?: { id: string } } };
    expect(body.content?.media?.id).toMatch(/^urn:li:image:/);
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
  });

  it("LinkedIn posts several images as one multi image post", async () => {
    const li = await connect(owner, "linkedin");
    const imgs = [1, 2, 3].map(() => ({ contentType: "image/png", dataB64: PNG }));
    await owner.post("/api/social/posts", { text: "Three", format: "carousel", images: imgs, targets: [{ accountId: li }] });
    await wait();
    const body = mock.proxied.find((p) => p.endpoint.endsWith("/rest/posts") && p.method === "POST")!.body as { content?: { multiImage?: { images: unknown[] } } };
    expect(body.content?.multiImage?.images).toHaveLength(3);
  });

  it("a refused LinkedIn upload fails that account in plain words and posts nothing", async () => {
    const li = await connect(owner, "linkedin");
    mock.accounts.get(li)!.data.noUpload = true;
    const r = await owner.post("/api/social/posts", { text: "Visa update", format: "image", images: [{ contentType: "image/png", dataB64: PNG }], targets: [{ accountId: li }] });
    await wait();
    expect(mock.proxied.some((p) => p.endpoint.endsWith("/rest/posts") && p.method === "POST")).toBe(false);
    const post = (await owner.get(`/api/social/posts/${r.body.post.id}`)).body.post;
    expect(post.targets[0].status).toBe("failed");
  });

  it("Instagram posts a carousel, and falls back to the first image with a note when refused", async () => {
    const ig = await connect(owner, "instagram");
    const imgs = [1, 2].map(() => ({ contentType: "image/png", dataB64: PNG }));
    await owner.post("/api/social/posts", { text: "Two", format: "carousel", images: imgs, targets: [{ accountId: ig }] });
    await wait();
    expect(mock.executed.filter((e) => e.slug === "INSTAGRAM_CREATE_MEDIA_CONTAINER" && e.args.is_carousel_item === true)).toHaveLength(2);
    expect(mock.executed.filter((e) => e.slug === "INSTAGRAM_CREATE_CAROUSEL_CONTAINER")).toHaveLength(1);
    expect(mock.executed.filter((e) => e.slug === "INSTAGRAM_CREATE_POST")).toHaveLength(1);

    mock.accounts.get(ig)!.data.noCarousel = true;
    const r2 = await owner.post("/api/social/posts", { text: "Two again", format: "carousel", images: imgs, targets: [{ accountId: ig }] });
    await wait();
    const post = (await owner.get(`/api/social/posts/${r2.body.post.id}`)).body.post;
    expect(post.status).toBe("done");
    expect(post.targets[0].note).toBe("Instagram took the first image only");
  });

  it("targets answer the boards and the board or community used last for that account", async () => {
    const pin = await connect(owner, "pinterest");
    const rd = await connect(owner, "reddit");
    mock.accounts.get(pin)!.data.boards = 3;
    let t = await owner.get(`/api/apps/accounts/${pin}/targets`);
    expect(t.body.targets).toHaveLength(3);
    expect(t.body.last).toBeNull();
    await owner.post("/api/social/posts", { text: "Pin", format: "image", images: [{ contentType: "image/png", dataB64: PNG }], targets: [{ accountId: pin, target: "bd_2", targetName: "Board 2" }, { accountId: rd, target: "r/AusVisa", targetName: "r/AusVisa" }] });
    await wait();
    t = await owner.get(`/api/apps/accounts/${pin}/targets`);
    expect(t.body.last).toEqual({ id: "bd_2", name: "Board 2" });
    t = await owner.get(`/api/apps/accounts/${rd}/targets`);
    expect(t.body).toEqual({ targets: [], last: { id: "r/AusVisa", name: "r/AusVisa" } });
  });

  it("a board list Pinterest refuses is an error the picker can retry, not an empty list", async () => {
    const pin = await connect(owner, "pinterest");
    mock.accounts.get(pin)!.data.boardsFail = true;
    const t = await owner.get(`/api/apps/accounts/${pin}/targets`);
    expect(t.status).toBe(503);
  });
});
