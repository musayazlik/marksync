# Architecture

## Goals

- The same bookmark tree in Chrome, Brave, Edge and Firefox, on any number of computers.
- No server: data lives only in the user's Google Drive.
- Never lose bookmarks: conflicts are merged, mass deletions are stopped, backups are kept.

## Layers

```
src/
  core/        Pure logic, no browser APIs, fully unit-tested
    types.ts     Data model: SyncRecord, SyncState, BackupFile
    records.ts   Diff with the last sync, first-sync matching, merge, sanitize, restore
    netscape.ts  HTML export that every browser can import
  sync/        Talks to the bookmarks API through an interface
    local-tree.ts  Read the local tree (Chromium/Firefox roots) and apply a state to it
    engine.ts      One sync run: load → diff → merge → apply → upload
  platform/    Browser and Google specifics
    identity.ts    Google sign-in with launchWebAuthFlow
    drive.ts       Google Drive v3 REST client
  services/    Wires the engine to Drive and extension storage
  entrypoints/ background (events, alarms, messages), popup, options
tests/         In-memory Chromium and Firefox fakes, end-to-end sync tests
```

## Files in Google Drive

```
My Drive/Marksync/
  sync-state.json   { schema, records: { [id]: SyncRecord }, updatedAt, updatedBy }
  backups/          one JSON file per backup, newest N kept
  browsers/         <device id>.json: each browser's own tree, for importing
```

The `drive.file` scope only lets the extension see files it created itself.

## Identity of a bookmark

Local bookmark IDs differ per browser (`"153"` in Chrome, `"aB3x_9..."` in
Firefox). Every bookmark and folder gets a random UUID that is the same
everywhere. Each browser stores its own map `localId → UUID`.

The top-level folders are not records. They have fixed keys:
`toolbar`, `menu`, `other`, `mobile`. Chromium has no Bookmarks Menu, so a
regular folder named "Bookmarks Menu" inside "Other bookmarks" stands in for it.

## One sync run (`sync/engine.ts`)

1. **Load** `sync-state.json` and its Drive version number.
2. **Diff**: read the local tree and compare it with the *mirror*, the state
   after this browser's last sync. New items get a UUID; changed fields get
   the current clock; missing items get a tombstone (`deletedAt`).
3. **First sync of a browser** (empty mirror): local items that match a remote
   item (same folder, same URL / folder name) take over its UUID, so
   bookmarks that already exist in both browsers are not duplicated.
4. **Validate the remote file**: records that do not have the expected shape
   are dropped, clocks far in the future are clamped (`core/validate.ts`).
   The cleaned file is written back on upload.
   **Mass-delete guard (local)**: if more than half of the bookmarks (and at
   least 20) would be deleted by this browser's changes, stop and ask.
5. **Merge** field by field:
   - title/URL: the side with the newer `contentAt` wins;
   - parent/position: the side with the newer `positionAt` wins;
   - a deletion wins over changes older than it; a later edit or a restore brings the item back.
   **Mass-delete guard (remote)**: if the merge would delete most bookmarks
   because of deletions that came from the file, stop and ask ("Delete them
   here too" / "Keep my bookmarks"), unless a user confirmed that deletion in
   another browser (`confirmedDeletionAt`). A backup is taken before any large
   remote deletion is applied.
6. **Sanitize** (deterministic, so every browser gets the same result):
   orphans go to "Other", folder cycles are broken, nesting deeper than 200
   levels is moved to "Other", siblings are renumbered, tombstones older than
   90 days are dropped. Linear time.
7. **Apply** to the local tree: create/update/move parents first, remove
   deleted items, then fix the order in each folder.
8. **Save** the mirror and ID map, then **upload** if anything changed. If
   another browser uploaded in between (version changed), start again (max 3 tries).

Every step is idempotent: a run that fails halfway is repaired by the next one.

### Clocks

Clocks are `max(Date.now(), highest clock already seen + 1)`, so a computer
whose clock is behind still produces newer timestamps than what it has seen.

### Browser differences

| Browser | What is special | How Marksync handles it |
|---|---|---|
| Chrome 134+ signed in to Google | Two copies of each top-level folder: account (`syncing: true`) and "only on this device" | Both are read as one folder, account copy first. New items go to the account copy. Items are never moved between the copies. |
| Opera | Extra roots found with `getRootByName`: Unsorted, Trash, Speed Dial | Unsorted counts as "other"; Trash and Speed Dial are never synced, so moving a bookmark to Trash deletes it everywhere |
| Firefox | Bookmarks Menu root, separators, `place:` queries | Menu ↔ "Bookmarks Menu" folder in Chromium; separators and queries stay local |
| Chromium | Managed (policy) bookmarks | Skipped |
| Safari, mobile | No bookmarks API for extensions | Not supported; HTML import only |

### Items a browser cannot show

Firefox refuses some URLs (for example `javascript:` bookmarklets); separators
and `place:` queries exist only in Firefox; managed bookmarks only in Chromium.
These are not synced or, when they come from another browser and cannot be
created, are remembered in `keep` so they are not deleted everywhere.

## Triggers ("instant" sync)

Drive can only push change notifications to a web server, and Marksync has
none, so other browsers learn about changes by asking. Asking is made cheap:
each browser remembers the Drive version of `sync-state.json` after its last
sync, and a check is one small metadata request. A full sync runs only when
the version changed.

- **Bookmark added/changed here** → upload after 1 second of quiet (the star
  dialog fires several events for one bookmark).
- **Switching to this browser** (window focus) or **opening the popup** →
  check now, again after 5 s and 15 s, in case the other browser is still uploading.
- **Alarm** every N minutes (default 1) → check.
- **Browser start** → full sync. A full sync also runs if the last one is
  older than 30 minutes or the last run ended with an error.
- **Hourly alarm** → backup if the backup interval has passed.

Folder and file IDs in Drive are cached. If two browsers create
`sync-state.json` at the same moment, the oldest file wins and the other
browser deletes its copy and merges into the winner.

## Sign-in

`identity.launchWebAuthFlow` with Google's token flow works in every target
browser. The access token lasts one hour and is kept in session storage.
When it expires, the flow runs again without a window (`prompt=none`). If the
user signed out of Google in that browser, the popup asks them to reconnect.

*Disconnect* forgets the token and the account state in that browser only.
It does not call Google's revoke endpoint: revoking removes the grant for the
whole account, which would sign out every other connected browser too.

## Backups and restore

A backup is the full local tree with UUIDs. Restoring is treated as a local
edit made now: backup items come back, everything else gets a tombstone, and
the result syncs to every browser. A backup of the current state is made
before each restore.

## Importing from other browsers

An extension cannot read another browser's bookmarks directly, so there are two sources:

- **Another browser with Marksync.** Every connected browser uploads its own
  tree to `browsers/<device id>.json` (only when it changed), even with sync
  turned off. Settings → Import lists these browsers.
- **An HTML file** exported by any browser (Chrome, Edge, Firefox, Safari...).
  `core/import.ts` reads the Netscape bookmark format with a small tokenizer, so
  it runs in the service worker. `PERSONAL_TOOLBAR_FOLDER` marks the bar;
  `UNFILED_BOOKMARKS_FOLDER` marks a Firefox file, whose loose top-level items
  are the Bookmarks Menu. No Google account is needed for this.

Two modes (`sync/importer.ts`): **merge** into the matching top-level folders,
reusing folders with the same name and skipping bookmarks whose URL already
exists in that folder; or **folder**, everything under a new
"Imported from ..." folder. Imports run with sync on hold; the next sync sends
the new bookmarks to all browsers.

## Known limits / roadmap

- Order uses integer positions; concurrent reorders of one folder resolve to
  the latest one. Fractional indexes would merge them.
- Changes from other browsers arrive on the next alarm (no push).
- Not synced: favicons, separators, Firefox tags and keywords.
- Ideas: optional end-to-end encryption with a passphrase, more UI languages,
  Safari build, conflict history view.

## Interface

- **Languages**: English and Turkish, following the browser's language.
  Texts live in `src/public/_locales/<lang>/messages.json`; pages mark
  elements with `data-i18n` and code calls `t()` (`src/shared/i18n.ts`).
  `tests/i18n.test.ts` fails if a key is missing or the languages differ.
  The pure layers (`src/core`, `src/sync`) stay free of browser APIs, so their
  rare error messages (a broken or oversized file) are English only.
- **Toolbar badge**: a red `!` when sync cannot run (sign-in, setup, broken
  file), an amber `!` when a large deletion waits for a decision. Network
  errors get no badge; they are usually a computer going offline. The
  tooltip says what is wrong (`src/services/badge.ts`).
- **First install** opens Settings with a short welcome and the Connect button.
