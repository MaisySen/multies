# Vendored API reference renderer

`public/vendor/scalar-api-reference-1.76.0.js` (served at `/vendor/scalar-api-reference-1.76.0.js`, see `SCALAR_ASSET` in `src/server/lib/security-headers.ts`) is about 4.9 MB, too large for one request to the code host. It is kept here as one gzip stream split into parts, with its sha256.

`scripts/restore-vendor.mjs` runs first in `build:web` and `dev:web`: it joins the parts, gunzips them with Node zlib, checks the sha256 and writes the exact original bytes to `public/vendor/` (ignored by git). A mismatch fails the build.

To upgrade: put the new file at `public/vendor/scalar-api-reference-<version>.js`, bump `SCALAR_VERSION`, then run `node scripts/restore-vendor.mjs --pack <version>`.
