# Testing changes locally in a consumer

`@salesforce/agents` is a library — its behavior only really shows up once a consumer
(`plugin-agent`, `vscode-agents`) runs against it. Before publishing, test your change
inside a consumer one of two ways. See [downstream-consumers.md](downstream-consumers.md)
for who the consumers are.

## Which flow to use

- **Live symlink (`yarn link`)** — iterate on the library and see edits in the consumer
  immediately, without reinstalling. Use this while developing.
- **Packed artifact (`yarn pack`)** — install the exact tarball that would be published, to
  QA the real package shape. Use this to catch problems a symlink hides (a file missing
  from the published `files` set, a bad `main`/`types`, a missing dependency).

## Live symlink with `yarn link`

Iterate on the library with changes reflected in a consumer as soon as they're built.

```bash
# In this repo (@salesforce/agents)
yarn build                 # produce lib/ (or `yarn compile --watch` to rebuild on save)
yarn link                  # register @salesforce/agents as a global link

# In the consumer (e.g. ../plugin-agent or ../vscode-agents)
yarn link @salesforce/agents
```

Then run the consumer as usual — for `plugin-agent`, `./bin/dev.js agent ...` (or
`sf plugins link .`); for `vscode-agents`, launch the extension. Rebuilds in this repo
(`yarn build`, or a running `yarn compile --watch`) flow straight through the symlink.

Undo when done:

```bash
# In the consumer
yarn unlink @salesforce/agents
yarn install --force        # restore the real published dependency

# In this repo
yarn unlink
```

**Caveat — duplicate `@salesforce/core`:** a symlinked library brings its own
`node_modules`, so the consumer can end up with two copies of `@salesforce/core`. That
breaks `instanceof` checks and connection/auth state in confusing ways. If you hit odd
runtime errors under a link, prefer the packed-artifact flow below.

## Exercising the real `sf agent` CLI

You do **not** clone or build [forcedotcom/cli](https://github.com/forcedotcom/cli) to test
a change here. The `sf` CLI has no direct dependency on `@salesforce/agents` — it only
*bundles* `plugin-agent` (which imports this library), so the CLI inherits your change
transitively through the plugin. See [downstream-consumers.md](downstream-consumers.md).

So you always test through `plugin-agent`, at one of two fidelities:

- **Fastest** — run the plugin standalone: `./bin/dev.js agent ...` from `plugin-agent`,
  with `@salesforce/agents` linked into it (above). No `sf` CLI involved.
- **End-user experience** — to run it as `sf agent ...`, link the plugin into your installed
  CLI with `sf plugins link .` from `plugin-agent`. With `@salesforce/agents` still
  `yarn link`ed into that plugin, your library change flows all the way through to
  `sf agent`.

## Packed artifact with `yarn pack`

Install the library exactly as it would ship to npm — this respects the published `files`
set (`/lib`, `/messages`) and surfaces packaging problems a symlink cannot.

```bash
# In this repo (@salesforce/agents)
yarn build
yarn pack                   # produces e.g. salesforce-agents-v<version>.tgz

# In the consumer
yarn add /absolute/path/to/salesforce-agents-v<version>.tgz
```

Undo by restoring the real dependency (revert the consumer's `package.json` change and
`yarn install --force`).
