## Contributing

1. The [DEVELOPING](DEVELOPING.md) doc has details on how to set up your environment.
1. Familiarize yourself with the codebase by reading the [docs](https://forcedotcom.github.io/agents/), which you can generate locally by running `yarn docs`.
1. Create a new issue before starting your project so that we can keep track of
   what you're trying to add/fix. That way, we can also offer suggestions or
   let you know if there is already an effort in progress.
1. Fork this repository (external contributors) or branch off main (committers).
1. Set up your environment using the information in the [developing](./developing.md) doc.
1. Create a _topic_ branch in your fork based on the correct branch (usually the **main** branch, see [Branches section](./developing.md)). Note: this step is recommended but technically not required if contributing using a fork.
1. Edit the code in your fork.
1. Write appropriate tests for your changes. Try to achieve at least 95% code coverage on any new code. No pull request will be accepted without associated tests.
1. Sign the CLA (see [CLA](#cla)).
1. Send us a pull request when you're done. We'll review your code, suggest any needed changes, and merge it in.
1. Upon merge, a new release of the `@salesforce/agents` library will be published to npmjs with a version bump corresponding to commitizen rules. (see [Releasing](#releasing)).

## Pull Requests

### Committing

We enforce commit message format. We recommend using [commitizen](https://github.com/commitizen/cz-cli) by installing it with `npm install -g commitizen` and running `npm run commit-init`. When you commit, we recommend that you use `npm run commit`, which prompts you with a series of questions to format the commit message. Or you can use our VS Code Task `Commit`.

The commit message format that we expect is: `type: commit message`. Valid types are: feat, fix, improvement, docs, style, refactor, perf, test, build, ci, chore and revert.

Before commit and push, Husky runs several hooks to ensure the commit message is in the correct format and that everything lints and compiles properly.

### CLA

External contributors are required to sign a Contributor's License
Agreement. You can do so by going to <https://cla.salesforce.com/sign-cla>.

### Merging Pull Requests

Pull request merging is restricted to squash and merge only.

## Releasing

- A new version of this library (`@salesforce/agents`) will be published upon merging PRs to `main`, with the version number increment based on commitizen rules. E.g., if any commit message begins with, "feat:" the minor version will be bumped. If any commit message begins with, "fix:" the patch version will be bumped.
