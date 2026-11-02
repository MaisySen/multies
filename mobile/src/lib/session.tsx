import { registerWebTransport } from "./web-transport";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { endpoints, type Api } from "@/api/endpoints";
import { HttpTransport, type Transport } from "@/api/transport";
import { SampleTransport } from "@/sample/transport";
import { hasSession, type Jar } from "./cookies";
import { secureStorage } from "./storage";
import { kv } from "./kv";
import type { Me } from "@/api/types";
import { JAR_KEY, MODE_KEY } from "./session-keys";
import { registerPush, unregisterPush } from "./push";
import { LEGACY_KEY } from "./tasks";
import { signInAtIdp } from "./idp";
import { verdictFor } from "./auth-keep";
import { AppState } from "react-native";
import { clearLock } from "./app-lock";

export type Status = "loading" | "signedOut" | "twoFactor" | "signedIn";
export type Mode = "live" | "sample";


interface SessionValue {
  status: Status;
  mode: Mode;
  api: Api;
  transport: Transport;
  me: Me | null;
  signIn(email: string, password: string): Promise<"done" | "twoFactor">;
  /** Signs in (or creates an account) on the Multies sign in page in the system browser. */
  signInWithIdp(mode?: "signin" | "signup"): Promise<void>;
  verifyTwoFactor(code: string, opts: { backup: boolean; trustDevice: boolean }): Promise<void>;
  startSample(): Promise<void>;
  signOut(): Promise<void>;
  /** Deletes the account (live) or clears the sample workspace from this phone. Throws ApiError on failure. */
  deleteAccount(password?: string): Promise<void>;
  refreshMe(): Promise<void>;
  /** Multiws: moves this phone to another workspace of this person's. Throws ApiError on failure. */
  switchWorkspace(id: string): Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children, initialMode, transportOverride }: { children: ReactNode; initialMode?: Mode; transportOverride?: Transport }) {
  const [status, setStatus] = useState<Status>("loading");
  const [mode, setMode] = useState<Mode>(initialMode ?? "live");
  const [me, setMe] = useState<Me | null>(null);
  const jarRef = useRef<Jar>({});

  const signedOutRef = useRef<() => void>(() => {});
  const live = useMemo(() => new HttpTransport({
    get: () => jarRef.current,
    set: (j) => { jarRef.current = j; secureStorage.set(JAR_KEY, JSON.stringify(j)).catch(() => {}); },
  }, () => signedOutRef.current()), []);
  const sample = useMemo(() => new SampleTransport(), []);
  const transport: Transport = transportOverride ?? (mode === "sample" ? sample : live);
  const api = useMemo(() => endpoints(transport), [transport]);
  // M3 (1.10.11): web app pages opened from anywhere use this session, signed in (never in the sample workspace).
  useEffect(() => { registerWebTransport(mode === "live" && !transportOverride ? transport : null); }, [mode, transport, transportOverride]);

  const clearLocal = useCallback(async () => {
    jarRef.current = {};
    await secureStorage.remove(JAR_KEY).catch(() => {});
    await secureStorage.remove(MODE_KEY).catch(() => {});
    // Nothing from one account stays on the phone for the next one.
    for (const prefix of ["list:", "thread:", "meta:", "task:", "worklist:", "queue:", LEGACY_KEY]) await kv().clear(prefix).catch(() => {});
    setMe(null);
  }, []);

  signedOutRef.current = () => { if (mode === "live") { clearLocal(); setStatus("signedOut"); } };

  // Restore a saved session at launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (initialMode === "sample" || transportOverride) {
        const t = endpoints(transportOverride ?? sample);
        const who = await t.me().catch(() => null);
        if (!cancelled) { setMe(who); setStatus(who ? "signedIn" : "signedOut"); }
        return;
      }
      const savedMode = (await secureStorage.get(MODE_KEY).catch(() => null)) as Mode | null;
      if (savedMode === "sample") { setMode("sample"); setMe(await endpoints(sample).me()); setStatus("signedIn"); return; }
      const raw = await secureStorage.get(JAR_KEY).catch(() => null);
      jarRef.current = raw ? (JSON.parse(raw) as Jar) : {};
      if (!hasSession(jarRef.current)) { if (!cancelled) setStatus("signedOut"); return; }
      try {
        const who = await endpoints(live).me();
        if (!cancelled) { setMe(who); setStatus("signedIn"); }
      } catch (err) {
        // R33: offline, a timeout or a busy server at launch keeps the saved session and opens the
        // app on cached mail. Only a definite answer that the session is gone signs out (the
        // transport already asked for a fresh session before giving that answer).
        if (!cancelled) setStatus(verdictFor(err, true) === "signOut" ? "signedOut" : "signedIn");
      }
    })();
    return () => { cancelled = true; };
  }, [initialMode, live, sample, transportOverride]);

  // R33: renew the session before it runs out, at launch and each time the app comes back.
  useEffect(() => {
    if (status !== "signedIn" || mode !== "live" || transportOverride) return;
    live.refreshIfDue().catch(() => {});
    const sub = AppState.addEventListener?.("change", (s) => { if (s === "active") live.refreshIfDue().catch(() => {}); });
    return () => sub?.remove();
  }, [status, mode, live, transportOverride]);

  // Once signed in (and at each launch, as tokens can change), register this phone for push if
  // notifications are already allowed. Never prompts here: the Settings button does that.
  useEffect(() => {
    if (status !== "signedIn" || mode !== "live" || transportOverride) return;
    registerPush(endpoints(live)).catch(() => {});
  }, [status, mode, live, transportOverride]);

  const value = useMemo<SessionValue>(() => ({
    status, mode, api, transport, me,
    async signIn(email, password) {
      setMode("live");
      jarRef.current = {};
      const res = await endpoints(live).signIn(email.trim().toLowerCase(), password);
      if (res?.twoFactorRedirect) { setStatus("twoFactor"); return "twoFactor"; }
      const who = await endpoints(live).me();
      await secureStorage.set(MODE_KEY, "live");
      setMe(who); setStatus("signedIn");
      return "done";
    },
    async signInWithIdp(mode = "signin") {
      setMode("live");
      jarRef.current = {};
      const { idToken, nonce } = await signInAtIdp(mode);
      const e = endpoints(live);
      await e.exchangeIdToken(idToken, nonce); // the session cookie lands in the SecureStore jar
      const who = await e.me();
      await secureStorage.set(MODE_KEY, "live");
      setMe(who); setStatus("signedIn");
    },
    async verifyTwoFactor(code, { backup, trustDevice }) {
      const e = endpoints(live);
      const clean = backup ? code.trim() : code.replace(/\D/g, "");
      if (backup) await e.verifyBackupCode(clean); else await e.verifyTotp(clean, trustDevice);
      const who = await e.me();
      await secureStorage.set(MODE_KEY, "live");
      setMe(who); setStatus("signedIn");
    },
    async startSample() {
      sample.reset();
      setMode("sample");
      await secureStorage.set(MODE_KEY, "sample").catch(() => {});
      setMe(await endpoints(sample).me());
      setStatus("signedIn");
    },
    async signOut() {
      if (mode === "live") {
        // Remove this phone's push token while the session still works, then end the session.
        await unregisterPush(endpoints(live)).catch(() => {});
        await endpoints(live).signOut().catch(() => {});
      }
      await clearLocal();
      await clearLock().catch(() => {}); // M4: a PIN belongs to the person who set it
      setMode("live");
      setStatus("signedOut");
    },
    async deleteAccount(password) {
      if (mode === "sample") { await clearLocal(); setMode("live"); setStatus("signedOut"); return; }
      await endpoints(live).deleteAccount(password || undefined);
      // The server removed the account with its push devices and ended the session. Forget this
      // phone's token and every cached item without calling the server again.
      await unregisterPush(null).catch(() => {});
      await clearLocal();
      await kv().clear().catch(() => {});
      setStatus("signedOut");
    },
    async refreshMe() { setMe(await api.me()); },
    async switchWorkspace(id) {
      if (me?.organization?.id === id) return;
      await api.switchWorkspace(id);
      // Mail, tasks and lists saved on this phone belong to the workspace just left.
      for (const prefix of ["list:", "thread:", "meta:", "task:", "worklist:"]) await kv().clear(prefix).catch(() => {});
      setMe(await api.me());
    },
  }), [status, mode, api, transport, me, live, sample, clearLocal]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession needs SessionProvider");
  return v;
}
