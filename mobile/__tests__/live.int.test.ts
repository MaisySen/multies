/**
 * @jest-environment node
 */
/**
 * Runs the app's real API client against a live MyMail server. Skipped unless
 * MYMAIL_LIVE_EMAIL and MYMAIL_LIVE_PASSWORD are set (never commit them):
 *   MYMAIL_LIVE_EMAIL=... MYMAIL_LIVE_PASSWORD=... npx jest live
 */
import { HttpTransport } from "@/api/transport";
import { endpoints } from "@/api/endpoints";
import type { Jar } from "@/lib/cookies";

const email = process.env.MYMAIL_LIVE_EMAIL;
const password = process.env.MYMAIL_LIVE_PASSWORD;
const base = process.env.MYMAIL_LIVE_BASE ?? "https://mymail.mymail-app.workers.dev";
const run = email && password ? it : it.skip;

/** jest-expo swaps out fetch and web streams, so the live test talks HTTPS through Node directly. */
function nodeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require("node:https") as typeof import("node:https");
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method ?? "GET", headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const setCookie = res.headers["set-cookie"];
        resolve({
          ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, text: async () => body,
          headers: { get: (k: string) => (k.toLowerCase() === "set-cookie" ? (setCookie ? setCookie.join(", ") : null) : (res.headers[k.toLowerCase()] as string) ?? null) },
        } as unknown as Response);
      });
    });
    req.on("error", reject);
    if (init.body) req.write(init.body as string);
    req.end();
  });
}

run("signs in, reads mail, approvals and agents, and signs out on the live API", async () => {
  let jar: Jar = {};
  const api = endpoints(new HttpTransport({ get: () => jar, set: (j) => { jar = j; } }, () => {}, base, nodeFetch as unknown as typeof fetch));
  const r = await api.signIn(email!, password!);
  expect(r.twoFactorRedirect).toBeFalsy();
  expect(Object.keys(jar).some((k) => k.endsWith("session_token"))).toBe(true);
  const me = await api.me();
  expect(me.user.email).toBe(email!.toLowerCase());
  const overview = await api.overview();
  expect(Array.isArray(overview.mailboxes)).toBe(true);
  const page = await api.messages({ folder: "inbox" });
  expect(Array.isArray(page.messages)).toBe(true);
  expect(Array.isArray((await api.approvals("pending")).approvals)).toBe(true);
  expect(Array.isArray((await api.agents()).agents)).toBe(true);
  await api.signOut();
  await expect(api.me()).rejects.toMatchObject({ status: 401 });
}, 180_000);
