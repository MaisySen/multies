# Mnet device-list bridge, isolated branch

This is separate-branch work, not a deployment plan. No live configuration or
existing browser/mobile/MCP sign-in flow has been changed. `MNET_DEVICE_BRIDGE`
must be exactly `on` to expose these APIs. It is off by default.

## Scope and trust

Only a currently verified, unbanned human with an existing eligible workspace
membership and non-impersonated live session can approve. Demo/suspended
workspaces, disabled/agent membership and a missing required SSO method refuse.
The existing owner SSO exception is preserved. Approval binds that exact session,
workspace membership record, platform, device-key thumbprint, native PKCE
challenge, state and literal IPv4 loopback callback. It does not bootstrap or
join a workspace. If a membership is removed, pending approvals, issued codes
and active credentials from that membership are unusable, including after
rejoining. Approvals created before migration 0177 require fresh approval.

**List only.** The handoff binds a supplied thumbprint to native PKCE possession,
not to possession of a WireGuard private key. Never treat it as VPN enrollment,
network connectivity or a screen/input/file/recording grant. Network registration
needs its own device-key proof and registrar. Other people's devices are excluded.
No mobile callback is implemented. The desktop callback has a fixed path and an
ephemeral unprivileged port, never a caller-chosen external origin or path.

## Journey

1. The native app binds its listener and creates fresh state and S256 proof.
2. `/mnet/authorize` shows the current account, exact native thumbprint, eligible
   existing workspace choices and list-only limits. A person explicitly chooses
   a workspace and approves, or cancels back to the native listener.
3. A pending record lives 120 seconds. A terminal allow/decline transition is
   session-bound. A code can be exchanged once with its exact original binding.
4. The native exchange returns a 10 minute audience-specific credential, never a
   browser session, cookie or MCP token. Only hashes are stored.
5. `/api/mnet/check` checks a single List operation live and returns evidence
   lasting at most 30 seconds. It refuses enrollment and remote-session actions.
   `/api/mnet/devices` returns the person's own currently eligible records.
6. In Multies, open Settings, Account and security, then Manage Mnet approvals.
   `/mnet/devices` lists current approvals and lets their owner revoke them.
   Live account/session/membership checks also remove eligibility after changes.

## Bounds and concurrency

- Request bodies are streamed with an 8192 byte ceiling before JSON parsing.
- Query multiplicity and unknown object fields refuse.
- Existing CSRF protections stay in place; native exchange/check reject cookies
  and Origin. No cookie or redirect exemption was added.
- Approval/exchange use conditional updates with fresh correlated eligibility
  in the same SQL statement. Only one exchange wins.
- Current handoffs cap at 20 per person atomically, without evicting another
  unexpired attempt. A person's records expired over 24 hours ago prune when
  they start another handoff. The shared existing rate limiter also applies.
- Lists cap at 100 with an explicit truncated flag. The device read checks the
  caller's eligibility and each listed record's source session and membership
  in the same database statement.
- Decision and revocation audit rows carry IDs/actions, never raw codes,
  credentials, native proofs or callback URLs.

## Local evidence and limits

Focused full-app HTTP tests exercise real migrations, auth sessions and SQLite
with the existing D1 bound-variable guard. Existing MCP OAuth, mobile handoff and
session regression tests are checked separately. Strict server and frontend
entry-point typechecks pass. The full repository/test graph exceeds the local
2GB memory ceiling and remains unverified; a passing narrow check is not a full
repository typecheck.

Actual Chrome approval/revoke pages are visually inspected at desktop and narrow
widths. A real Go transport plus this real local app exercises callback, exchange,
fresh list evidence and revocation. An exact-SHA private engineering installation
also exercises a fresh stopped daemon -> private local key preparation -> actual
installed CLI -> captured system-opener argv -> Chrome approval -> list-only
snapshot. The capture replaces the browser-launch boundary only; it is not a
normal installed GUI journey or a deployed production flow.

No merge, release, production/staging migration, deployment, signing, TestFlight,
account change or paid infrastructure is covered by these local checks.

The local D1 rehearsal starts with migrations through 0176 and an existing
approval, applies 0177, then checks fresh approval, exchange, listing and
membership removal. The new column allows the previous schema's writes. Turn
the bridge off before rolling back to a server version that does not check
membership binding.

The signed-out browser journey also goes through the real local Multies login
form, then returns to the exact approval request. Only `/mnet/authorize?` and
exact `/mnet/devices` were added to the existing safe post-login destinations;
other Mnet paths and external origins remain excluded.

## Browser read freshness

The authorization and approved-device pages use a new query identity for each
mount and discard it on unmount. They do not render an earlier mount's cached
person, workspace or device rows before a new authenticated read. Device rows
also disappear during refresh, while revoke is pending, or after a refused
refresh. Check again performs a new read; it does not reuse approval evidence.
Revoke settles by checking the server again, including after a failed response.

Two failing-first rendered-page regressions reproduce the former shared-cache
behavior and pass with private mount keys. A local real-browser check approves
and exchanges normally, then injects a refused approved-device refresh. During
the request and after refusal no old rows or revoke buttons remain. Restoring
the server and choosing Check again restores the current rows, and actual
revocation still denies the old native credential. Desktop and390pxphone denied
and recovered states were inspected. This is local fixture evidence, not a live
account disclosure or a production deployment.

## Dedicated request JSON ambiguity guard

The isolated bridge now rejects duplicate decoded JSON keys before the strict
request schema and before preparation, decision or token consumption. This
includes escaped aliases, such as a key containing a Unicode escape which
decodes to an earlier key. JSON.parse alone silently kept the final value; two
failing-first actual route tests reproduced both an ambiguous approval decision
being accepted and an ambiguous authorization request creating a record.

The dedicated scanner is limited to this bridge. It checks object shape,
decoded-key uniqueness at every nesting level and a 16-level depth bound before
using the platform parser for final grammar and values. The route's existing
8192-byte streaming limit, fatal UTF-8 decode, strict purpose schema, browser
session checks and one-use state transitions remain. No capability, schema
field, audience or endpoint was added. The normal browser/native JSON remains
unchanged.

Route regressions require ambiguous approval to leave its row pending,
ambiguous token exchange to leave the valid code usable, and ambiguous or
nonobject preparation to create no row. Parser tests cover nested/escaped keys,
malformed/trailing tokens, string escapes, huge depth, 2000 deterministic valid
objects against platform values and deterministic token mutations. These are
bounded regression/property checks, not a security review or fuzzing claim.
