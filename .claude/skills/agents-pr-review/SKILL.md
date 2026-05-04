---
name: agents-pr-review
description: Review pull requests in the agents library. Use for "review PR", "code review", or "gh pr view".
---

# PR Review Skill (agents library)

## Required

- `gh` CLI
- `git` (PR branch must be checked out locally for authoritative diff)

## Working directory

- repo root (parent of this `.claude`)

## Commands

Run all three together:

- `gh pr view <PR_NUMBER> --json title,number,body,files,commits,additions,deletions,changedFiles,baseRefName,headRefName,author,labels`
- `gh pr diff <PR_NUMBER>` — GitHub API diff (may be stale)
- `git diff $(gh pr view <PR_NUMBER> --json baseRefName --jq '.baseRefName') -- $(gh pr view <PR_NUMBER> --json files --jq '[.files[].path] | join(" ")')` — authoritative local diff

## Diff precedence

- `gh pr diff` can be stale after a recent push
- cross-check with local `git diff <base>` and `Read` tool on changed files
- local git diff + file contents win any disagreement

## Review checklist

### Commit message
- Follows `type: message` format (enforced by commitizen)
- Valid types: `feat, fix, improvement, docs, style, refactor, perf, test, build, ci, chore, revert`
- PR will be squash-merged — the PR title becomes the commit message; flag if it doesn't follow the convention
- Semver: new behavior must use `feat:` prefix; breaking changes require a major version bump; flag if the commit type doesn't match the impact

### Work item reference
- PR title and body must include a GUS work item number
- In the body, the work item must be prepended with `&` and surrounded with `&` on both sides with no spaces (e.g. `&W-12345678&`)
- Flag if the work item is missing or formatted incorrectly

### License header
- Every new `.ts` file must include the Apache 2.0 license header
- Check any added files; missing header will fail the lint check

### TypeScript quality
- No `any` types — this repo uses `tsconfig-strict-esm`
- All public APIs should be typed explicitly
- New exports must be added to `src/index.ts`

### Code correctness
- Correctness, regressions, edge cases
- Error handling: errors must not be swallowed; rethrown errors must set the original as `cause`
- Error messages must include a suggested fix or a clear reason for the failure — not just what went wrong
- Input validation at API boundaries

### Security
- No credentials, tokens, secrets, or PII hardcoded or leaked in source, tests, or fixtures

### Messages / i18n
- User-facing strings belong in `messages/` — not hardcoded in source
- New messages must have entries in the appropriate `.md` file under `messages/`

### Tests
- New code should have corresponding tests in `test/` (mirrors `src/` structure)
- Unit tests use `.test.ts` suffix; NUTs use `.nut.ts`
- Coverage target is 95%+ on new code
- Tests should use `TestContext` and `MockTestOrgData` from `@salesforce/core/testSetup`
- HTTP calls must be mocked using fixtures in `test/mocks/` — no live org calls in unit tests
- Assertions use Chai (`expect`, not `assert`)

### Dependencies
- New packages must use approved Salesforce packages (`@salesforce/core`, `@salesforce/kit`, etc.)
- Flag any new `npm` dependencies — they require deliberate justification in a library

### Agent-specific patterns
- `AgentBase`, `ScriptAgent`, `ProductionAgent` follow a class hierarchy — new agent types should extend `AgentBase`
- Static methods on the `Agent` class (`create`, `list`, `init`) are the public entry points — keep their signatures stable
- Template files live in `src/templates/` — new templates belong there

## Output format

- Findings first, severity order (Critical → High → Medium → Low)
- Cite file paths and line numbers for each finding
- Questions/Assumptions section if needed
- Brief summary last
