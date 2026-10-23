import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { endpoints, type Api } from "@/api/endpoints";
import { HttpTransport, type Transport } from "@/api/transport";
import { SampleTransport } from "@/sample/transport";
import { hasSession, type Jar } from "./cookies";
import { secureStorage } from "./storage";
import { kv } from "./kv";
import type { Me } from "@/api/types";

export type Status = "loading" | "signedOut" | "twoFactor" | "signedIn";
export type Mode = "live" | "sample";

const JAR_KEY = "mymail.cookies";
const MODE_KEY = "mymail.mode";

interface SessionValue {
  status: Status;
  mode: Mode;
  api: Api;
  transport: Transport;
  me: Me | null;
  signIn(email: string, password: string): Promise<"done" | "twoFactor">;
  verifyTwoFactor(code: string, opts: { backup: boolean; trustDevice: boolean }): Promise<void>;
  startSample(): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(password: string): Promise<void>;
  refreshMe(): Promise<void>;
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

  const clearLocal = useCallback(async () => {
    jarRef.current = {};
    await secureStorage.remove(JAR_KEY).catch(() => {});
    await secureStorage.remove(MODE_KEY).catch(() => {});
    await kv().clear("list:").catch(() => {});
    await kv().clear("thread:").catch(() => {});
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
        // Offline at launch with a saved session: open the app on cached mail.
        if (!cancelled) setStatus((err as { status?: number }).status === 0 ? "signedIn" : "signedOut");
      }
    })();
    return () => { cancelled = true; };
  }, [initialMode, live, sample, transportOverride]);

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
      if (mode === "live") await endpoints(live).signOut().catch(() => {});
      await clearLocal();
      setMode("live");
      setStatus("signedOut");
    },
    async deleteAccount(password) {
      if (mode === "sample") { await clearLocal(); setMode("live"); setStatus("signedOut"); return; }
      await endpoints(live).deleteAccount(password);
      await clearLocal();
      await kv().clear().catch(() => {});
      setStatus("signedOut");
    },
    async refreshMe() { setMe(await api.me()); },
  }), [status, mode, api, transport, me, live, sample, clearLocal]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession needs SessionProvider");
  return v;
}
