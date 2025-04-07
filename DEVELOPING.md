# Developing

## Getting Started

Clone the project and `cd` into it:

```
git clone git@github.com:forcedotcom/agents.git
cd agents
```

Ensure you have [Yarn](https://yarnpkg.com/) installed, then run:

```
yarn install
yarn build
```

## Branches

- Our released (_production_) branch is `main`
- Our work happens in _topic_ branches (feature and/or bug fix)
  - These branches are based on `main` and can live in forks for external contributors or within this repository for authors
  - Be sure to prefix branches in this repository with `<developer-name>/`
  - Be sure to keep branches up-to-date using `rebase`

## Testing

All changes must have associated tests. This library uses a combination of unit testing and NUTs (non-unit tests).

### Running the test suite

Runs the suite and output code coverage as a text summary:

```
yarn test
```

Utilize the `Run Tests` VS Code debugger configuration to run the test suite with the debugger enabled.

### Testing in another package

To test the library in another local package, you can link it to such module so any changes that are built will be automatically present without reinstalling:

```
yarn local:link /path/to/other/project
```

to unlink the library:

```
yarn local:unlink /path/to/other/project
```

### Testing with the NPM artifact

The library can also be installed to another local project as a regular NPM module. This is useful for manually testing the package that will be deployed to NPM. Use this instead of the linking process that's described under Development to QA changes before they are published:

```
yarn local:install /path/to/other/package
```

## Debugging

If you need to debug library code or tests you should refer to the excellent documentation on this topic in the [Plugin Developer Guide](https://github.com/salesforcecli/cli/wiki/Debug-Your-Plugin).

## Useful yarn commands

#### `yarn install`

This downloads all NPM dependencies into the node_modules directory.

#### `yarn compile`

This compiles the typescript to javascript.

#### `yarn lint`

This lints all the typescript using eslint.

#### `yarn build`

This compiles and lints all the typescript (e.g., `yarn compile && yarn lint`).

#### `yarn clean`

This cleans all generated files and directories. Run `yarn clean-all` to also clean up the node_module directories.

#### `yarn test`

This runs unit tests (mocha) for the project using ts-node.

#### `yarn test:nuts`

This runs NUTs (non-unit tests) for the project using ts-node.
