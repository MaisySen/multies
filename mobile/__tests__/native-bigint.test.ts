/**
 * Sentry 30 Oct 2026 (OTA 1.10.1, iPhone): "TypeError: Cannot convert 100 to BigInt". expo-file-system hands
 * Int64 values to JavaScript as BigInt on iPhone (upload progress bytesSent/totalBytes, File.size), and the Tools
 * progress bar did `fraction * 100`. These tests feed BigInt the way the phone does.
 */
const uploads: { opts: any }[] = [];
jest.mock("../node_modules/expo/node_modules/expo-file-system", () => {
  class File {
    uri: string; exists = false; size: bigint = BigInt(5_000_000);
    constructor(...parts: any[]) { this.uri = parts.map((p) => (typeof p === "string" ? p : p?.uri ?? "cache")).join("/"); }
    create() { this.exists = true; }
    delete() { this.exists = false; }
    write() {}
    async bytes() { return new Uint8Array([1, 2, 3]); }
    async upload(_url: string, opts: any) {
      uploads.push({ opts });
      // What iOS sends: BigInt counts, ending with sent === total.
      opts.onProgress?.({ bytesSent: BigInt(0), totalBytes: BigInt(400) });
      opts.onProgress?.({ bytesSent: BigInt(100), totalBytes: BigInt(400) });
      opts.onProgress?.({ bytesSent: BigInt(400), totalBytes: BigInt(400) });
      return { status: 202, body: JSON.stringify({ id: "job_1", status: "queued", name: "a.pdf" }) };
    }
  }
  return { File, Directory: class {}, Paths: { cache: { uri: "cache" } }, UploadType: { BINARY_CONTENT: 0 } };
});
jest.mock("expo-document-picker", () => ({ getDocumentAsync: jest.fn() }));

import { Platform } from "react-native";
import { asPicked, uploadJob } from "@/lib/tools-files";
import { byteFraction, toNumber } from "@/lib/native-number";
import { bytes } from "@/lib/format";
import { savedLine, sizeLabel } from "@/lib/tool-directory";
import { File } from "../node_modules/expo/node_modules/expo-file-system";

const auth = { base: "https://multies.si", headers: () => ({ authorization: "Bearer t" }), refresh: jest.fn(async () => undefined) } as any;

describe("BigInt from native code (Cannot convert 100 to BigInt)", () => {
  beforeAll(() => { (Platform as any).OS = "ios"; });

  it("upload progress with BigInt byte counts gives plain number fractions and never throws", async () => {
    const seen: number[] = [];
    // The real screen callback: Math.round(f * 100). With a BigInt f this threw.
    const job = await uploadJob(auth, "compress", [{ uri: "file:///a.pdf", name: "a.pdf", size: 3, type: "application/pdf" }], {}, (f) => { seen.push(Math.round(f * 100)); });
    expect((job as unknown as { id: string }).id).toBe("job_1");
    expect(seen).toEqual([0, 25, 100, 100]);
    expect(uploads).toHaveLength(1);
  });

  it("a throwing progress listener does not break the upload", async () => {
    const job = await uploadJob(auth, "compress", [{ uri: "file:///a.pdf", name: "a.pdf", size: 3, type: "application/pdf" }], {}, (f) => { if (f < 1) throw new Error("boom"); });
    expect((job as unknown as { id: string }).id).toBe("job_1");
  });

  it("a result file used in another tool carries a number size, not a BigInt", () => {
    const picked = asPicked(new (File as any)("cache", "a.pdf"), "a.pdf", "application/pdf");
    expect(typeof picked.size).toBe("number");
    expect(picked.size).toBe(5_000_000);
  });

  it("size labels take BigInt without throwing", () => {
    expect(bytes(BigInt(2048) as any)).toBe("2 KB");
    expect(sizeLabel(BigInt(941 * 1024) as any)).toBe("941 KB");
    expect(savedLine(BigInt(941 * 1024) as any, BigInt(129 * 1024) as any)).toContain("941 KB to 129 KB");
  });

  it("toNumber and byteFraction", () => {
    expect(toNumber(BigInt(100))).toBe(100);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(NaN, 7)).toBe(7);
    expect(byteFraction(BigInt(1), BigInt(4))).toBe(0.25);
    expect(byteFraction(BigInt(1), BigInt(0))).toBeNull();
    expect(byteFraction(5, 4)).toBe(1);
  });
});
