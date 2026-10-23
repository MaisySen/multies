# Push notifications

## What works now, with nothing from the owner

- The app asks for permission from Settings and sets up two Android channels: New mail and
  Agent approvals.
- While the app is open or recently backgrounded it checks approvals every 30 seconds and raises a
  local notification for each new request. Tapping it opens Approvals.
- Expo push tokens are fetched as soon as an EAS project id exists (`extra.eas.projectId` in
  app.json, written by `npx eas-cli init`).

## What real push needs

| Piece | Who | Cost |
| --- | --- | --- |
| EAS project (free Expo account) | owner, or Tab with the owner's OK | free |
| APNs key (.p8) for iOS | owner, from the Apple Developer account | part of A$149 a year membership |
| Firebase project and `google-services.json` for Android (FCM) | owner's Google account | free |
| API endpoint and sender (below) | builder | free: Expo's push service has no charge |

`eas credentials` uploads the APNs key and the FCM key once; after that Expo's push service
delivers to both platforms from one HTTP call.

## Server side (small, isolated, behind config)

Not merged into the API on purpose: it needs a D1 migration and the round 5 builder is changing
the schema on main right now. Add it after that lands.

Migration:

```sql
CREATE TABLE push_devices (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX push_devices_org ON push_devices(org_id);
```

Routes (`src/server/routes/push.ts`, cookie session, enabled when `PUSH_ENABLED=1`):

```ts
export function pushRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .post("/devices", async (c) => {
      const { token, platform } = await parseBody(c, z.object({ token: z.string().startsWith("ExponentPushToken["), platform: z.enum(["ios", "android"]) }));
      const now = c.var.deps.now();
      await c.var.deps.db.insert(pushDevices).values({ token, userId: c.var.auth.userId, orgId: c.var.auth.orgId, platform, createdAt: now, lastSeenAt: now })
        .onConflictDoUpdate({ target: pushDevices.token, set: { userId: c.var.auth.userId, orgId: c.var.auth.orgId, lastSeenAt: now } });
      return c.json({ ok: true }, 201);
    })
    .delete("/devices/:token", async (c) => { /* delete where token and userId match */ return c.json({ ok: true }); });
}
```

Sender (`services/push.ts`), called from the inbound mail handler and from `createApproval`, as a
job on the existing D1 queue so a slow push never slows mail:

```ts
export async function sendPush(deps: Deps, orgId: string, msg: { title: string; body: string; url: string; channelId: "mail" | "approvals" }) {
  const devices = await deps.db.select().from(pushDevices).where(eq(pushDevices.orgId, orgId));
  if (!devices.length) return;
  const res = await deps.fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...(deps.config.expoAccessToken ? { authorization: `Bearer ${deps.config.expoAccessToken}` } : {}) },
    body: JSON.stringify(devices.map((d) => ({ to: d.token, title: msg.title, body: msg.body, data: { url: msg.url }, channelId: msg.channelId, sound: "default" }))),
  });
  // Remove tokens Expo reports as DeviceNotRegistered.
}
```

Then turn on `EXPO_PUBLIC_FEATURE_PUSH_SERVER=1` in eas.json for the next build.

Privacy: the push body carries the sender and subject only, never the message text, and members
only get pushes for mailboxes they can open (filter devices by `mailboxScope`).
