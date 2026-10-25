/**
 * Makes a real mailbox with an app password on the local Stalwart test server, for the connected
 * mailbox E2E (e2e/connect-mailbox.spec.ts). Prints {"user","pass"} as JSON. Run with tsx; needs the
 * STALWART_TEST_* variables (tests/stalwart.live.test.ts). Local only.
 */
import { makeTestApp, Client } from "../../tests/helpers";

const env = process.env;
const host = await makeTestApp({ STALWART_URL: env.STALWART_TEST_URL!, STALWART_ADMIN_USER: env.STALWART_TEST_ADMIN_USER!, STALWART_ADMIN_SECRET: env.STALWART_TEST_ADMIN_SECRET! }, { fetch: globalThis.fetch.bind(globalThis) });
const c = new Client(host.app);
await c.signup();
await c.post("/api/org/plan", { plan: "pro" });
const domain = `e${Date.now().toString(36)}.mymail.test`;
const domainId = (await c.post("/api/domains", { name: domain })).body.domain.id;
const mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: process.argv[2] ?? "ada", displayName: "Ada Lovelace" })).body.mailbox.id;
const made = await c.post(`/api/mail-access/mailboxes/${mailboxId}/app-passwords`, { name: "Multies E2E" });
if (made.status !== 201) throw new Error(`app password: ${made.status}`);
process.stdout.write(JSON.stringify({ user: made.body.username, pass: made.body.secret }));
