/**
 * Sending files from chat: the picker and its limits, reading files as base64, upload progress
 * through the transport, the server's 413 in plain words, fresh signed links, and the composer
 * end to end against the sample workspace.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as DocumentPicker from "expo-document-picker";
import { ApiError } from "@/api/errors";
import { HttpTransport, xhrRequest } from "@/api/transport";
import {
  CHAT_FILE_MAX_BYTES, fileProblem, linkStillGood, pickChatFiles, progressLabel, readBase64, sendErrorText, stripDataUrl, toOutgoing,
} from "@/lib/chat-files";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";

let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => mockParams,
  useIsFocused: () => true,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

const pick = DocumentPicker.getDocumentAsync as jest.Mock;
const asset = (over: Record<string, unknown> = {}) => ({ name: "quote.pdf", size: 1200, mimeType: "application/pdf", uri: "file:///cache/quote.pdf", lastModified: 0, ...over });

/** A stand in for XMLHttpRequest that reports upload progress in two steps and answers with `status`. */
function fakeXhr(status: number, body: string, headers = "content-type: application/json\r\n") {
  const sent: { method?: string; url?: string; headers: Record<string, string>; body?: unknown } = { headers: {} };
  class X {
    status = 0; responseText = ""; withCredentials = true;
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null; onerror: (() => void) | null = null; ontimeout: (() => void) | null = null;
    open(m: string, u: string) { sent.method = m; sent.url = u; }
    setRequestHeader(k: string, v: string) { sent.headers[k] = v; }
    getAllResponseHeaders() { return headers; }
    abort() {}
    send(b: unknown) {
      sent.body = b;
      this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
      this.status = status; this.responseText = body;
      this.onload?.();
    }
  }
  return { X: X as unknown as typeof XMLHttpRequest, sent };
}

describe("file limits", () => {
  it("allows files up to 10 MB and 5 per message, and says why otherwise", () => {
    expect(CHAT_FILE_MAX_BYTES).toBe(10_000_000);
    expect(fileProblem({ name: "a.pdf", size: 10_000_000 })).toBeNull();
    expect(fileProblem({ name: "a.pdf", size: undefined })).toBeNull();
    expect(fileProblem({ name: "big.mov", size: 10_000_001 })).toMatch(/^big\.mov is 9\.5 MB\. Files can be up to 10 MB\.$/);
    expect(fileProblem({ name: "e.txt", size: 0 })).toBe("e.txt is empty.");
    expect(fileProblem({ name: "a.pdf", size: 10 }, 5)).toBe("You can attach up to 5 files at a time.");
  });

  it("keeps the files that fit from the picker and reports the first one that does not", async () => {
    pick.mockResolvedValueOnce({ canceled: false, assets: [asset(), asset({ name: "huge.zip", size: 30_000_000 }), asset({ name: "b.png", mimeType: "image/png" })] });
    const got = await pickChatFiles(0);
    expect(pick).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, copyToCacheDirectory: true }));
    expect(got.files.map((f) => f.name)).toEqual(["quote.pdf", "b.png"]);
    expect(got.problem).toMatch(/huge\.zip is 28\.6 MB/);
  });

  it("stops at 5 files counting what is already attached, and a cancelled picker adds nothing", async () => {
    pick.mockResolvedValueOnce({ canceled: false, assets: [asset({ name: "1" }), asset({ name: "2" }), asset({ name: "3" })] });
    const got = await pickChatFiles(3);
    expect(got.files.map((f) => f.name)).toEqual(["1", "2"]);
    expect(got.problem).toBe("You can attach up to 5 files at a time.");
    pick.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickChatFiles(0)).toEqual({ files: [], problem: null });
  });
});

describe("reading files", () => {
  const realReader = global.FileReader;
  afterEach(() => { global.FileReader = realReader; });

  it("uses the picker's base64 on the web, minus any data: prefix", async () => {
    expect(stripDataUrl("data:text/plain;base64,aGk=")).toBe("aGk=");
    expect(await readBase64({ name: "a.txt", uri: "blob:x", base64: "data:text/plain;base64,aGk=" })).toBe("aGk=");
  });

  it("reads the local file on a phone and checks the real size", async () => {
    global.FileReader = class {
      result: string | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      readAsDataURL() { this.result = "data:application/pdf;base64,aGVsbG8="; this.onload?.(); }
    } as unknown as typeof FileReader;
    const fetchImpl = jest.fn(async () => ({ blob: async () => ({}) })) as unknown as typeof fetch;
    const out = await toOutgoing([{ name: "q.pdf", uri: "file:///q.pdf", mimeType: "application/pdf" }], fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("file:///q.pdf");
    expect(out).toEqual([{ filename: "q.pdf", contentType: "application/pdf", contentBase64: "aGVsbG8=" }]);

    const big = "A".repeat(Math.ceil((CHAT_FILE_MAX_BYTES + 3) / 3) * 4);
    global.FileReader = class {
      result: string | null = null; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      readAsDataURL() { this.result = `data:video/mp4;base64,${big}`; this.onload?.(); }
    } as unknown as typeof FileReader;
    await expect(readBase64({ name: "clip.mp4", uri: "file:///clip.mp4" }, fetchImpl)).rejects.toThrow(/clip\.mp4 is .* Files can be up to 10 MB\./);
  });
});

describe("upload progress and errors", () => {
  it("reports progress through XMLHttpRequest and reads the answer", async () => {
    const { X, sent } = fakeXhr(201, '{"message":{"id":"m1"}}', "content-type: application/json\r\nset-cookie: a=1\r\n");
    const seen: number[] = [];
    const res = await xhrRequest("https://x.test/api/chat/channels/c1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, (f) => seen.push(f), X);
    expect(sent).toMatchObject({ method: "POST", url: "https://x.test/api/chat/channels/c1/messages", body: "{}", headers: { "content-type": "application/json" } });
    expect(seen).toEqual([0, 0.5, 1, 1]);
    expect(res.ok).toBe(true);
    expect(res.headers.get("Set-Cookie")).toBe("a=1");
    expect(await res.text()).toBe('{"message":{"id":"m1"}}');
  });

  it("sends the message and files through the transport with progress, and turns a 413 into the server's words", async () => {
    const realXhr = global.XMLHttpRequest;
    try {
      const ok = fakeXhr(201, '{"message":{"id":"m1"}}');
      global.XMLHttpRequest = ok.X;
      const fetchImpl = jest.fn();
      const t = new HttpTransport({ get: () => ({}), set: () => {} }, () => {}, "https://x.test", fetchImpl as unknown as typeof fetch);
      const seen: number[] = [];
      const files = [{ filename: "q.pdf", contentType: "application/pdf", contentBase64: "aGk=" }];
      await expect(t.request("POST", "/chat/channels/c1/messages", { body: "hi", attachments: files }, { onUploadProgress: (f) => seen.push(f) })).resolves.toEqual({ message: { id: "m1" } });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(JSON.parse(String(ok.sent.body))).toEqual({ body: "hi", attachments: files });
      expect(seen[seen.length - 1]).toBe(1);

      global.XMLHttpRequest = fakeXhr(413, '{"error":{"code":"file_too_large","message":"Files can be up to 10 MB here."}}').X;
      const err = (await t.request("POST", "/chat/channels/c1/messages", { body: "" }, { onUploadProgress: () => {} }).catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(413);
      expect(sendErrorText(err)).toMatch(/up to 10 MB/);
    } finally {
      global.XMLHttpRequest = realXhr;
    }
  });

  it("words progress and network failures plainly", () => {
    expect(progressLabel(0.42)).toBe("Sending 42%");
    expect(progressLabel(1)).toBe("Almost there");
    expect(sendErrorText(new ApiError(0, "network", "x"))).toBe("Can't reach Multies. Check your connection and try again.");
    expect(sendErrorText(new ApiError(413, "file_too_large", ""))).toBe("Files can be up to 10 MB.");
    expect(sendErrorText(new Error("Couldn't read a.pdf."))).toBe("Couldn't read a.pdf.");
  });
});

describe("signed file links", () => {
  it("treats a link as good until a minute before it expires", () => {
    const now = 1_000_000;
    expect(linkStillGood(`/api/chat/files/f1/download?exp=${now + 15 * 60_000}&sig=ab`, now)).toBe(true);
    expect(linkStillGood(`/api/chat/files/f1/download?exp=${now + 30_000}&sig=ab`, now)).toBe(false);
    expect(linkStillGood("/api/chat/files/f1", now)).toBe(true);
    expect(linkStillGood(undefined, now)).toBe(false);
  });
});

describe("composer with files", () => {
  const clients: QueryClient[] = [];
  afterEach(() => { while (clients.length) clients.pop()!.clear(); });

  it("attaches a file, shows it, sends it with the message and clears", async () => {
    mockParams = { id: "chn_markets" };
    const transport = new SampleTransport();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    clients.push(qc);
    const Channel = require("@/app/chat/[id]").default;
    await render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={transport}><Channel /></SessionProvider></QueryClientProvider>);
    await screen.findByTestId("composer-attach");

    pick.mockResolvedValueOnce({ canceled: false, assets: [asset({ name: "menu.pdf", size: 3, base64: "data:application/pdf;base64,aGk=" })] });
    await act(async () => { fireEvent.press(screen.getByTestId("composer-attach")); });
    expect(await screen.findByText("menu.pdf")).toBeTruthy();
    expect(screen.getByLabelText("Remove menu.pdf")).toBeTruthy();

    await act(async () => { fireEvent.press(screen.getByTestId("composer-send")); });
    await waitFor(() => expect(screen.queryByTestId("composer-file-0")).toBeNull());
    const { messages } = await transport.request<{ messages: { body: string; attachments: { filename: string }[] }[] }>("GET", "/chat/channels/chn_markets/messages");
    expect(messages[messages.length - 1].attachments.map((a) => a.filename)).toEqual(["menu.pdf"]);
    expect(screen.queryByTestId("composer-error")).toBeNull();
  });

  it("shows the reason when a picked file is too big", async () => {
    mockParams = { id: "chn_markets" };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    clients.push(qc);
    const Channel = require("@/app/chat/[id]").default;
    await render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={new SampleTransport()}><Channel /></SessionProvider></QueryClientProvider>);
    await screen.findByTestId("composer-attach");
    pick.mockResolvedValueOnce({ canceled: false, assets: [asset({ name: "film.mov", size: 26_000_000 })] });
    await act(async () => { fireEvent.press(screen.getByTestId("composer-attach")); });
    expect((await screen.findByTestId("composer-error")).props.children).toMatch(/film\.mov is 24\.8 MB\. Files can be up to 10 MB\./);
    expect(screen.queryByTestId("composer-file-0")).toBeNull();
  });
});
