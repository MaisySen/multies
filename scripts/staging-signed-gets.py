#!/usr/bin/env python3
"""
R42: signed in GETs on STAGING for the deploy gate (prod has the demo; staging caps demos at 2 a day).

Signs in as the staging only test login (identity provider connection "multies-staging-test", enabled on the
staging sign in client only; a post login rule refuses the password grant for any other connection), swaps the
id token for an app session at /api/auth/mobile/exchange, then makes N signed in GETs and prints the status
counts and the empty 503s. Secrets live in ~/.multies-secrets/multies-staging-test-user.json (mode 600) and are
never printed or passed on a command line. Never point this at prod.

  python3 scripts/staging-signed-gets.py            # 50 GETs
  python3 scripts/staging-signed-gets.py 60         # 60 GETs
Exit code 1 when any GET is an empty 503 or not 200.
"""
import json, os, sys, time
import requests

SECRETS = os.path.expanduser("~/.multies-secrets/multies-staging-test-user.json")
BASE = "https://mymail-staging.mymail-app.workers.dev"
ROUTES = ["/api/account/me", "/api/org", "/api/team", "/api/dashboard", "/api/projects", "/api/tasks?limit=50",
          "/api/my-work", "/api/notifications", "/api/counts", "/api/mailboxes"]


def sign_in(s: requests.Session, u: dict) -> None:
    r = requests.post(f"https://{u['domain']}/oauth/token", timeout=30, json={
        "grant_type": "http://auth0.com/oauth/grant-type/password-realm", "realm": u["realm"], "username": u["email"],
        "password": u["password"], "client_id": u["client_id"], "client_secret": u["client_secret"], "scope": "openid email profile"})
    if r.status_code != 200:
        sys.exit(f"sign in at the identity provider failed: {r.status_code}")
    x = s.post(BASE + "/api/auth/mobile/exchange", json={"idToken": r.json()["id_token"]}, headers={"origin": BASE}, timeout=30)
    if x.status_code != 200:
        sys.exit(f"session exchange failed: {x.status_code}")


def main() -> int:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    u = json.load(open(SECRETS))
    if not BASE.startswith("https://mymail-staging."):
        sys.exit("refusing: not staging")
    h = requests.get("https://multies.si/api/health", timeout=20).json().get("reads", {})
    print(f"D1 reads before: {h.get('pct')}% of the daily budget")
    if (h.get("pct") or 0) >= 50:
        sys.exit("refusing: D1 reads at or above 50% of the daily budget")
    s = requests.Session()
    sign_in(s, u)
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
