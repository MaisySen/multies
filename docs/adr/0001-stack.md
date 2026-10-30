# ADR 0001: Stack: Workers, D1, Hono, React and Vite

Status: accepted. Date: 23 to 24 October 2026.

## Context

The product needed to ship quickly, run cheaply for small businesses, and work both as a hosted
service and on one computer for people who self host.

## Decision

- Server: Hono on TypeScript, one app (`createApp(deps)`) for Cloudflare Workers and Node.
- Data: Cloudflare D1 (SQLite) through Drizzle ORM, with better-sqlite3 on Node, so one schema and one set of migrations serve both.
- Auth: Better Auth.
- Web: React 19 with Vite, React Router, TanStack Query and Tailwind v4.
- Live docs: a Durable Object per doc with Yjs.
- Public API described with `@hono/zod-openapi`; MCP on the official SDK.

## Consequences

- One code base and one test suite cover hosted and self hosted installs.
- D1 is SQLite: no stored procedures, and heavy joins need care (N+1 queries show up in Sentry).
- Every dependency must run on Workers, which rules out some Node only libraries.
