# ADR 0004: Expo for the mobile app

Status: accepted. Date: 23 to 24 October 2026.

## Context

Small teams need the same workspace on iPhone and Android, built by the same people who build the web app.

## Decision

The mobile app is an Expo (React Native) project in its own folder (`mobile/` in the GitHub
repository). It talks to the same REST API as the web app and shares the brand tokens.

## Consequences

- One TypeScript code base for both platforms.
- Native builds are made locally with Gradle and Xcode from `expo prebuild`, signed with keys kept outside the repo.
- API changes must stay compatible with the version in the stores. See [../mobile.md](../mobile.md).
