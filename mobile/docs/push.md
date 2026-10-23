# Push notifications

## How it works

1. After sign in (and at each launch), if notifications are already allowed, the app gets this
   phone's Expo push token and sends it to `POST /api/push/devices { token, platform }`. The
   Settings button asks for permission first and then does the same. The app never prompts on its
   own.
2. At sign out the app calls `DELETE /api/push/devices/:token` while the session still works, then
   ends the session.
3. A push from the server carries only `{ type, id }`, never mail or task text, so nothing private
   passes through Apple, Google or Expo. The app's background task (`src/lib/push-task.ts`,
   expo-task-manager plus `Notifications.registerTaskAsync`) runs for every push, with the app
   open, in the background or closed. It fetches the item with the saved session, words the
   notification on the phone (`src/lib/push-events.ts`) and shows it on the right Android channel
   (New mail, Agent approvals, Tasks).
4. Tapping it opens the item:

| type | opens |
| --- | --- |
| `message.received` | the thread |
| `approval.requested` | the approval review screen |
| `task.assigned`, `task.commented`, `task.email_reply`, `task.due_soon` | the task |
| `automation.email` | the thread, when the id is a message |
| `automation.status` | the app (the details are on the web) |

If the item can't be fetched (offline, signed out, deleted since) the notification still shows,
with general words for its type.

5. The local fallback stays: while the app is open it checks approvals every 30 s and raises a local
   notification for new ones. It needs nothing from the owner.

## Flags

- `EXPO_PUBLIC_FEATURE_PUSH_SERVER` (default on; set to 1 in every eas.json profile). `0` turns
  off the token registration for a build.
- Harmless before the owner has set anything up: with no EAS project id the app fetches no token
  and registers nothing; with the server's `PUSH_ENABLED` off the server stores the token, answers
  `enabled: false`, and sends nothing. Settings says which.

## What real push needs from the owner

| Piece | Where | Cost |
| --- | --- | --- |
| EAS project id (free Expo account) | `npx eas-cli init` writes `extra.eas.projectId` into app.json | free |
| Firebase project and `google-services.json` (FCM v1 key uploaded with `eas credentials`) | owner's Google account | free |
| APNs key (.p8) | Apple Developer account, uploaded with `eas credentials` | part of the Apple membership |
| `PUSH_ENABLED=1` on the Worker, and optionally `EXPO_ACCESS_TOKEN` | Cloudflare | free |

Then rebuild the apps. For Android the build also needs `android.googleServicesFile` in app.json
pointing at `google-services.json` (keep the file out of git; EAS can take it as a file secret).

## Server side

Lives on main: `src/server/services/suite/push.ts`. It sends `{ to, data: { type, id }, channelId,
priority: "high", _contentAvailable: true }` to Expo's push service, which is what the app's
background task expects (data only, content-available for iOS).
