# CLAUDE.md

Guidance for coding sessions in this repo. This file is a hub: it points to the conventions
we expect every change to follow. Read the linked docs before writing code in their area.

`@salesforce/agents` — client-side APIs for working with Salesforce agents (TypeScript).

## Conventions

- **[Logging](ai-docs/logging.md)** — how we log. Log through `CtxLogger`, keep messages
  static with variable data in structured fields, and write every line to pass the 3am test.
  Read this before adding or changing any log line.

_Add new convention docs under `ai-docs/` and link them here as the hub grows._

## Verifying a change

- `yarn build` — typecheck/compile (equivalently `yarn tsc -b`).
- `yarn test` — the test suite (the mocha unit tests run via `yarn mocha "test/**/*.test.ts"`).

Run both before considering a change done.
