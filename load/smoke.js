// k6 load test: a realistic mix of anonymous page loads, the status page and authenticated
// API reads. Run against staging, never production:
//   BASE_URL=https://mymail-staging.mymail-app.workers.dev K6_API_KEY=mm_live_... k6 run load/smoke.js
// Rate limits are per IP (app 300 and API 600 requests a minute), so one machine measures
// latency and errors, not maximum throughput; see load/README.md.
import http from "k6/http";
import { check, group, sleep } from "k6";

const BASE = __ENV.BASE_URL || "https://mymail-staging.mymail-app.workers.dev";
const KEY = __ENV.K6_API_KEY || "";

export const options = {
  scenarios: {
    browse: { executor: "ramping-vus", exec: "browse", startVUs: 0, stages: [{ duration: "20s", target: 10 }, { duration: "60s", target: 10 }, { duration: "10s", target: 0 }] },
    api: { executor: "constant-arrival-rate", exec: "api", rate: 5, timeUnit: "1s", duration: "90s", preAllocatedVUs: 5, maxVUs: 20 },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{scenario:browse}": ["p(95)<800"],
    "http_req_duration{scenario:api}": ["p(95)<500"],
    checks: ["rate>0.99"],
  },
};

export function browse() {
  group("landing", () => {
    const r = http.get(`${BASE}/`, { tags: { name: "landing" } });
    check(r, { "landing 200": (x) => x.status === 200, "has CSP": (x) => !!x.headers["Content-Security-Policy"] });
  });
  group("status", () => {
    const r = http.get(`${BASE}/api/status`, { tags: { name: "status" } });
    check(r, { "status 200": (x) => x.status === 200 });
  });
  group("health", () => {
    const r = http.get(`${BASE}/api/health`, { tags: { name: "health" } });
    check(r, { "health ok": (x) => x.status === 200 && x.json("ok") === true });
  });
  sleep(2 + Math.random() * 2);
}

export function api() {
  if (!KEY) return;
  const r = http.get(`${BASE}/api/v1/domains`, { headers: { authorization: `Bearer ${KEY}` }, tags: { name: "v1_domains" } });
  check(r, { "api 200": (x) => x.status === 200 });
}
