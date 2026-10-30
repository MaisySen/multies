import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SessionProvider, useSession } from "@/lib/session";

function res(status: number, body: unknown, setCookie?: string) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: (k: string) => (k.toLowerCase() === "set-cookie" ? setCookie ?? null : null) } };
}

const me = { user: { id: "u", email: "owner@shop.com.au", name: "Owner", emailVerified: true, twoFactor: true, platformAdmin: false }, organization: null };

describe("sign in with two step verification", () => {
  it("asks for the code, then signs in", async () => {
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push(`${url.replace(/^https:\/\/[^/]+/, "")} ${init.headers.cookie ?? "-"}`);
      if (url.endsWith("/sign-in/email")) return res(200, { twoFactorRedirect: true }, "mymail.two_factor=pending; Path=/; Max-Age=600");
      if (url.endsWith("/two-factor/verify-totp")) return res(200, { token: "t" }, "__Secure-mymail.session_token=sess.sig; Path=/, mymail.two_factor=; Max-Age=0");
      if (url.endsWith("/account/me")) return res(200, me);
      return res(404, {});
    }) as unknown as typeof fetch;

    const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedOut"));

    let step: string | undefined;
    await act(async () => { step = await result.current.signIn("Owner@Shop.com.au", "correct horse"); });
    expect(step).toBe("twoFactor");
    expect(result.current.status).toBe("twoFactor");

    await act(async () => { await result.current.verifyTwoFactor("123 456", { backup: false, trustDevice: true }); });
    expect(result.current.status).toBe("signedIn");
    expect(result.current.me?.user.email).toBe("owner@shop.com.au");
    expect(calls).toEqual([
      "/api/auth/sign-in/email -",
      "/api/auth/two-factor/verify-totp mymail.two_factor=pending",
      "/api/account/me __Secure-mymail.session_token=sess.sig",
    ]);
  });

  it("opens the sample workspace without a server", async () => {
    const store = require("expo-secure-store");
    await store.deleteItemAsync("mymail.cookies");
    await store.deleteItemAsync("mymail.mode");
    global.fetch = jest.fn() as unknown as typeof fetch;
    const wrapper = ({ children }: { children: ReactNode }) => <SessionProvider>{children}</SessionProvider>;
    const { result } = await renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("signedOut"));
    await act(async () => { await result.current.startSample(); });
    expect(result.current.status).toBe("signedIn");
    expect(result.current.mode).toBe("sample");
    expect(result.current.me?.organization?.name).toBe("Harbour Coffee Co");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
