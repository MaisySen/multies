# OWASP ZAP baseline

A passive scan (spider, AJAX spider, passive rules) runs weekly against the preview, staging and
production from `.github/workflows/zap.yml`, and can be started by hand from the Actions tab.
Any finding that is not accepted, with a reason, in `.zap/rules.tsv` (or `.zap/rules-preview.tsv`
for the preview host) fails the run.

## Running it locally

```bash
# ZAP 2.17 needs Java 17
zap.sh -cmd -autorun zap-plan.yaml   # spider, spiderAjax, passiveScan-wait, report
```

## Results, 23 October 2026 (ZAP 2.17.0)

| Target | High | Medium | Low | Informational |
| --- | --- | --- | --- | --- |
| Staging (Cloudflare Workers deploy) | 0 | 2 (accepted) | 0 | 3 (accepted) |
| Preview (mymail.sites.tab.bot) | 0 | 2 (accepted) | 2 (host only) | 3 (accepted) |

### Accepted findings

| Rule | Finding | Why it stays |
| --- | --- | --- |
| 10055 | CSP: wildcard in `img-src` (`https:`) | Readers can choose "Show images" on a message; until they do, the message frame's own policy blocks remote images. `script-src` is strict `'self'`. |
| 10055 | CSP: `style-src 'unsafe-inline'` | HTML email depends on `<style>` blocks and React sets style attributes. Style injection cannot run script under this policy. `tests/hardening.test.ts` pins every directive. |
| 10015 | Cache-control on the HTML shell | The shell is `no-cache` so a deploy is picked up immediately; it holds no personal data. Assets are immutable, API responses `no-store`. |
| 10027, 10109 | Informational notes on the minified bundle and on being a single page app | By design. |

### Preview host only

The preview platform serves `/assets/*` from its own edge cache without the app's headers, so
ZAP reports missing HSTS (10035) and `X-Content-Type-Options` (10021) there. The Cloudflare
deploys (staging, production) send both on every asset; the staging scan shows no such finding.

### Fixed during the round

- Missing `robots.txt` and the public pages' security headers on static responses (now sent by the Worker and a generated `_headers` file).
- `index.html` served from assets without headers: the shell is now embedded in the Worker and always gets the full policy.
