import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { ApiError, NETWORK_ERROR, toApiError } from "@/api/errors";
import { confirmTyped, deleteAccountMessage } from "@/lib/delete-account";
import { SessionProvider, useSession } from "@/lib/session";
import { kv } from "@/lib/kv";

jest.mock("expo-router", () => ({ router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() }, useLocalSearchParams: () => ({}), Stack: { Screen: () => null } }));

function res(status: number, body: unknown, setCookie?: string) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: (k: string) => (k.toLowerCase() === "set-cookie" ? setCookie ?? null : null) } };
}
const me = { user: { id: "u", email: "owner@shop.com.au", name: "Owner", emailVerified: true, twoFactor: false, platformAdmin: false }, organization: null };

describe("error messages", () => {
  it("reads the bare { error: code } shape with its details", () => {
    const e = toApiError(409, { error: "transfer_ownership_first", workspaces: ["Harbour Coffee Co"] });
    expect(e.code).toBe("transfer_ownership_first");
    expect(e.details.workspaces).toEqual(["Harbour Coffee Co"]);
    expect(toApiError(401, { error: { code: "unauthorized", message: "Sign in to continue." } }).code).toBe("unauthorized");
  });

  it("says something plain for every failure", () => {
    expect(deleteAccountMessage(toApiError(400, { error: "confirm_required" }))).toBe("Type DELETE in capitals to confirm.");
    expect(deleteAccountMessage(toApiError(400, { error: "password_required" }))).toBe("Enter your password to confirm.");
    expect(deleteAccountMessage(toApiError(403, { error: "wrong_password" }))).toBe("That password is incorrect. Nothing was deleted.");
    expect(deleteAccountMessage(toApiError(409, { error: "transfer_ownership_first", workspaces: ["Harbour Coffee Co"] })))
      .toBe("Harbour Coffee Co has other members. Make someone else an owner on the web first, or remove the other members, then try again.");
    expect(deleteAccountMessage(toApiError(409, { error: "transfer_ownership_first", workspaces: ["A", "B"] }))).toMatch(/^A, B have other members/);
    expect(deleteAccountMessage(toApiError(409, { error: "transfer_ownership_first" }))).toMatch(/^A workspace you own has other members/);
    expect(deleteAccountMessage(NETWORK_ERROR())).toMatch(/Nothing was deleted/);
    expect(deleteAccountMessage(new ApiError(503, "error", "x"))).toMatch(/Try again in a minute/);
    expect(deleteAccountMessage(new Error("boom"))).toBe("Something went wrong. Try again.");
  });

  it("wants DELETE typed exactly", () => {
    expect(confirmTyped("DELETE")).toBe(true);
    expect(confirmTyped(" DELETE ")).toBe(true);
    expect(confirmTyped("delete")).toBe(false);
    expect(confirmTyped("")).toBe(false);
  });
});

describe("deleting a live account", () => {
  let calls: { url: string; method: string; body: unknown }[];
  let answer: { status: number; body: unknown };

  async function signedIn() {
    calls = [];
    const store = require("expo-secure-store");
    await store.setItemAsync("mymail.cookies", JSON.stringify({ "__Secure-mymail.session_token": "sess.sig" }));
    await store.setItemAsync("mymail.mode", "live");
    await store.setItemAsync("mymail.pushToken", "ExponentPushToken[abc]");
    await kv().set("list:inbox", "[]");
    await kv().set("task:TSK-1", "{}");
    global.fetch = jest.fn(async (url: string, init: { method: string; body?: string }) => {
      const path = url.replace(/^https:\/\/[^/]+/, "");
      calls.push({ url: path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (path.endsWith("/account/me")) return res(200, me);
      if (path === "/api/account" && init.method === "DELETE") return res(answer.status, answer.body);
      return res(404, {});
    }) as unknown as typeof fetch;
  }

  it("sends DELETE /api/account, then signs out and clears the phone", async () => {
    await signedIn();
    answer = { status: 200, body: { ok: true, deletedWorkspaces: 1 } };
    const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    await act(async () => { await result.current.deleteAccount("correct horse"); });
    expect(calls.find((c) => c.method === "DELETE")).toEqual({ url: "/api/account", method: "DELETE", body: { confirm: "DELETE", password: "correct horse" } });
    expect(result.current.status).toBe("signedOut");
    const store = require("expo-secure-store");
    expect(await store.getItemAsync("mymail.cookies")).toBeNull();
    expect(await store.getItemAsync("mymail.pushToken")).toBeNull();
    expect(await kv().keys("")).toEqual([]);
    // No call after the delete: the session is gone with the account.
    expect(calls[calls.length - 1].method).toBe("DELETE");
  });

  it("leaves out an empty password", async () => {
    await signedIn();
    answer = { status: 200, body: { ok: true, deletedWorkspaces: 0 } };
    const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    await act(async () => { await result.current.deleteAccount(""); });
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ confirm: "DELETE" });
  });

  it("keeps everything when the password is wrong", async () => {
    await signedIn();
    answer = { status: 403, body: { error: "wrong_password" } };
    const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedIn"));
    let err: unknown;
    await act(async () => { try { await result.current.deleteAccount("nope"); } catch (e) { err = e; } });
    expect((err as ApiError).code).toBe("wrong_password");
    expect(result.current.status).toBe("signedIn");
    expect(await require("expo-secure-store").getItemAsync("mymail.pushToken")).toBe("ExponentPushToken[abc]");
    expect(await kv().get("list:inbox")).toBe("[]");
  });
});

describe("delete account screen", () => {
  const DeleteAccount = () => { const S = require("@/app/delete-account").default; return <S />; };

  it("asks for DELETE and shows the server's reason in plain words", async () => {
    const store = require("expo-secure-store");
    await store.setItemAsync("mymail.cookies", JSON.stringify({ "__Secure-mymail.session_token": "sess.sig" }));
    await store.setItemAsync("mymail.mode", "live");
    global.fetch = jest.fn(async (url: string, init: { method: string }) => {
      if (url.endsWith("/account/me")) return res(200, me);
      if (url.endsWith("/api/account") && init.method === "DELETE") return res(409, { error: "transfer_ownership_first", workspaces: ["Bondi Bakehouse"] });
      return res(404, {});
    }) as unknown as typeof fetch;
    await render(<SessionProvider><DeleteAccount /></SessionProvider>);
    expect(await screen.findByText("What gets deleted")).toBeTruthy();
    expect(screen.getByTestId("confirm-delete").props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId("delete-confirm-word"), "DELETE");
    await fireEvent.changeText(screen.getByTestId("delete-password"), "pw");
    await waitFor(() => expect(screen.getByTestId("confirm-delete").props.accessibilityState.disabled).toBe(false));
    const { Alert } = require("react-native");
    const spy = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => { (buttons as { onPress?: () => void }[])[1].onPress?.(); });
    await fireEvent.press(screen.getByTestId("confirm-delete"));
    expect(await screen.findByText(/Bondi Bakehouse has other members/)).toBeTruthy();
    spy.mockRestore();
    await fireEvent.press(screen.getByTestId("delete-on-web"));
    expect(require("expo-web-browser").openBrowserAsync).toHaveBeenCalledWith("https://mymail.mymail-app.workers.dev/delete-account");
  });

  it("explains there is no account in the sample workspace", async () => {
    const { SampleTransport } = require("@/sample/transport");
    await render(<SessionProvider initialMode="sample" transportOverride={new SampleTransport()}><DeleteAccount /></SessionProvider>);
    expect(await screen.findByText(/no account to delete/)).toBeTruthy();
    expect(screen.getByTestId("leave-sample")).toBeTruthy();
    expect(screen.queryByTestId("delete-password")).toBeNull();
  });
});

