/** A human label for a session's device, e.g. "Chrome on macOS". Deliberately small. */
export function describeUserAgent(ua: string | null | undefined): { browser: string; os: string; mobile: boolean } {
  const s = ua ?? "";
  const browser =
    /Edg\//.test(s) ? "Edge" :
    /OPR\/|Opera/.test(s) ? "Opera" :
    /Firefox\//.test(s) ? "Firefox" :
    /Chrome\//.test(s) ? "Chrome" :
    /Safari\//.test(s) ? "Safari" :
    /curl\//.test(s) ? "curl" :
    /node|undici/i.test(s) ? "API client" : "Unknown browser";
  const os =
    /iPhone|iPad|iPod/.test(s) ? "iOS" :
    /Android/.test(s) ? "Android" :
    /Mac OS X|Macintosh/.test(s) ? "macOS" :
    /Windows/.test(s) ? "Windows" :
    /CrOS/.test(s) ? "ChromeOS" :
    /Linux/.test(s) ? "Linux" : "Unknown OS";
  return { browser, os, mobile: /Mobi|iPhone|Android/.test(s) };
}
