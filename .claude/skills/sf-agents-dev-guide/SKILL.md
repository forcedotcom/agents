---
name: sf-agents-dev-guide
description: >-
  Development guide for contributing to @salesforce/agents. Covers architecture,
  cross-repo interfaces (plugin-agent, vscode-agents), release flow, testing,
  and code conventions. Use when implementing features, understanding downstream
  impact, or working across AFDX repos. Triggers on: "how to contribute",
  "architecture", "downstream", "plugin-agent", "vscode-agents", "cross-repo",
  "feature development", "releasing", "testing".
---

# Development Guide — @salesforce/agents

## Architecture Overview

This repo is the **foundational library** that manages all API calls for previewing, publishing, compiling, and testing Salesforce agents. Both the CLI plugin and VS Code extension consume this library to ensure consistent business logic across platforms.

```
@salesforce/agents (this repo — forcedotcom/agents)
    │
    ├─► plugin-agent (salesforcecli/plugin-agent)
    │     CLI commands: sf agent generate|deploy|preview|test|...
    │     Oclif plugin, bundled as SF CLI core plugin
    │
    ├─► vscode-agents (forcedotcom/vscode-agents)
    │     VS Code extension: preview, publish, test UI, session management
    │
    └─► sf-skills (forcedotcom/sf-skills)
          Curated agent skills for Agentforce Vibes (works with all AI tools)
```

Template or logic changes here automatically benefit all downstream consumers.

## Repo Ecosystem

| Repo | GitHub | Role |
|------|--------|------|
| agents (this repo) | forcedotcom/agents | Core TypeScript library — APIs for agent lifecycle |
| plugin-agent | salesforcecli/plugin-agent | CLI commands (`sf agent *`), Oclif core plugin |
| vscode-agents | forcedotcom/vscode-agents | VS Code extension — UI for preview, publish, test, debug |
| sf-skills | forcedotcom/sf-skills | Curated agent skills for Agentforce Vibes; works with all AI tools |

For the public-API consumer contract — which repos are bound to the published API and how to
check a change for breaking / backwards-incompatible impact — see
[`ai-docs/downstream-consumers.md`](../../../ai-docs/downstream-consumers.md).

## How Changes Flow Downstream

1. **Merge to main** → auto-publishes `@salesforce/agents` to npmjs (version bump per conventional commit)
2. **CLI plugin** → Dependabot auto-bumps (caret deps). Included in nightly build. Tuesday nightly → promoted to RC on Wednesday. Current RC → promoted to production. **Net: changes reach CLI production ~1 week after merge.**
3. **VS Code extension** → manual version bump in vscode-agents package.json. Publishes to Microsoft Marketplace + Open VSX on PR merge.
4. **Dependabot** is enabled on all repos, auto-merges clean runs except majors. May stop running if repos are inactive for a while — requires manual reboot.

## CLI Plugin Interface

- Follows **Oclif** convention. Commands structured under `sf agent` topic.
- As a **core plugin**, it's included in every Salesforce CLI release automatically.
- Updates distributed via nightly builds + promotional cycles; GitHub Actions handles automation.
- **When adding new library APIs that need CLI exposure**: create a command in plugin-agent that imports from this library. The library owns the business logic; the plugin owns the command UX.

## VS Code Extension Interface

- **Testing panel** reads from testing definitions (AI testing definitions + evaluation definitions)
- **Three simulation modes**: agents deployed to an org, published agents, agents on the local file system
- **Local simulation** works without deploying to an org — the agent fakes Apex calls to provide responses
- **Session history** tracked with a tracer (filter by events or reasoning). Stored in extension local cache with ~1 week expiry. Users can resume past conversations.
- **Agent deployment/versioning**: activate, deactivate, version switch — all managed through the extension. An agent must be published to appear in the web interface.
- **Theming**: supports all VS Code themes. Never hardcode colors.
- **Agent generation**: the `generate` command uses templates from `src/templates/` to create authoring bundle metadata (agent script + AiAuthoringBundle), not just agent script.

## Development Workflow

1. Branch off `main` (prefix: `<developer-name>/`)
2. Keep branch up-to-date using `rebase`
3. Write code + tests (95%+ coverage on new code)
4. Commit using `type: message` format (enforced by Husky + commitlint; commitizen available as an authoring helper)
5. PR is squash-merged — the PR title becomes the final commit message
6. Include a GUS work item: `@W-XXXXXXXX@` in PR body

Valid commit types (`@commitlint/config-conventional`): `feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert`

Semver: `feat:` → minor, `fix:` → patch, breaking changes → major.

### Commands

```bash
yarn install              # install deps
yarn build                # compile + lint
yarn compile              # TypeScript → JavaScript only
yarn lint                 # eslint
yarn lint-fix             # eslint --fix
yarn format               # prettier
yarn test                 # unit tests + bundle + compile check + link check
yarn test:nuts            # non-unit tests (require org connection)
yarn docs                 # generate API docs
yarn clean                # remove generated files (clean-all also removes node_modules)
yarn fix-license          # add Apache 2.0 headers to new files
yarn link                 # live symlink into a consumer for local testing
yarn pack                 # build the publishable .tgz to QA the artifact
```

### Cross-Repo Development

To test library changes in a downstream consumer (`plugin-agent`, `vscode-agents`) before
merging — `yarn link` for a live symlink, or `yarn pack` to QA the published artifact
shape — see [`ai-docs/local-testing.md`](../../../ai-docs/local-testing.md).

The `sf` CLI has no direct dependency on this library; it bundles `plugin-agent`, so you
test the `sf agent` experience transitively through that plugin (`sf plugins link .`), not
by building the CLI. See [`ai-docs/local-testing.md`](../../../ai-docs/local-testing.md).

## Code Conventions

- **No `any` types** — uses `tsconfig-strict-esm`
- All public APIs typed explicitly
- New exports must be added to `src/index.ts`
- User-facing strings in `messages/*.md` — never hardcoded
- Apache 2.0 license header on every new `.ts` file
- Error messages must include a suggested fix or clear reason
- Rethrown errors must set original as `cause`
- Debug output in code to aid troubleshooting

## Key Architecture

```
src/
├── agent.ts                    # Agent class — static entry points (create, list, init)
├── agents/
│   ├── agentBase.ts            # Base class for all agent types
│   ├── scriptAgent.ts          # Agent Script-based (AiAuthoringBundle)
│   ├── productionAgent.ts      # Production Bot-based agents
│   └── scriptAgentPublisher.ts # Publishing logic for script agents
├── agentTester.ts              # AI Evaluation test runner
├── agentforceStudioTester.ts   # Agentforce Studio (NGT) test runner
├── agentEvalRunner.ts          # Evaluation orchestrator
├── apiCatalog.ts               # MCP server management
├── agentDataLibrary.ts         # Data library / grounding management
├── connectionManager.ts        # Org connection handling
├── templates/                  # Templates for agent generation
└── types.ts                    # Shared type definitions
messages/                       # User-facing strings (i18n)
```

New agent types should extend `AgentBase`. Static methods on the `Agent` class are the public entry points — keep their signatures stable.

## Testing

- **Unit tests**: `test/**/*.test.ts` — Mocha + Chai (`expect`, not `assert`)
- **NUTs**: `test/**/*.nut.ts` — require scratch org, use `@salesforce/cli-plugins-testkit`
- **HTTP mocking**: fixtures in `test/mocks/` — no live org calls in unit tests
- **Test utilities**: `TestContext` and `MockTestOrgData` from `@salesforce/core/testSetup`
- **Local simulation**: the library supports faking Apex calls so extensions/plugins can run tests without deploying to an org
- Coverage target: **95%+** on new code

## Known Technical Debt / Gotchas

- **Session storage**: session history and log storage was built for function, not maintainability. Needs refactoring away from the current utility approach.
- **Race conditions**: can occasionally occur in the extension — monitor when making changes to session or preview flows.
- **Compiler lacks simulation mode**: live tests may require specific Apex classes to exist in the org. Can't fully simulate compile+run locally.
- **Org expiry**: connection issues arise when a scratch org expires mid-session. Handle gracefully.

## Contacts

- Internal Slack: [#cli-team-afdx](https://salesforce.enterprise.slack.com/archives/C09L37D1NJX)
- External Slack: [#agentforce-dx](https://salesforce.enterprise.slack.com/archives/C08CK5VCSTS)
- GUS Product Tag: [AgentForce DX](https://gus.lightning.force.com/a1aEE000001vDZRYA2)
- CLI questions: Willie Ruemmele
- Extension questions: Steve Hetzel
- Design: Marcelino Llano
