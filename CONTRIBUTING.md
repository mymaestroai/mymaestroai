# Contributing

Thanks for helping. My Maestro AI is source-available under the PolyForm Noncommercial 1.0.0 licence (see `LICENSE`); a change you send is published under the same terms.

## How changes flow

- `main` is **stable**: what installs and fresh installs receive. `dev` is **experimental**.
- Work on a branch made from `dev` (for example `fix/chat-images` or `feature/read-aloud`), then open a pull request into `dev`.
- A contributor's pull request into `dev` is merged once the automatic tests pass and it has an approving review.
- Releases are cut by the maintainer: a pull request from `dev` into `main`, with the version and the CHANGELOG section updated.
- Nobody pushes straight to `main` or `dev`, and neither can be force-pushed or deleted.

## Before you open a pull request

- Run the tests. With Node 22: `npm ci --ignore-scripts && npm rebuild better-sqlite3`, then `npm test`.
  The same command runs on every pull request (`.github/workflows/tests.yml`).
- Add or update tests for what you changed.
- Add a line to `CHANGELOG.md` under **[Unreleased]** that says what changed in plain words.
- Keep personal data and secrets out of code, tests, fixtures and commit messages: no real names, email addresses, keys, tokens, wallet addresses or host names. Fixtures use `owner` / `owner@example.com`.
- Features should work for any agent, any provider and any install, and be optional (off by default) when they change behaviour.

The automatic tests check the code; the changelog line, the personal-data rule and the points above are checked in review.

## Security problems

Please don't open a public issue. See `SECURITY.md` for how to report one privately.
