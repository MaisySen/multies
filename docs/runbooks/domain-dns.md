# Domain and DNS: multies.si

The product lives on `multies.si`. Until the domain is active, the app runs at
https://mymail.mymail-app.workers.dev, and that address keeps working afterwards.

## Where things are

| Piece | Where | State (24 Oct 2026) |
| --- | --- | --- |
| Registrar | Hostinger (the owner's account) | Nameservers changed by the owner at 1:33 PM Sydney time |
| DNS | Cloudflare, Free plan, zone `multies.si` | Pending until the new nameservers reach the .si registry |
| Nameservers | `jonah.ns.cloudflare.com` and `mimi.ns.cloudflare.com` | Set at Hostinger |
| Web Analytics | Cloudflare Web Analytics site for `multies.si` | Set up; the beacon token is a Worker variable |

The zone id, the beacon token and the API token are in "CREDENTIALS (owner email v7)", Cloudflare section.

## Check the zone

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=multies.si" | jq '.result[0].status'
dig +short NS multies.si
```

`"active"` means Cloudflare serves the domain. .si delegations usually move within an hour, sometimes
up to a day.

## Once the zone is active

1. **Custom domains on the Worker.** Attach `multies.si` and `app.multies.si` (or `www.multies.si` as a redirect) to the production Worker `mymail`, in the dashboard (Workers, mymail, Settings, Domains and Routes) or with `[[routes]]` entries using `custom_domain = true` in `wrangler.toml`. Cloudflare issues the certificates.
2. **App URL.** Set `APP_URL` to `https://multies.si` in `wrangler.toml` and add it to the trusted origins, so canonical tags, the sitemap, robots.txt, emails and Open Graph tags use the new address. Keep `workers_dev = true` so the old address still answers.
3. **Inbound mail.** Turn on Email Routing for the zone (Cloudflare adds its MX and SPF records), then route the catch-all, or chosen addresses, to the Worker `mymail-inbound`. Create the domain in the app and publish the DKIM and DMARC records it shows; the domain page checks them live.
4. **Outbound mail.** Verify `multies.si` with the outbound provider and set the system sender (for example `no-reply@multies.si`), then send a test from the deliverability page.
5. **Verify** over HTTPS: `curl -sI https://multies.si`, `scripts/smoke.sh https://multies.si`, and the launch checklist spec with `E2E_BASE_URL=https://multies.si`.
6. **Mobile.** Point the app's API address at the new host in the next app release; the old address keeps working for installed versions.

Internal names (the Worker, the databases, environment variables, the repository and the mobile
bundle id) keep the `mymail` name. Nobody outside sees them.
