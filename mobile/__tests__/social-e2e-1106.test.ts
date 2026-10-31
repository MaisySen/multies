/**
 * @jest-environment node
 */
/**
 * 1.10.6: the phone's own API code, end to end against a local Multies server with the stand in networks (never a real
 * Page or profile). Skipped unless SOCIAL_E2E_BASE points at that server; SOCIAL_E2E_HOOK is its side door that
 * deletes a post "on Facebook", as if the person deleted it there.
 *
 *   SOCIAL_E2E_BASE=http://localhost:8977 SOCIAL_E2E_HOOK=http://localhost:8978 npx jest __tests__/social-e2e-1106.test.ts
 */
import { HttpTransport } from "@/api/transport";
import { endpoints } from "@/api/endpoints";
import { deleteConfirm, deleteMessage, needsDeleteNote, resultTitle, socialErrorText, stillSending, syncIds, targetChip, type SocialPostView } from "@/lib/social";

const BASE = process.env.SOCIAL_E2E_BASE;
const HOOK = process.env.SOCIAL_E2E_HOOK;
const run = BASE ? describe : describe.skip;
jest.setTimeout(480_000);

run("Social end to end with the phone's API code", () => {
  let jar: Record<string, string> = {};
  // The test setup replaces fetch, so this talks HTTP with Node's own client.
  const nodeFetch = ((url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise((resolve, reject) => {
    const http = require("node:http") as typeof import("node:http");
    const req = http.request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { text += c; });
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        resolve({
          ok: status >= 200 && status < 300, status,
          headers: { get: (n: string) => { const v = res.headers[n.toLowerCase()]; return v === undefined ? null : Array.isArray(v) ? v.join(", ") : String(v); } },
          text: async () => text, json: async () => JSON.parse(text),
        });
      });
    });
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  })) as unknown as typeof fetch;
  const t = new HttpTransport({ get: () => jar, set: (j) => { jar = j; } }, () => {}, BASE!, nodeFetch);
  const api = endpoints(t);
  let fbId = "", liId = "", page = { id: "", name: "" };
  const log: string[] = [];

  const settle = async (id: string) => {
    for (let i = 0; i < 40; i++) {
      const p = (await api.socialPost(id)).post;
      if (!stillSending(p)) return p;
      await new Promise((r) => setTimeout(r, 750));
    }
    throw new Error("post never settled");
  };
  const postNow = async (text: string) => {
    const r = await api.createSocialPost({ text, targets: [{ accountId: fbId, target: page.id, targetName: page.name }, { accountId: liId }] }, `e2e-${Date.now()}-${Math.random()}`);
    return settle(r.post.id);
  };

  afterAll(() => { console.log(log.join("\n")); });

  it("opens a demo workspace and connects Facebook and LinkedIn through the stand in", async () => {
    await t.request("POST", "/account/demo", {});
    for (const app of ["facebook", "linkedin"]) {
      const c = await api.connectApp(app);
      await api.confirmApp(c.accountId);
    }
    const accounts = (await api.appAccounts()).accounts;
    fbId = accounts.find((a) => a.app === "facebook")!.id;
    liId = accounts.find((a) => a.app === "linkedin")!.id;
    page = (await api.appTargets(fbId)).targets[0]!;
    expect(page.id).toBeTruthy();
    log.push(`connected facebook ${fbId} (page ${page.name}), linkedin ${liId}`);
  });

  let a: SocialPostView;
  let b: SocialPostView;
  it("posts to both, and the result reads as the phone shows it", async () => {
    a = await postNow("Phone check one");
    // Post B is for the "deleted on Facebook" check at the end: the server checks a post at most once per 5 minutes
    // and counts the send itself as a check, so B is posted now and checked after 5 minutes.
    b = await postNow("Phone check two");
    expect(resultTitle(a)).toBe("Posted to all 2 accounts");
    const fb = a.targets.find((x) => x.app === "facebook")!;
    const li = a.targets.find((x) => x.app === "linkedin")!;
    expect(fb.url).toMatch(/^https:\/\/www\.facebook\.com\/\d+\/posts\//);
    expect(fb.canCheck).toBe(true);
    expect(fb.canDelete).toBe(true);
    expect(li.canCheck).toBe(false);
    expect(needsDeleteNote(li)).toBe(true);
    log.push(`post A: "${resultTitle(a)}", Facebook link ${fb.url}`);
  });

  it("checks the post with Facebook: still there", async () => {
    expect(syncIds([a])).toEqual([a.id]);
    const r = await api.syncSocialPosts([a.id]);
    const fb = r.posts[0]!.targets.find((x) => x.app === "facebook")!;
    expect(fb.networkState).toBe("live");
    expect(fb.checkedAt).toBeTruthy();
    log.push(`post A checked: ${fb.networkState} at ${fb.checkedAt}`);
  });

  it("Delete in Multies deletes on Facebook and LinkedIn and the post leaves the list", async () => {
    expect(deleteConfirm(a).button).toBe("Delete from Facebook and LinkedIn");
    const del = await api.deleteSocialPost(a.id);
    expect(del.deleted).toBe(true);
    expect(deleteMessage(del).text).toBe("Post deleted from Facebook and LinkedIn");
    const list = (await api.socialPosts()).posts;
    expect(list.find((p) => p.id === a.id)).toBeUndefined();
    log.push(`post A: delete -> ${JSON.stringify(del.results.map((x) => x.outcome))}, gone from the list`);
  });

  it("one network turning the post down shows its own reason and the partial title", async () => {
    const c = await postNow("FAIL on purpose for the phone check");
    log.push(`post C: "${resultTitle(c)}"; ${c.targets.map((x) => `${x.app} ${x.status}${x.error ? ` (${socialErrorText(x.error).text})` : ""}`).join(", ")}`);
    expect(["Posted to 1 of 2 accounts", "Not posted"]).toContain(resultTitle(c));
    const failed = c.targets.find((x) => x.status === "failed")!;
    expect(socialErrorText(failed.error).text.length).toBeGreaterThan(10);
    await api.deleteSocialPost(c.id).catch(() => null);
  });
  it("a post deleted on Facebook shows Removed on Facebook after the next check, and Delete then names only LinkedIn", async () => {
    const fb = b.targets.find((x) => x.app === "facebook")!;
    const objId = decodeURIComponent(fb.url!.split("/posts/")[1]!);
    expect(HOOK).toBeTruthy();
    for (const id of [objId, `${page.id}_${objId}`]) {
      const h = await (await nodeFetch(HOOK!, { method: "POST", body: JSON.stringify({ accountId: fbId, objId: id }) })).json();
      log.push(`deleted on the Facebook stand in (${id}): ${JSON.stringify((h as { answer?: unknown }).answer)}`);
    }
    // Within 5 minutes of the last check the server does not ask again: the post still reads live.
    const early = (await api.syncSocialPosts([b.id])).posts[0]!.targets.find((x) => x.app === "facebook")!;
    log.push(`post B right after the delete on Facebook: ${early.networkState} (held to one check per 5 minutes)`);
    const sentAt = Date.parse(fb.checkedAt ?? fb.sentAt!);
    const wait = sentAt + 5 * 60_000 + 3000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const synced = (await api.syncSocialPosts([b.id])).posts[0]!;
    const fb2 = synced.targets.find((x) => x.app === "facebook")!;
    expect(fb2.networkState).toBe("removed");
    expect(fb2.url).toBeNull();
    expect(targetChip(fb2).label).toBe("Removed on Facebook");
    expect(deleteConfirm(synced).button).toBe("Delete from LinkedIn");
    const del = await api.deleteSocialPost(b.id);
    expect(del.deleted).toBe(true);
    expect(del.results.map((x) => [x.app, x.outcome])).toEqual(expect.arrayContaining([["facebook", "already_gone"], ["linkedin", "deleted"]]));
    expect(deleteMessage(del).text).toBe("Post deleted from Facebook and LinkedIn");
    log.push(`post B after the next check: ${fb2.networkState}, link ${fb2.url}; delete -> ${JSON.stringify(del.results.map((x) => x.outcome))} "${deleteMessage(del).text}"`);
  });
});
