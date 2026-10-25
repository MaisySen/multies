/**
 * Round 18 check, run under wrangler dev (workerd): the SMTP client and the cloudflare:sockets
 * adapter against a real provider, with a wrong password. Expected: an auth error (535), which
 * proves TLS on 465, STARTTLS on 587, EHLO and AUTH work on Workers. Not deployed anywhere.
 */
import { smtpVerify, SmtpError } from "../src/server/services/connect/smtp";
import { workerSocketOpener } from "../src/entry/worker-socket";
import { classifyProblem } from "../src/server/services/connect/problems";

export default {
  async fetch(req: Request) {
    const u = new URL(req.url);
    const host = u.searchParams.get("h") ?? "smtp.gmail.com";
    const port = Number(u.searchParams.get("p") ?? 465);
    const security = port === 465 ? "tls" as const : "starttls" as const;
    try {
      await smtpVerify(workerSocketOpener, { host, port, security }, { user: "multies.check@gmail.com", secret: "not-a-real-password" });
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ stage: e instanceof SmtpError ? e.stage : null, code: e instanceof SmtpError ? e.code : null, problem: classifyProblem(e, "smtp", "gmail", host) });
    }
  },
};
