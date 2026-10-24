# Moving to multies.si (owner steps first)

The product is called Multies. The app still runs at https://mymail.mymail-app.workers.dev until the domain is ready.

## What the owner does (about 10 minutes, then waiting for DNS)

1. Sign in to Cloudflare and choose Add a domain. Enter `multies.si` and pick the Free plan.
2. Cloudflare shows two nameservers. At the .si registrar, replace the current nameservers with those two.
3. Wait for Cloudflare to say the domain is active. This usually takes under an hour, sometimes up to a day.

## What we do once it is active

1. Attach the Worker to `multies.si` (and `www.multies.si` as a redirect) as a custom domain, then set `APP_URL` and the trusted origins to the new address.
2. Set up mail on the domain: MX, SPF, DKIM and DMARC records, and the system sender (`no-reply@multies.si`), then check delivery with the deliverability page.
3. Move canonical, Open Graph and sitemap URLs to the new address and redirect the old workers.dev address to it.
4. Update the mobile app's API address in the next app release.

Internal names (the Worker, the database, environment variables and the repository) keep the `mymail` name. Nobody outside sees them.
