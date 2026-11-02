/**
 * M1 (1.10.9): Files on the phone (the web's R101 drive). Mock only: every request goes to the sample transport,
 * nothing reaches a server or a network.
 */
import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setOffline } from "@/lib/offline";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { driveRoute, sampleDrive } from "@/sample/drive";
import type { Method, RequestOptions } from "@/api/transport";
import {
  addTarget, canEditTags, cleanName, driveQuery, DRIVE_QUERY_BYTES, contentPath, driveError, emptyFor, isDriveDetail, isDriveList, isDriveUsage, itemIcon, parseTags, phonePreviewsImage, previewKind, rowSub,
  selectActions, sizeLabel, starTarget, tooBig, tooBigLine, uploadPath, usageLine, type DriveItem, type DriveList,
} from "@/lib/drive";
import { COMMANDS, createHandlers } from "@/lib/commands";
import Files from "@/app/files";
import FileDetail from "@/app/files-item/[id]";

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: (...a: unknown[]) => mockReplace(...a), navigate: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (cb: () => void) => { require("react").useEffect(cb, [cb]); },
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

configure({ asyncUtilTimeout: 10_000 });
jest.setTimeout(60_000);

/** A sample workspace seen as someone else: a member, a guest (no workspace on the session), or with Files off on the web. */
class AsTransport extends SampleTransport {
  constructor(private who: { role: "owner" | "member" | null; filesPlus: boolean }) { super(); }
  async request<T>(method: Method, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    if (method === "GET" && path === "/config") return { filesPlus: this.who.filesPlus } as T;
    if (method === "GET" && path === "/account/me") {
      const me = await super.request<{ user: unknown; organization: Record<string, unknown> | null }>(method, path, body, opts);
      return { ...me, organization: this.who.role ? { ...me.organization, role: this.who.role } : null } as T;
    }
    return super.request<T>(method, path, body, opts);
  }
}

async function wrap(ui: ReactNode, transport: SampleTransport = new SampleTransport(), sample = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode={sample ? "sample" : undefined} transportOverride={transport}>{ui}</SessionProvider></QueryClientProvider>);
}

const item = (p: Partial<DriveItem> = {}): DriveItem => ({
  id: "i1", kind: "file", space: "team", parentId: null, name: "Report.pdf", contentType: "application/pdf", sizeBytes: 2048, versions: 1, tags: [], note: null,
  createdBy: { id: "u", name: "U" }, ownerId: null, updatedAt: "2026-10-30T10:00:00Z", createdAt: "2026-10-30T10:00:00Z", starred: false, shared: false, trashedAt: null, canEdit: true, canDelete: true, ...p,
});

beforeEach(() => { mockParams = {}; mockPush.mockReset(); mockReplace.mockReset(); setOffline(false); onlineManager.setOnline(true); });

describe("drive rules (same as the web's src/shared/drive.ts)", () => {
  test("sizes, names and tags", () => {
    expect(sizeLabel(500)).toBe("500 B");
    expect(sizeLabel(2048)).toBe("2 KB");
    expect(sizeLabel(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(cleanName("  a/b\\c  ")).toBe("a b c");
    expect(cleanName("..")).toBe("");
    expect(cleanName("x".repeat(300))).toHaveLength(200);
    expect(parseTags("Logo, DARK,, logo, print!")).toEqual(["logo", "dark", "print"]);
    expect(parseTags(Array.from({ length: 20 }, (_, i) => `t${i}`).join(","))).toHaveLength(12);
  });
  test("previews and icons", () => {
    expect(previewKind("image/png", "a.png")).toBe("image");
    expect(previewKind(null, "a.pdf")).toBe("pdf");
    expect(previewKind("application/octet-stream", "b.docx")).toBe("office");
    expect(phonePreviewsImage(item({ contentType: "image/jpeg", name: "a.jpg" }))).toBe(true);
    expect(phonePreviewsImage(item({ contentType: "image/svg+xml", name: "a.svg" }))).toBe(false);
    expect(phonePreviewsImage(item({ kind: "folder", contentType: null }))).toBe(false);
    expect(itemIcon(item({ kind: "folder" }))).toBe("layers");
    expect(itemIcon(item())).toBe("file-text");
  });
  test("limits say the server's words", () => {
    expect(tooBig(20 * 1024 * 1024)).toBe(false);
    expect(tooBig(20 * 1024 * 1024 + 1)).toBe(true);
    expect(tooBigLine()).toBe("Files can be up to 20 MB here.");
    expect(usageLine({ usedBytes: 5 * 1024 * 1024, quotaBytes: 200 * 1024 * 1024, fileBytes: 1 })).toBe("5.0 MB of 200.0 MB used");
  });
  test("where an upload goes", () => {
    const l = (p: Partial<DriveList>): DriveList => ({ view: "team", folder: null, path: [], canAdd: true, items: [], next: null, ...p });
    expect(addTarget(l({}))).toEqual({ space: "team", parentId: null });
    expect(addTarget(l({ view: "mine", folder: { id: "f", name: "F", canEdit: true } }))).toEqual({ space: "private", parentId: "f" });
    expect(addTarget(l({ view: "brand", canAdd: false }))).toBeNull();
    expect(addTarget(l({ view: "starred", canAdd: false }))).toBeNull();
    expect(addTarget(l({ view: "shared", canAdd: true, folder: { id: "s", name: "S", canEdit: true } }))).toEqual({ space: "private", parentId: "s" });
    expect(uploadPath({ space: "team", parentId: "f 1" }, "My file.pdf")).toBe("/api/drive/upload?space=team&name=My+file.pdf&parent=f+1");
    expect(contentPath("a b", { v: "v1", inline: true })).toBe("/api/drive/items/a%20b/content?v=v1&inline=1");
  });
  test("long searches are cut under the server's pattern limit", () => {
    const fit = (q: string) => new TextEncoder().encode(q.replace(/[%_!]/g, (c) => `!${c}`)).length <= DRIVE_QUERY_BYTES;
    expect(driveQuery("  Price   List ")).toBe("price list");
    expect(driveQuery("a".repeat(150))).toHaveLength(46);
    expect(fit(driveQuery("é".repeat(60)))).toBe(true);
    expect(fit(driveQuery("%_!".repeat(30)))).toBe(true);
    expect(driveQuery("😀".repeat(30))).toBe("😀".repeat(11));
  });
  test("select mode actions follow edit rights; trash only restores", () => {
    expect(selectActions("team", [item(), item({ id: "2", canEdit: false })])).toEqual({ move: false, star: true, trash: false, restore: false });
    expect(selectActions("team", [item()])).toEqual({ move: true, star: true, trash: true, restore: false });
    expect(selectActions("trash", [item()])).toEqual({ move: false, star: false, trash: false, restore: true });
    expect(selectActions("team", [])).toEqual({ move: false, star: false, trash: false, restore: false });
    expect(starTarget([item({ starred: true }), item()])).toBe(true);
    expect(starTarget([item({ starred: true })])).toBe(false);
  });
  test("tags edit only on the Brand library, only for admins", () => {
    expect(canEditTags(item({ space: "brand" }), true)).toBe(true);
    expect(canEditTags(item({ space: "brand" }), false)).toBe(false);
    expect(canEditTags(item({ space: "team" }), true)).toBe(false);
  });
  test("rows, empty states and errors", () => {
    expect(rowSub(item({ location: "Clients" }), new Date("2026-11-01"))).toBe("2 KB · 30 Oct · Clients");
    expect(rowSub(item({ kind: "folder" }), new Date("2027-02-01"))).toBe("30 Oct 2026");
    expect(emptyFor("trash", false, "").body).toBe("Items in the trash are deleted for good after 30 days.");
    expect(emptyFor("team", true, "").title).toBe("This folder is empty");
    expect(emptyFor("team", false, "x").title).toBe("Nothing matches");
    expect(driveError(Object.assign(new Error("No"), { status: 403 })).noAccess).toBe(true);
    expect(driveError(Object.assign(new Error("Can't reach"), { status: 0 })).offline).toBe(true);
  });
});

describe("sample drive answers the web's shapes", () => {
  test("lists, folders, search, starred, trash", () => {
    const s = sampleDrive(Date.parse("2026-11-01T10:00:00Z"));
    const team = driveRoute(s, "GET", "/drive/list?view=team", undefined) as DriveList;
    expect(isDriveList(team)).toBe(true);
    expect(team.items.map((i) => i.name).slice(0, 2)).toEqual(["Clients", "Marketing"]);
    const inside = driveRoute(s, "GET", "/drive/list?view=team&folder=drv-clients", undefined) as DriveList;
    expect(inside.path.map((p) => p.name)).toEqual(["Team files", "Clients"]);
    const found = driveRoute(s, "GET", "/drive/list?view=team&q=acme", undefined) as DriveList;
    expect(found.items.every((i) => i.location === "Clients")).toBe(true);
    expect((driveRoute(s, "GET", "/drive/list?view=trash", undefined) as DriveList).items.map((i) => i.name)).toEqual(["Old flyer.pdf"]);
    expect((driveRoute(s, "GET", "/drive/list?view=shared", undefined) as DriveList).items[0].location).toBe("From Sam Lee");
    expect(isDriveDetail(driveRoute(s, "GET", "/drive/items/drv-price", undefined))).toBe(true);
    expect(isDriveUsage(driveRoute(s, "GET", "/drive/usage", undefined))).toBe(true);
  });
  test("refuses as the web does", () => {
    const s = sampleDrive();
    expect(() => driveRoute(s, "PUT", "/drive/upload?space=team&name=big.mov", { size: 30 * 1024 * 1024 })).toThrow("Files can be up to 20 MB here.");
    expect(() => driveRoute(s, "POST", "/drive/folders", { space: "team", parentId: null, name: " / " })).toThrow("Give the folder a name.");
    expect(() => driveRoute(s, "PATCH", "/drive/items/drv-sam-plan", { name: "x" })).toThrow("You can only view this.");
  });
  test("restore a version adds a new newest version", () => {
    const s = sampleDrive();
    const d = driveRoute(s, "POST", "/drive/items/drv-price/versions/drv-price-v1/restore", {}) as { versions: { number: number; current: boolean; note: string | null }[] };
    expect(d.versions[0]).toMatchObject({ number: 4, current: true, note: "Restored from version 1" });
  });
});

describe("command", () => {
  test("Files opens /files", () => {
    expect(COMMANDS.find((c) => c.id === "files")?.title).toBe("Files");
    const navigate = jest.fn();
    createHandlers({ navigate, openWeb: jest.fn() }).files({});
    expect(navigate).toHaveBeenCalledWith("/files");
  });
});

describe("Files screen", () => {
  test("Team files lists folders first, the usage line, and opens a folder", async () => {
    await wrap(<Files />);
    expect(await screen.findByText("Clients")).toBeTruthy();
    expect(screen.getByText("Price list 2026.pdf")).toBeTruthy();
    expect(await screen.findByText(/of 200\.0 MB used/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText(/^Folder, Clients/));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/files", params: { view: "team", folder: "drv-clients" } });
  });
  test("an image opens the full screen preview; details open the detail screen", async () => {
    await wrap(<Files />);
    await fireEvent.press(await screen.findByLabelText(/^File, Office opening\.jpg/));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/files-preview/[id]", params: { id: "drv-photo", name: "Office opening.jpg" } });
    await fireEvent.press(screen.getByLabelText("Details for Price list 2026.pdf"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/files-item/[id]", params: { id: "drv-price" } });
  });
  test("a folder shows its path", async () => {
    mockParams = { view: "team", folder: "drv-clients" };
    await wrap(<Files />);
    expect(await screen.findByText("Acme proposal.docx")).toBeTruthy();
    expect(screen.getByLabelText("Go to Team files")).toBeTruthy();
  });
  test("long press starts select mode with the zip note on the web", async () => {
    await wrap(<Files />);
    await fireEvent(await screen.findByLabelText(/^File, Price list 2026\.pdf/), "longPress");
    expect(await screen.findByText("1 selected")).toBeTruthy();
    expect(screen.getByText("Downloading several files as a zip is on the web.")).toBeTruthy();
    expect(screen.getByLabelText("Move")).toBeTruthy();
  });
  test("Trash offers Restore and says how long items stay", async () => {
    mockParams = { view: "trash" };
    await wrap(<Files />);
    expect(await screen.findByText("Old flyer.pdf")).toBeTruthy();
    expect(screen.getByText("Items in the trash are deleted for good after 30 days.")).toBeTruthy();
    await fireEvent(screen.getByLabelText(/^File, Old flyer\.pdf/), "longPress");
    await fireEvent.press(await screen.findByLabelText("Restore"));
    await waitFor(() => expect(screen.queryByText("Old flyer.pdf")).toBeNull());
  });
  test("Brand library: tags to filter; members are told only admins change it", async () => {
    mockParams = { view: "brand" };
    await wrap(<Files />, new AsTransport({ role: "member", filesPlus: true }), false);
    expect(await screen.findByText("Logo dark.png")).toBeTruthy();
    expect(screen.getByText(/Only admins can change the brand library/)).toBeTruthy();
    await fireEvent.press(await screen.findByLabelText(/^template/));
    await waitFor(() => expect(screen.queryByText("Logo dark.png")).toBeNull());
  });
  test("a guest (no workspace on the session) gets no Files", async () => {
    await wrap(<Files />, new AsTransport({ role: null, filesPlus: true }), false);
    expect(await screen.findByText("You do not have access to this")).toBeTruthy();
    expect(screen.queryByText("Clients")).toBeNull();
  });
  test("Files off on the web means no Files on the phone", async () => {
    await wrap(<Files />, new AsTransport({ role: "owner", filesPlus: false }), false);
    expect(await screen.findByTestId("files-off")).toBeTruthy();
  });
});

describe("file detail", () => {
  test("versions with Restore, rename and note", async () => {
    mockParams = { id: "drv-price" };
    await wrap(<FileDetail />);
    expect(await screen.findByText("Version 3")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getByLabelText("Restore version 2")).toBeTruthy();
    expect(screen.queryByLabelText("Restore version 3")).toBeNull();
    expect(screen.getByText("Upload a new version")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("file-rename"));
    await fireEvent.changeText(await screen.findByTestId("file-rename-sheet-input"), "Prices.pdf");
    await fireEvent.press(screen.getByTestId("file-rename-sheet-save"));
    expect(await screen.findByText("Prices.pdf")).toBeTruthy();
  });
  test("view only file: no edit rows", async () => {
    mockParams = { id: "drv-sam-plan" };
    await wrap(<FileDetail />);
    expect(await screen.findByText("View only")).toBeTruthy();
    expect(screen.queryByText("Rename")).toBeNull();
    expect(screen.queryByLabelText(/^Restore version/)).toBeNull();
  });
  test("brand tags: admins edit, members read", async () => {
    mockParams = { id: "drv-logo" };
    await wrap(<FileDetail />);
    expect(await screen.findByText("logo, dark")).toBeTruthy();
    expect(screen.getByText(/Up to 12 tags/)).toBeTruthy();
  });
  test("a missing file shows a plain state", async () => {
    mockParams = { id: "nope" };
    await wrap(<FileDetail />);
    expect(await screen.findByText("You can't open this file")).toBeTruthy();
  });
});
