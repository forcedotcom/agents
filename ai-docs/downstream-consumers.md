# Downstream consumers

`@salesforce/agents` is a published library. Other Salesforce repos depend on it and are
pinned to a released version — they cannot redeploy in lockstep with a change here. That
makes the exported surface of this package (types, function/class signatures, option
shapes, defaults, enum values, thrown errors, wire/output shapes) a **contract**. A change
that reads fine in isolation, and passes this repo's own tests, can still break a consumer
that is bound to the old shape.

Use this doc whenever a **code review is being generated or read** for a change to this
repo's public API: check the change against the consumers below to decide whether it is
breaking or backwards-incompatible, and point at the exact consumer call site it would
break.

## The consumers

| Repo | Package | How it consumes `@salesforce/agents` |
| --- | --- | --- |
| [salesforcecli/plugin-agent](https://github.com/salesforcecli/plugin-agent) | `@salesforce/plugin-agent` | **Direct** — declared dependency, imported across many command files. The heaviest consumer of the API. |
| [forcedotcom/vscode-agents](https://github.com/forcedotcom/vscode-agents) | `salesforcedx-vscode-agents` | **Direct** — declared dependency, imported across the extension. |
| [forcedotcom/cli](https://github.com/forcedotcom/cli) | `@salesforce/cli` | **Indirect / transitive** — does not import `@salesforce/agents` itself; it bundles `plugin-agent`, so it inherits the contract through that plugin. |

## Always check against the latest default branch

These repos move. Never reason from a stale local checkout or from memory of the API.
Before judging compatibility, cross-check against the **latest default branch** (`main`)
of each relevant consumer:

- If a repo is already cloned locally, `git fetch` and read the `origin/main` state — do
  not trust the working tree, which may be behind or on a feature branch.
- Otherwise clone it fresh to a temp dir, e.g.
  `git clone --depth 1 https://github.com/salesforcecli/plugin-agent /tmp/plugin-agent`.

## How to cross-check a change

1. Identify what changed in this repo's **exported** surface — a renamed/removed export,
   a changed signature or option shape, a narrowed input, a widened or restructured
   output, a changed default, an altered enum set, a new required field, a different
   thrown error.
2. In each direct consumer (`plugin-agent`, `vscode-agents`), grep for the affected symbol
   to find every call site — e.g. `grep -rn "publishAgent\|from '@salesforce/agents'" src`.
3. Decide per call site whether the old usage still compiles and behaves the same. If any
   does not, the change is **breaking** for that consumer.
4. For the CLI, remember the dependency is transitive: a break in `plugin-agent`'s usage
   is a break for the CLI. Check `plugin-agent`, not the CLI's own source.
5. In the review, name the specific consumer, file, and call site the change would break,
   and whether it can be made backwards-compatible (e.g. additive/optional instead of a
   rename, keep the old export as a deprecated alias).

A pure addition — a new optional field, a brand-new export — is safe; say so briefly
rather than manufacturing a concern.
