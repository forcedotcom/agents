# CLAUDE.md

Guidance for coding sessions in this repo. This file is a hub: it points to the conventions
we expect every change to follow. Read the linked docs before writing code in their area.

`@salesforce/agents` — client-side APIs for working with Salesforce agents (TypeScript).

## Conventions

- **[Logging](ai-docs/logging.md)** — how we log. Log through `CtxLogger`, keep messages
  static with variable data in structured fields, and write every line to pass the 3am test.
  Read this before adding or changing any log line.
- **[Downstream consumers](ai-docs/downstream-consumers.md)** — who depends on this
  package's public API (`plugin-agent`, `vscode-agents`, the `sf` CLI) and how to check a
  change against the latest `main` of each. Read this when generating or reading a code
  review to judge whether a change is breaking or backwards-incompatible, and where.
- **[Local testing](ai-docs/local-testing.md)** — how to test a change inside a consumer
  before publishing: `yarn link` for a live symlink, or `yarn pack` to QA the exact
  published artifact. Read this when you need to verify a change against `plugin-agent` or
  `vscode-agents` locally.

_Add new convention docs under `ai-docs/` and link them here as the hub grows._

## Verifying a change

- `yarn build` — typecheck/compile (equivalently `yarn tsc -b`).
- `yarn test` — the test suite (the mocha unit tests run via `yarn mocha "test/**/*.test.ts"`).

Run both before considering a change done.
