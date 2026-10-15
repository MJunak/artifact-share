# Contributing

Thanks for helping. This project aims to stay small, so please open an issue before starting a larger feature.

## Workflow

1. Fork and create a branch.
2. `npm ci`, then make your change.
3. Add or update tests. `npm test` must pass.
4. Update the docs if behaviour or configuration changes, and add a line to [CHANGELOG.md](CHANGELOG.md).
5. Open a pull request that explains *why*.

## Guidelines

- **No new runtime dependencies** without a strong reason. `marked` is the only one today.
- **Security-sensitive changes** (auth, headers, rendering, uploads) need a regression test in `test/security.test.js` and an update to [docs/security.md](docs/security.md).
- **Never use `innerHTML`** with dynamic data in the admin UI; build DOM nodes with `h()`.
- Match the surrounding code style: ES modules, 2-space indent, single quotes.
