# ADR 0002: Bring your own AI

Status: accepted. Date: 23 to 24 October 2026.

## Context

Agents and the assistant need a language model. Paying for model calls would make the free plan
expensive and tie the product to one provider.

## Decision

Multies never pays for model calls. A workspace adds its own provider key (encrypted at rest), and
external agents work through the REST API and MCP with their own models. Features that need a model
are off until a key is added.

## Consequences

- The free plan stays free to run.
- Users choose their provider and keep their own usage and data agreements.
- The product must explain clearly where a key is needed, and test with made up keys only.
