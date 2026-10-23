import { HttpTransport } from "@/api/transport";
import { endpoints } from "@/api/endpoints";
import type { Jar } from "@/lib/cookies";

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } } as unknown as Response;
}

function setup(responses: (Response | Error)[]) {
  let jar: Jar = {};
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next!;
  }) as unknown as typeof fetch;
  const onUnauthorised = jest.fn();
  const t = new HttpTransport({ get: () => jar, set: (j) => { jar = j; } }, onUnauthorised, "https://api.test", fetchImpl);
  return { t, api: endpoints(t), calls, onUnauthorised, jar: () => jar };
}

describe("HttpTransport", () => {
  it("keeps the session cookie from sign in and sends it with the API origin", async () => {
    const s = setup([
      res(200, { redirect: false }, { "set-cookie": "__Secure-mymail.session_token=tok.sig; Path=/; HttpOnly" }),
      res(200, { user: { email: "a@b.au" }, organization: null }),
    ]);
    await s.api.signIn("a@b.au", "pw");
    await s.api.me();
    expect(s.calls[0].url).toBe("https://api.test/api/auth/sign-in/email");
    const h = s.calls[1].init.headers as Record<string, string>;
    expect(h.cookie).toBe("__Secure-mymail.session_token=tok.sig");
    expect(h.origin).toBe("https://api.test");
    expect(s.calls[1].init.credentials).toBe("omit");
  });

  it("reads both error shapes and uses friendly words", async () => {
    const s = setup([res(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }), res(400, { error: { code: "bad_request", message: "Add a recipient" } })]);
    await expect(s.api.signIn("a@b.au", "x")).rejects.toMatchObject({ status: 401, message: "That email and password don't match." });
    await expect(s.api.send({ mailboxId: "m", to: [], subject: "", text: "" }, "k")).rejects.toMatchObject({ status: 400, code: "bad_request", message: "Add a recipient" });
    expect(s.onUnauthorised).not.toHaveBeenCalled();
  });

  it("signals a lost session on a 401 from the app API", async () => {
    const s = setup([res(401, { error: { code: "unauthorized", message: "Sign in to continue." } })]);
    await expect(s.api.me()).rejects.toMatchObject({ status: 401 });
    expect(s.onUnauthorised).toHaveBeenCalledTimes(1);
  });

  it("retries a read once after a dropped connection, then reports being offline", async () => {
    const ok = setup([new TypeError("Network request failed"), res(200, { mailboxes: [] })]);
    await expect(ok.api.overview()).resolves.toEqual({ mailboxes: [] });
    const down = setup([new TypeError("x"), new TypeError("x")]);
    await expect(down.api.overview()).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("sends an idempotency key with Send so a retry never sends twice", async () => {
    const s = setup([res(201, { messageId: "m1" })]);
    await s.api.send({ mailboxId: "mbx", to: ["x@y.au"], subject: "Hi", text: "Hello" }, "key-1");
    expect((s.calls[0].init.headers as Record<string, string>)["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(String(s.calls[0].init.body))).toMatchObject({ mailboxId: "mbx", to: ["x@y.au"] });
  });

  it("builds query strings for mail lists and approvals", async () => {
    const s = setup([res(200, { messages: [], nextCursor: null }), res(200, { approvals: [] })]);
    await s.api.messages({ folder: "inbox", q: "invoice due", cursor: "123.abc" });
    await s.api.approvals("pending");
    expect(s.calls[0].url).toBe("https://api.test/api/mail/messages?folder=inbox&q=invoice%20due&cursor=123.abc&limit=40");
    expect(s.calls[1].url).toBe("https://api.test/api/approvals?status=pending");
  });
});
