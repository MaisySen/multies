/**
 * R78: what this browser can write on its own, measured without loading any converter (a 1 pixel canvas and an empty
 * WebAssembly module). HEIC is measured on the first HEIC file (browser-ops browserOpensHeic).
 */
import type { BrowserCaps } from "@/shared/convert-routes";

function wasmCompiles(): boolean {
  try {
    if (typeof WebAssembly !== "object") return false;
    return new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x0, 0x0, 0x0)) instanceof WebAssembly.Module;
  } catch { return false; }
}

function canvasWebp(): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    return c.toDataURL("image/webp").startsWith("data:image/webp");
  } catch { return false; }
}

let cached: Omit<BrowserCaps, "heicDecode"> | null = null;
export function measureCaps(heicDecode: boolean): BrowserCaps {
  if (!cached) {
    const wasm = wasmCompiles();
    cached = { webpEncode: canvasWebp() || wasm, avifEncode: wasm };
  }
  return { ...cached, heicDecode };
}
