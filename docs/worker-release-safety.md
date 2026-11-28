# Worker and browser release checks

Build and seal the actual deployable folder together:

```sh
RELEASE=<reviewed-release> npm run build:release
npm run verify:worker -- --release <reviewed-release>
```

The build writes `dist/worker/` and a separate `dist/worker-release.json`. Promote these together; never replace the Worker’s `assets/` folder using a standalone Vite build. Do not upload the seal, `dist/web/index.html`, or browser source maps to the public asset package. The seal is not signed: carry it in the same trusted CI artifact as the built Worker, never regenerate it at promotion, and keep backups of the artifact when changing production. A removed or changed Worker, sealed asset, headers file or boot file fails verification before staging or production database/deploy steps.

The manifest covers the exact Worker, headers and original asset bytes. A same-hash immutable file can be retained without replacing a sealed file. The CLI rejects unexpected new static paths, symlinks, and an HTML error/fallback page accidentally saved as JS/CSS. Legacy files fetched by the existing best-effort carry tool do not by themselves certify that the entire previous graph is there. With the last known-good release artifact in hand, check full continuity as well:

```sh
npm run verify:worker -- --previous <known-good-worker-release.json>
```

For a traffic switch where assets can propagate separately from code, retain the union of both sealed immutable asset sets in **both** versions. Introduce that union first with the last known-good server unchanged and verify before moving traffic to the new server. If vertices at the edge give inconsistent responses, hold the release; if new-code checks fail after switching, back out to the compatible build with both sets still present. The verifier checks bytes already in a package; it does not deploy or arrange that two-stage switch for you. Never substitute a 200 response on an app path or a single asset URL for real browser evidence.

Before declaring a rollout complete, open Console direct and through the old Operator link, ordinary Google sign-in, and Mail and Account & Security on desktop and mobile. In fresh sessions validate that the login form actually hydrated and that all scripts/styles loaded. Using a non-production Owner test account, check the authenticated Console in the exact candidate; do not manufacture a session or bypass two-step in production.
