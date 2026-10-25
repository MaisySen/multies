/**
 * Email addresses from the phone (build 13): connect an existing mailbox, take a free address,
 * the connected accounts list, and Compose pointing to them when there is nothing to send from.
 */
import { Alert } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SessionProvider } from "@/lib/session";
import { SampleTransport } from "@/sample/transport";
import { HttpTransport, type Method, type RequestOptions, type Transport } from "@/api/transport";
import { endpoints } from "@/api/endpoints";
import {
  CONNECT_PRESETS, PRESET_ORDER, cleanLocalPart, connectRequest, connectionStatusLabel, connectionTone, emptyConnectForm, failedStep,
  lastSyncLabel, localPartProblem, presetForEmail, serversFor,
} from "@/lib/mail-connect";

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock("expo-router", () => ({
  router: { push: (...a: unknown[]) => mockPush(...a), back: jest.fn(), replace: (...a: unknown[]) => mockReplace(...a), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }), SafeAreaView: ({ children }: { children: ReactNode }) => children }));

let transport: SampleTransport;
async function wrap(ui: ReactNode, t: Transport = transport) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><SessionProvider initialMode="sample" transportOverride={t}>{ui}</SessionProvider></QueryClientProvider>);
}
beforeEach(() => { transport = new SampleTransport(); mockPush.mockClear(); mockReplace.mockClear(); mockParams = {}; jest.restoreAllMocks(); });

describe("provider presets", () => {
  it("has every provider the web offers, in the same order, each with help", () => {
    expect(PRESET_ORDER).toEqual(["gmail", "google_workspace", "outlook", "microsoft365", "yahoo", "icloud", "zoho", "fastmail", "gmx", "custom"]);
    for (const id of PRESET_ORDER) expect(CONNECT_PRESETS[id].help.length).toBeGreaterThan(20);
    for (const id of PRESET_ORDER) if (CONNECT_PRESETS[id].appPasswordUrl) expect(CONNECT_PRESETS[id].appPasswordUrl).toMatch(/^https:\/\//);
  });

  it("guesses the provider from the address", () => {
    expect(presetForEmail("Ava@Gmail.com")).toBe("gmail");
    expect(presetForEmail("a@hotmail.co.uk")).toBe("outlook");
    expect(presetForEmail("a@ymail.com")).toBe("yahoo");
    expect(presetForEmail("a@me.com")).toBe("icloud");
    expect(presetForEmail("a@zohomail.com")).toBe("zoho");
    expect(presetForEmail("a@fastmail.fm")).toBe("fastmail");
    expect(presetForEmail("a@gmx.de")).toBe("gmx");
    expect(presetForEmail("ava@harbourcoffee.com.au")).toBeNull();
    expect(presetForEmail("not an address")).toBeNull();
  });

  it("uses the GMX .net servers for gmx.net, .de, .at and .ch", () => {
    expect(serversFor("gmx", "a@gmx.de").imap.host).toBe("imap.gmx.net");
    expect(serversFor("gmx", "a@gmx.com").imap.host).toBe("imap.gmx.com");
    const s = serversFor("gmail", "a@gmail.com");
    s.imap.host = "changed";
    expect(CONNECT_PRESETS.gmail.imap.host).toBe("imap.gmail.com");
  });
});

describe("connect form", () => {
  it("asks for a full address and a password first", () => {
    expect(connectRequest({ ...emptyConnectForm(), email: "ava" })).toEqual({ error: "Enter the full email address, like name@example.com." });
    expect(connectRequest({ ...emptyConnectForm(), email: "ava@gmail.com" })).toEqual({ error: "Paste the app password for this mailbox." });
    expect(connectRequest({ ...emptyConnectForm("gmx"), email: "ava@gmx.com" })).toEqual({ error: "Enter the password for this mailbox." });
  });

  it("sends no server settings for a preset (the server picks them)", () => {
    const r = connectRequest({ ...emptyConnectForm("gmail"), email: " ava@gmail.com ", password: "abcd efgh" });
    expect(r).toEqual({ body: { email: "ava@gmail.com", password: "abcd efgh", preset: "gmail" } });
  });

  it("checks custom server names and ports and sends them", () => {
    const base = { ...emptyConnectForm("custom"), email: "ava@harbour.com.au", password: "pw" };
    expect(connectRequest(base)).toEqual({ error: "Enter the IMAP server name, like imap.example.com." });
    expect(connectRequest({ ...base, imapHost: "imap.harbour.com.au", imapPort: "99999" })).toEqual({ error: "The IMAP port is a number from 1 to 65535, usually 993." });
    expect(connectRequest({ ...base, imapHost: "imap.harbour.com.au", smtpHost: "smtp" })).toEqual({ error: "Enter the SMTP server name, like smtp.example.com." });
    expect(connectRequest({ ...base, imapHost: "imap.harbour.com.au", smtpHost: "smtp.harbour.com.au", smtpPort: "x" })).toEqual({ error: "The SMTP port is a number from 1 to 65535, usually 465 or 587." });
    const ok = connectRequest({ ...base, imapHost: "IMAP.harbour.com.au", smtpHost: "smtp.harbour.com.au", username: " ava " });
    expect(ok).toEqual({ body: {
      email: "ava@harbour.com.au", password: "pw", preset: "custom", username: "ava",
      imap: { host: "imap.harbour.com.au", port: 993, security: "tls" }, smtp: { host: "smtp.harbour.com.au", port: 587, security: "starttls" },
    } });
  });

  it("reads which step failed from the server's answer", () => {
    expect(failedStep({ step: "imap" })).toBe("imap");
    expect(failedStep({ step: "smtp" })).toBe("smtp");
    expect(failedStep({ step: "other" })).toBeNull();
    expect(failedStep(undefined)).toBeNull();
  });
});

describe("free address names", () => {
  it("cleans what is typed", () => {
    expect(cleanLocalPart(" Ava Lin@mail.multies.si")).toBe("avalin");
  });
  it("checks the shape before asking the server", () => {
    expect(localPartProblem("av")).toBe("Use at least 3 letters or numbers.");
    expect(localPartProblem(".ava")).toMatch(/^Use 3 to 40/);
    expect(localPartProblem("ava_lin")).toMatch(/^Use 3 to 40/);
    expect(localPartProblem("ava..lin")).toBe("Dots and dashes can't sit next to each other.");
    expect(localPartProblem("ava.harbour")).toBeNull();
  });
});

describe("connection status words", () => {
  it("labels and colours each status", () => {
    expect(connectionStatusLabel("auth_failed")).toBe("Password needed");
    expect(connectionTone("active")).toBe("ok");
    expect(connectionTone("auth_failed")).toBe("warn");
    expect(connectionTone("error")).toBe("bad");
    expect(connectionTone("syncing")).toBe("neutral");
  });
  it("says when the last sync was", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    expect(lastSyncLabel(null, now)).toBe("Not synced yet");
    expect(lastSyncLabel("nonsense", now)).toBe("Not synced yet");
    expect(lastSyncLabel("2026-10-25T11:59:40Z", now)).toBe("Synced just now");
    expect(lastSyncLabel("2026-10-25T11:55:00Z", now)).toBe("Synced 5 min ago");
    expect(lastSyncLabel("2026-10-25T09:00:00Z", now)).toBe("Synced 3 h ago");
    expect(lastSyncLabel("2026-10-24T12:00:00Z", now)).toBe("Synced 1 day ago");
    expect(lastSyncLabel("2026-10-20T12:00:00Z", now)).toBe("Synced 5 days ago");
  });
});

describe("API calls", () => {
  function recorder() {
    const calls: { method: Method; path: string; body?: unknown; opts?: RequestOptions }[] = [];
    const t: Transport = { kind: "live", request: async (method, path, body, opts) => { calls.push({ method, path, body, opts }); return {} as never; } };
    return { calls, api: endpoints(t) };
  }
  it("uses the web app's routes", async () => {
    const { calls, api } = recorder();
    await api.connections();
    await api.testConnection({ email: "a@gmail.com", password: "p", preset: "gmail" });
    await api.connect({ email: "a@gmail.com", password: "p", preset: "gmail" });
    await api.syncConnection("con 1");
    await api.reconnect("con_1", "new");
    await api.removeConnection("con_1");
    await api.freeAddress();
    await api.claimFreeAddress("ava.harbour");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /connections", "POST /connections/test", "POST /connections", "POST /connections/con%201/sync", "PUT /connections/con_1",
      "DELETE /connections/con_1", "GET /free-address", "POST /free-address",
    ]);
    expect(calls[4].body).toEqual({ password: "new" });
    expect(calls[7].body).toEqual({ localPart: "ava.harbour" });
    expect(calls[7].opts).toBeUndefined();
  });

  it("sends extra headers without letting them replace the session cookie", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, text: async () => "{}", headers: { get: () => null } }));
    const t = new HttpTransport({ get: () => ({ "better-auth.session_token": "s" }), set: () => {} }, () => {}, "https://multies.si", fetchImpl as unknown as typeof fetch);
    await t.request("POST", "/free-address", { localPart: "x" }, { headers: { "X-Device-Id": "dev-1", cookie: "evil=1" } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://multies.si/api/free-address");
    expect(init.headers["x-device-id"]).toBe("dev-1");
    expect(init.headers.cookie).toBe("better-auth.session_token=s");
  });
});

describe("Email addresses screen", () => {
  it("offers the three ways and lists connected accounts", async () => {
    const EmailSetup = require("@/app/email-setup").default;
    await wrap(<EmailSetup />);
    expect(await screen.findByText("Connect your email")).toBeTruthy();
    expect(await screen.findByText("Get a free @mail.multies.si address")).toBeTruthy();
    expect(screen.getByText("Use your own domain")).toBeTruthy();
    expect(await screen.findByText("ava.lin.studio@gmail.com")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("option-connect"));
    expect(mockPush).toHaveBeenCalledWith("/connect-mailbox");
    await fireEvent.press(screen.getByTestId("option-free"));
    expect(mockPush).toHaveBeenCalledWith("/free-address");
    const WebBrowser = require("expo-web-browser");
    WebBrowser.openBrowserAsync.mockClear?.();
    await fireEvent.press(screen.getByTestId("option-domain"));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith("https://multies.si/app/domains");
  });

  it("syncs now and removes after asking", async () => {
    const EmailSetup = require("@/app/email-setup").default;
    const spy = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { buttons?.find((b) => b.style === "destructive")?.onPress?.(); });
    const request = jest.spyOn(transport, "request");
    await wrap(<EmailSetup />);
    await fireEvent.press(await screen.findByTestId("sync-con_s1"));
    await waitFor(() => expect(request).toHaveBeenCalledWith("POST", "/connections/con_s1/sync", {}));
    await fireEvent.press(screen.getByTestId("remove-con_s1"));
    expect(spy.mock.calls[0][0]).toBe("Remove ava.lin.studio@gmail.com?");
    await waitFor(() => expect(screen.queryByText("ava.lin.studio@gmail.com")).toBeNull());
  });

  it("opens the web page when mailbox connect is off on the server", async () => {
    const t = new SampleTransport();
    const real = t.request.bind(t);
    t.request = (async (m: Method, p: string, b?: unknown, o?: RequestOptions) => (m === "GET" && p === "/connections" ? { enabled: false, connections: [] } : real(m, p, b, o))) as typeof t.request;
    const EmailSetup = require("@/app/email-setup").default;
    const WebBrowser = require("expo-web-browser");
    await wrap(<EmailSetup />, t);
    await screen.findByText("Get a free @mail.multies.si address");
    await waitFor(async () => { await fireEvent.press(screen.getByTestId("option-connect")); expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith("https://multies.si/app/settings/connections"); });
    expect(mockPush).not.toHaveBeenCalledWith("/connect-mailbox");
  });
});

describe("Connect your email screen", () => {
  it("picks the provider from the address, shows the server's words on a wrong password, then connects", async () => {
    const Connect = require("@/app/connect-mailbox").default;
    await wrap(<Connect />);
    await fireEvent.press(screen.getByText("Yahoo Mail"));
    await fireEvent.changeText(screen.getByTestId("connect-email"), "ava@icloud.com");
    // A provider picked by hand stays picked.
    expect(screen.getByText(/Yahoo needs an app password/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Gmail"));
    await fireEvent.changeText(screen.getByTestId("connect-password"), "wrong");
    await fireEvent.press(screen.getByTestId("connect-submit"));
    expect(await screen.findByText("Receiving mail (IMAP)")).toBeTruthy();
    expect(screen.getByText(/The password was refused/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("connect-password"), "abcd efgh ijkl mnop");
    await fireEvent.press(screen.getByTestId("connect-submit"));
    expect(await screen.findByTestId("connect-done")).toBeTruthy();
    expect(screen.getByText("ava@icloud.com is connected")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("open-inbox"));
    expect(mockReplace).toHaveBeenCalledWith("/inbox");
  });

  it("guesses the provider while none is picked, and checks the form before sending", async () => {
    const Connect = require("@/app/connect-mailbox").default;
    const request = jest.spyOn(transport, "request");
    await wrap(<Connect />);
    await fireEvent.changeText(screen.getByTestId("connect-email"), "ava@fastmail.com");
    expect(screen.getByText(/Create an app password in Settings, Privacy and Security/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId("connect-submit"));
    expect(await screen.findByText("Paste the app password for this mailbox.")).toBeTruthy();
    expect(request.mock.calls.some((c) => c[0] === "POST" && c[1] === "/connections")).toBe(false);
  });

  it("shows server fields for Other server", async () => {
    const Connect = require("@/app/connect-mailbox").default;
    await wrap(<Connect />);
    await fireEvent.press(screen.getByText("Other server"));
    expect(screen.getByTestId("custom-servers")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("connect-email"), "ava@harbour.com.au");
    await fireEvent.changeText(screen.getByTestId("connect-password"), "pw");
    await fireEvent.press(screen.getByTestId("connect-submit"));
    expect(await screen.findByText("Enter the IMAP server name, like imap.example.com.")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("imap-host"), "imap.harbour.com.au");
    await fireEvent.changeText(screen.getByTestId("smtp-host"), "smtp.harbour.com.au");
    await fireEvent.press(screen.getByTestId("connect-submit"));
    expect(await screen.findByText("ava@harbour.com.au is connected")).toBeTruthy();
  });

  it("opens the provider's app password page", async () => {
    const Connect = require("@/app/connect-mailbox").default;
    const WebBrowser = require("expo-web-browser");
    await wrap(<Connect />);
    await fireEvent.press(screen.getByTestId("app-password-link"));
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith("https://myaccount.google.com/apppasswords");
  });

  it("reconnects with only a new password", async () => {
    mockParams = { reconnect: "con_s1", email: "ava.lin.studio@gmail.com", preset: "gmail" };
    const Connect = require("@/app/connect-mailbox").default;
    const request = jest.spyOn(transport, "request");
    await wrap(<Connect />);
    expect(screen.queryByTestId("connect-email")).toBeNull();
    await fireEvent.press(screen.getByTestId("connect-submit"));
    expect(await screen.findByText("Paste the new app password for this mailbox.")).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("connect-password"), "new app password");
    await fireEvent.press(screen.getByTestId("connect-submit"));
    expect(await screen.findByTestId("connect-done")).toBeTruthy();
    expect(request).toHaveBeenCalledWith("PUT", "/connections/con_s1", { password: "new app password" });
  });
});

describe("Free address screen", () => {
  it("prefills a name, checks it, shows the server's words, then takes it", async () => {
    const Free = require("@/app/free-address").default;
    const request = jest.spyOn(transport, "request");
    await wrap(<Free />);
    const field = await screen.findByTestId("free-local");
    expect(field.props.value).toBe("ava.harbour");
    expect(screen.getByText("@mail.multies.si")).toBeTruthy();
    await fireEvent.changeText(field, "a.");
    await fireEvent.press(screen.getByTestId("free-claim"));
    expect(await screen.findByText("Use at least 3 letters or numbers.")).toBeTruthy();
    await fireEvent.changeText(field, "Ava");
    await fireEvent.press(screen.getByTestId("free-claim"));
    expect(await screen.findByText(/ava@mail.multies.si is taken/)).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId("free-local"), "ava.harbour");
    await fireEvent.press(screen.getByTestId("free-claim"));
    expect(await screen.findByTestId("free-address-done")).toBeTruthy();
    expect(screen.getByTestId("free-address-value").props.children).toBe("ava.harbour@mail.multies.si");
    const claim = request.mock.calls.find((c) => c[0] === "POST" && c[1] === "/free-address");
    expect(claim?.[2]).toEqual({ localPart: "ava" });
    // No device id leaves the phone (the store privacy answers declare only the push token).
    expect(claim?.[3]).toBeUndefined();
  });
});

describe("Compose with nothing to send from", () => {
  it("points to the new in-app flow instead of the web", async () => {
    const t = new SampleTransport();
    const real = t.request.bind(t);
    t.request = (async (m: Method, p: string, b?: unknown, o?: RequestOptions) => (m === "GET" && p === "/mail/overview" ? { mailboxes: [] } : real(m, p, b, o))) as typeof t.request;
    const Compose = require("@/app/compose").default;
    await wrap(<Compose />, t);
    await fireEvent.press(await screen.findByTestId("add-address"));
    expect(mockPush).toHaveBeenCalledWith("/email-setup");
  });
});

describe("Settings", () => {
  it("opens Email addresses", async () => {
    const Settings = require("@/app/(tabs)/settings").default;
    await wrap(<Settings />);
    await fireEvent.press(await screen.findByTestId("email-setup-link"));
    expect(mockPush).toHaveBeenCalledWith("/email-setup");
  });
});
