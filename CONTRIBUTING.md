# Contributing

Thanks for helping. Bug reports, browser quirks and pull requests are welcome.

## Before you open a pull request

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build:all
```

## Where things go

- Sync rules (diff, merge, conflict handling) live in `src/core` and must stay
  free of browser APIs. Add a test in `tests/` for every rule you change.
- Browser differences (root folders, unsupported items) live in `src/sync/local-tree.ts`.
  If you find a new quirk, add it to the fake in `tests/fakes.ts` first, then fix it.
- Google sign-in and Drive calls live in `src/platform`.

## Changing the sync file format

`SyncState.schema` and `BackupFile.schema` are versioned. Older extensions
refuse files with a higher schema, so a format change needs a new schema
number and a migration path. Open an issue before starting one.

## Reporting a sync problem

Please include the browsers and versions, what you did in which browser, and
what you expected. Do not attach your `sync-state.json`: it contains your bookmarks.
