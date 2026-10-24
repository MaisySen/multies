# ADR 0003: Clean room: permissive licences only

Status: accepted. Date: 23 to 24 October 2026.

## Context

Multies competes with existing open source suites, some under AGPL or GPL. Copying from them, or
depending on them, would force our own code under the same licence.

## Decision

- No code, schema or copy is taken from other products (Ever Gauzy included).
- Dependencies must be MIT, Apache 2.0 or ISC (or similarly permissive). No AGPL, GPL or LGPL.
- Stalwart, the optional mail server, is a separate program reached over its network API, never linked or bundled.

## Consequences

- New dependencies get a licence check before they are added.
- Some features take longer because they are written from scratch.
