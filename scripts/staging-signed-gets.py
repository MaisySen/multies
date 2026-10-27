#!/usr/bin/env python3
"""
R42: signed in GETs on STAGING for the deploy gate (prod has the demo; staging caps demos at 2 a day).

Uses the seeded staging session from scripts/staging-session.mjs (an app side session row in the staging D1 for
the staging test user, cookie signed with the staging app secret; nothing at the identity provider and nothing in
the app changes, so production is untouched). Makes N signed in GETs over the hot routes and prints the status
counts and the empty 503s. The cookie lives in ~/.multies-secrets/staging-test-session.json (mode 600) and is never
printed. Never point this at prod.

  node scripts/creds.mjs run APP_SECRET_STAGING,CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID -- node scripts/staging-session.mjs   # once a month
  python3 scripts/staging-signed-gets.py            # 50 GETs
  python3 scripts/staging-signed-gets.py 60         # 60 GETs
Exit code 1 when any GET is an empty 503 or not 200; 2 when the session is missing or expired.
"""
import json, os, sys, time
import requests

SESSION = os.path.expanduser("~/.multies-secrets/staging-test-session.json")
BASE = "https://mymail-staging.mymail-app.workers.dev"
ROUTES = ["/api/account/me", "/api/org", "/api/team", "/api/dashboard", "/api/projects", "/api/tasks?limit=50",
          "/api/my-work", "/api/notifications", "/api/counts", "/api/mailboxes"]
RESEED = "node scripts/creds.mjs run APP_SECRET_STAGING,CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID -- node scripts/staging-session.mjs"


def session() -> requests.Session:
    if not os.path.exists(SESSION):
        sys.stderr.write(f"no staging session yet; run: {RESEED}\n"); sys.exit(2)
    j = json.load(open(SESSION))
    s = requests.Session()
    s.cookies.set(j["cookie_name"], j["cookie_value"], domain=BASE.split("//")[1], path="/")
    me = s.get(BASE + "/api/account/me", timeout=30)
    if me.status_code != 200:
        sys.stderr.write(f"staging session not accepted ({me.status_code}); run: {RESEED}\n"); sys.exit(2)
    return s


def main() -> int:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    if not BASE.startswith("https://mymail-staging."):
        sys.exit("refusing: not staging")
    h = requests.get("https://multies.si/api/health", timeout=20).json().get("reads", {})
    print(f"D1 reads before: {h.get('pct')}% of the daily budget")
    if (h.get("pct") or 0) >= 50:
        sys.exit("refusing: D1 reads at or above 50% of the daily budget")
    s = session()
    codes, empty503, slow = {}, 0, []
    for i in range(n):
        p = ROUTES[i % len(ROUTES)]
        t = time.time()
        try:
            r = s.get(BASE + p, timeout=30)
            code, empty = r.status_code, len(r.content) == 0
        except requests.RequestException:
            code, empty = "ERR", True
        ms = int((time.time() - t) * 1000)
        if ms > 2000: slow.append((p, ms))
        codes[code] = codes.get(code, 0) + 1
        if code == 503 and empty: empty503 += 1
        time.sleep(0.15)
    print(json.dumps({"gets": n, "status": codes, "empty503": empty503, "slow_over_2s": slow}))
    return 0 if codes.get(200, 0) == n and empty503 == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
