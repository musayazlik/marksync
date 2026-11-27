# Contributing

Thanks for helping. Bug reports, browser quirks and pull requests are welcome.

## Before you open a pull request

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build:all
```

## Commit messages

Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/).
The release tooling reads them to pick the next version and write the changelog:

| Prefix | Use for | Version | In the changelog |
|---|---|---|---|
| `feat:` | something new users can see or do | minor (0.**2**.0) | Features |
| `fix:` | a bug users could hit | patch (0.1.**1**) | Bug Fixes |
| `perf:` | faster or lighter, same behaviour | patch | Performance |
| `feat!:` or a `BREAKING CHANGE:` footer | users must act (e.g. a sync file schema change) | major from 1.0.0; minor before | marked as breaking |
| `docs:` `refactor:` `test:` `build:` `ci:` `chore:` `style:` | everything else | none | hidden |

Add a scope when it helps: `fix(sync): …`, `feat(options): …`. Write the
description for users ("keep folder order when two browsers reorder"), not
for the code ("change compareSiblings"). CI checks pull request titles.

A commit with several user-visible changes can list the extra ones as
Conventional Commit lines at the end of the message body; each becomes its own
changelog entry.

Merge pull requests with **Rebase and merge** or **Squash and merge**. When
squashing, keep the PR title as the commit title.

## Releases

Releases are made by [release-please](https://github.com/googleapis/release-please)
(`.github/workflows/release.yml`); nobody edits version numbers by hand.

1. Every push to `main` opens or updates a pull request named
   `chore(main): release X.Y.Z`. It bumps `version` in `package.json` (which
   becomes the extension's manifest version) and adds the new section to
   `CHANGELOG.md`.
2. Merge it when you want to ship. That tags `vX.Y.Z` and publishes a GitHub
   Release with the changelog.
3. The workflow then builds the store packages from the tag and attaches them
   to the release, with `SHA256SUMS.txt`:
   `marksync-X.Y.Z-chrome.zip` (Chrome Web Store), `-edge.zip`, `-opera.zip`,
   and, when `WXT_GECKO_ID` is set, `-firefox.zip` plus `-sources.zip` for
   Firefox Add-ons reviewers.
4. Upload the packages to the stores. Store submission is manual for now.

If packages are missing from a release (a failed upload, or `WXT_GECKO_ID`
was set afterwards), open Actions → Release → **Run workflow** and enter the
tag, e.g. `v0.2.0`. It builds that tag again and replaces the release's
packages; it never creates a release or changes the version.

Repository variables used by release builds (Settings → Secrets and variables
→ Actions → Variables; they end up in the published extension, so they are not
secrets):

- `WXT_GOOGLE_CLIENT_ID`: the production OAuth client (docs/GOOGLE_SETUP.md). Required.
- `WXT_GECKO_ID`: a Firefox add-on ID you own. Without it the release has no Firefox package.

The release pull request is opened by GitHub Actions, so GitHub does not run
CI on it. CI already ran on every commit it contains.

To ship a specific version (for example `1.0.0`), add a commit whose body ends
with `Release-As: 1.0.0`.

## Where things go

- Sync rules (diff, merge, conflict handling) live in `src/core` and must stay
  free of browser APIs. Add a test in `tests/` for every rule you change.
- Browser differences (root folders, unsupported items) live in `src/sync/local-tree.ts`.
  If you find a new quirk, add it to the fake in `tests/fakes.ts` first, then fix it.
- Google sign-in and Drive calls live in `src/platform`.
- Every text shown to users lives in `src/public/_locales/<lang>/messages.json`
  (English and Turkish). Add a new key to every language; `pnpm test` checks
  that none is missing. Use `{1}`, `{2}` for values and never a `$` sign.
  New languages are welcome: copy `en/messages.json` to a new folder.

## Changing the sync file format

`SyncState.schema` and `BackupFile.schema` are versioned. Older extensions
refuse files with a higher schema, so a format change needs a new schema
number and a migration path. Open an issue before starting one.

History: schema 2 (0.7) added the fractional position key `pos` to every
record (#9); schema 1 files are migrated on read.

## Reporting a sync problem

Please include the browsers and versions, what you did in which browser, and
what you expected. Do not attach your `sync-state.json`: it contains your bookmarks.
