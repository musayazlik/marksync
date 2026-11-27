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
    ai-sort.ts   AI sorting: folder list, prompt, reply schema, checking the model's reply
    ai-provider.ts  AI providers: endpoint addresses, model lists, on-device model limits
    openrouter-data.ts  OpenRouter model list and key usage: parsing, search, gauge
    budget.ts    Monthly AI spending cap
    dedupe.ts    Duplicate finder: URL normalization and grouping
    history.ts   Version history: backup-vs-now diff, partial restore plan, search in a backup
    tags.ts      Tags: cleaning, newest-edit-wins merge, tags.json validation
    tidy.ts      "Tidy up the library": folder summary, prompts, checking the plan, cost estimate
    links.ts     Link checker: which addresses to check, verdicts, Wayback answers
    search.ts    Popup bookmark search (accent-insensitive, ranked, highlight ranges)
    crypto.ts    Passphrase → key (PBKDF2), AES-GCM envelopes, passphrase strength
    mask.ts      Masks the account e-mail on screen
  sync/        Talks to the bookmarks API through an interface
    local-tree.ts  Read the local tree (Chromium/Firefox roots) and apply a state to it
    engine.ts      One sync run: load → diff → merge → apply → upload
    sorter.ts      File one inbox bookmark with the model's answer (or only propose it); undo
    tidy.ts        Apply one approved tidy-up change (re-checked first); undo
    dedupe.ts      Remove the chosen duplicate copies (re-checked first)
  platform/    Browser and Google specifics
    identity.ts    Google sign-in with launchWebAuthFlow
    drive.ts       Google Drive v3 REST client
    openrouter.ts  OpenAI-compatible client (OpenRouter or the user's server): chat completions, model lists, key usage
    builtin-ai.ts  The browser's on-device model (Prompt API): availability, download, prompt
  services/    Wires the engine to Drive and extension storage
  entrypoints/ background (events, alarms, messages), popup, options, sorter-log, duplicates, links
tests/         In-memory Chromium and Firefox fakes, end-to-end sync tests
```

## Files in Google Drive

```
My Drive/Marksync/
  sync-state.json   { schema, records: { [id]: SyncRecord }, updatedAt, updatedBy, epoch? }
  backups/          one JSON file per backup, newest N kept
  browsers/         <device id>.json: each browser's own tree, for importing
  encryption.json   only with encryption on: salt, iterations, key ID, check value
```

`epoch` is a random ID given to the sync file when it is created from
scratch. A browser whose local history belongs to another epoch (the folder
was deleted in Drive, or encryption was reset) starts over like a first sync:
its bookmarks are matched with the new file instead of uploaded again, and
nothing counts as deleted. Files written before 0.3 have no epoch and are
left that way.

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

**Version history** (`history.html`, `services/history-service.ts`) compares
one backup with the current local tree (`core/history.ts` `diffBackup`):
removed, moved, renamed and added items, grouped by the folder they were in
then. A removed or added folder is one change with the number of items in
it; a reorder inside a folder is not listed. Ticked items come back through
`planRestore`: a removed bookmark or folder (with its contents) is created
again in its old folder, or in a "Restored (date)" folder under Other
bookmarks when that folder is gone too; a moved item is moved back; a
renamed item gets its old title and address. Items added since the backup
cannot be "restored". The plan runs through the bookmarks API with sync on
hold, after a `before-restore` backup (the compared backup is kept), and the
result syncs as ordinary local changes. "Find in backups" downloads the
newest 60 backups and lists those with a bookmark whose title or address
contains the search.

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

## Duplicate finder

`duplicates.html` lists every page bookmarked more than once. Addresses are
compared after `core/dedupe.ts` `normalizeUrl`: http and https are equal, the
host is compared without case, default ports, a trailing slash, the fragment
(except app routes like `#/inbox`) and tracking parameters (`utm_*`,
`fbclid`, `gclid`, …) are ignored, and the remaining parameters are sorted.
`www.` is kept, since it can be a different site. Non-web addresses, managed
bookmarks and Opera's Trash and Speed Dial are skipped.

The oldest copy is suggested to keep (then the one filed deepest). Removing
takes a backup first when connected to Drive (reason `before-cleanup`), then
removes each chosen copy only if it still normalizes to the address it was
listed under. Removals are ordinary local changes and sync everywhere; the
mass-delete guard still applies.

## Link checker

`links.html` checks every bookmark's address and lists the ones that are
gone, have moved or gave no clear answer. Starting it asks for the optional
host permission `*://*/*` (and, in Firefox 140+, consent for `bookmarksInfo`).

The scan runs in the background (`services/links-service.ts`), so it goes on
while the page is closed; progress and results live in `storage.local`
(`linkScan`). Four requests run at once, never two to the same host, each
with a 12 s timeout and without cookies. A `HEAD` request comes first and a
`GET` follows when the answer is one that `HEAD` often gets wrong; a page that
looks dead is checked once more after 2 s before it is listed. Addresses that
are not http(s), or that point to this computer or a private network, are
never requested (`core/links.ts` `isCheckable`).

Verdicts (`classify`): 404 and 410 and unreachable sites are **gone**; a
redirect to a different page (not just https, `www.`, a trailing slash or
tracking parameters) is **moved**; sign-in walls (401, 403), rate limits,
server errors and timeouts are **unclear** and never offered for bulk removal.
For each gone page the Wayback Machine availability API is asked for the
closest working snapshot (`parseWayback` accepts only `web.archive.org`).

A scan interrupted by the browser closing can be continued: the checked IDs
are kept. Each fix re-reads the bookmark and does nothing if its address
changed since the scan. *Remove all* takes a backup first when connected
(reason `before-cleanup`). Fixes are ordinary local changes and sync
everywhere.

## AI sorting (optional)

Off by default and set up per browser in Settings: an inbox folder, an
OpenRouter API key (stored in `storage.local`, never uploaded), a model ID
(default `anthropic/claude-opus-5.5`; Sonnet and Gemini Flash are suggested
as faster, cheaper choices), whether the model may research the site on the
web (on by default) and whether new folders may be created. Turning it on asks for the optional host permission
`https://openrouter.ai/*` (and, in Firefox 140+, consent for `bookmarksInfo`).

1. **Trigger**: a bookmark created in, or moved into, the inbox *in this
   browser* (`services/sorter-service.ts`). Changes written by sync or an
   import are ignored, so two browsers with AI sorting on never handle the
   same bookmark. After 5 s of quiet (the star dialog may still rename or
   move it), the bookmark is queued; bookmarks are sorted one at a time.
2. **Prompt** (`core/ai-sort.ts`): the bookmark's title and address without
   query string or fragment, and up to 300 folders (breadth-first) as
   `f12: Bookmarks bar / Work / Docs`. The bookmark text is marked as data.
   With research on, the request carries OpenRouter's `openrouter:web_fetch`
   and `openrouter:web_search` server tools: the model reads the page and,
   if needed, searches the web before answering. The answer is streamed, and
   an extension API call every 20 s keeps the service worker alive, because
   Chrome stops a worker that waits more than 30 s for a `fetch()` response.
3. **Reply**: JSON `{folder, newFolder?, confidence, reason, site}`, where
   `site` is `{name, category, summary, purpose}`: what the site is and what
   it is used for, in the UI language. Only offered
   references are accepted; anything else is an error and the bookmark stays.
   Confidence below 0.35 or `folder: null` keeps it in the inbox. A proposed
   new folder that already exists under that parent becomes a move.
4. **Act** (`sync/sorter.ts`): read the tree again; if the user moved the
   bookmark meanwhile, do nothing. Otherwise move it (creating the folder
   first if needed). The move is an ordinary local change and syncs.
5. **Log**: every decision goes to `local:sortLog` (newest 500) with the site
   description, the pages the model cited (http/https only) and the cost
   OpenRouter reported. `sorter-log.html` shows them with filters, search and **Undo** (moves the bookmark
   back to the inbox, removes a folder the model created if it is empty, and
   is not sorted again). The log is per browser and not synced.

**Providers** (`services/ai-client.ts`). Settings picks who runs the model;
sorting and bulk sorting both ask through the same runner:

| Provider | Requests go to | Permission | Research | Cost and cap |
|---|---|---|---|---|
| `openrouter` (default) | `https://openrouter.ai/api/v1` | `https://openrouter.ai/*` | yes | reported, monthly cap applies |
| `custom` | the saved base URL, e.g. `http://localhost:11434/v1` (Ollama), `http://localhost:1234/v1` (LM Studio) | that host only, asked when the address is saved | no | none |
| `builtin` | the browser's own model (`LanguageModel`, Chrome 138+) | none | no | none |

The `custom` endpoint gets the same chat-completions request without
OpenRouter's attribution headers and server tools, an optional Bearer key
(`local:aiEndpointKey`, never uploaded) and the reply schema as
`response_format: json_schema` (the folder refs as an enum); a server that
answers 400 to that is asked again without it. "Test" lists its models
(`GET /models`). The `builtin` model runs in the service worker, gets a
fresh session per bookmark, the reply schema as `responseConstraint`, at
most 120 folders (its context is small) and writes in English, Spanish,
Japanese, German or French. Its download (a few GB) needs a click, so
Settings starts it. Log entries and bulk runs record the provider; a bulk
run keeps the provider and model it started with.

**Model picker and usage.** Settings lists OpenRouter's models
(`GET /api/v1/models`, cached in `local:aiModels` for 6 hours) with search,
Free / Web research filters, price per 1M tokens and context size; any other
model ID can still be typed in. Models without tool support are sorted
without research even when Research is on. The popup shows the key's
spending (`GET /api/v1/key`, plus `/api/v1/credits` when the key may read
the account balance) as a gauge of what is left under the key limit, or of
the account balance when the key is unlimited, with today / week / month
totals. The numbers are kept in `local:aiUsage` and refreshed when the popup
opens and a few seconds after paid requests. Both requests go through the
background script; the popup and Settings never read the key.

"Sort inbox now" handles bookmarks already waiting in the inbox (50 per
click) and stops at the first key, credit or permission error.

## Known limits / roadmap

- Order uses integer positions; concurrent reorders of one folder resolve to
  the latest one. Fractional indexes would merge them.
- Changes from other browsers arrive on the next alarm (no push).
- Not synced: favicons, separators, Firefox tags and keywords.
- Ideas: more UI languages, Safari build, a per-sync-run change log (which browser changed what), changing the
  encryption passphrase without turning encryption off and on.

## Encryption (optional, `services/encryption-service.ts`)

Every Drive read and write goes through the codec that `DriveClient` gets
from `drive-store.ts`. With the key, file contents become envelopes
`{ marksyncEncrypted: 1, keyId, iv, data }` (AES-256-GCM, key ID as
additional data); without encryption they stay plain JSON. Plain files are
always readable, so old backups restore and turning encryption on or off is
a rewrite of each file, not a schema change.

- **On**: `encryption.json` is created (two browsers at once: the older file
  wins), the key is kept in `local:encryptionKey`, and every file in the
  Marksync folder is rewritten encrypted.
- **Other browsers** read an envelope or find `encryption.json` and become
  *locked* (`LockedError`, status code `locked`, amber badge): they write
  nothing until the passphrase is entered. They never fall back to writing
  plain data while encryption is on.
- **Off**: every file is rewritten plain and `encryption.json` deleted. A
  browser that still has the key notices on its next write (the remote info
  is cached for a minute per account folder) and drops it.
- **Forgot the passphrase**: encrypted files and `encryption.json` are
  deleted, this browser's sync history is reset and sync starts over; other
  browsers match their bookmarks thanks to `epoch`.
- Not encrypted: Drive metadata (file names, dates, `appProperties` with
  browser names and counts). Disconnecting clears the key.

## AI extras

- **Monthly budget** (`core/budget.ts`): AI sorting counts what OpenRouter
  reports for its own requests in this browser per calendar month
  (`local:aiSpend`). At the cap, bookmarks stay in the inbox with a `budget`
  log entry and bulk sorting stops; the popup warns from 80 %.
- **Bulk sorting** (`services/bulk-service.ts`): the model proposes a folder
  for up to 100 bookmarks of a chosen folder (`sortOne` with `plan: true`,
  three requests at a time, never into the inbox). The run lives in
  `local:aiBulk` and resumes after a service-worker restart. Approved
  proposals are applied with `applyPlanned`, which checks the bookmark is
  still where it was and reuses folders created in the same batch; each move
  is logged and can be undone.

## Tidy up the library (`services/tidy-service.ts`)

Settings → AI sorting → *Tidy up the library*, for everything or one
folder. Before the run, an estimate shows the number of requests and, on
OpenRouter, the expected cost (prompt size / 4 as tokens, times the model's
price per 1M tokens). The plan has four kinds of proposals:

- **merge** and **rename** folders: one request with the folder list
  (`f12: path (n bookmarks) e.g. "title", ...`, at most 300 folders). Only
  offered refs count; top-level folders, the inbox and the scope are never
  merged or renamed; a folder is never merged into its own subtree; a rename
  that clashes with a sibling is dropped.
- **retitle** bookmarks: up to 200 titles in requests of 40; the model lists
  only titles that are clearly worse (bare addresses, tracking strings,
  slogans).
- **remove** empty folders: found without the model (the topmost folder of
  an empty chain; a separator counts as content).

Proposals are kept in `local:aiTidy`, grouped by kind and all ticked. *Apply*
takes a `before-cleanup` backup when connected, then applies titles, renames,
merges and removals in that order with sync on hold, re-checking each item
first (a title or name changed since the plan is left alone). Every applied
change is a `tidied` entry in the sorting log with what Undo needs: the old
title or name, or the folder's parent, position and moved items, so a merged
or removed folder comes back where it was.

## Tags

Browsers have no synced tags, so Marksync keeps its own: `local:tags` in
each browser (by shared record ID), merged with `Marksync/tags.json` in
Drive after every sync and a few seconds after an edit
(`services/tags-service.ts`). They are deliberately not in
`sync-state.json`: older versions drop unknown record fields and would wipe
them. Each bookmark's tag list is one value with a clock; the newest edit
wins, an empty list is a removal that reaches the other browsers, and tags
of bookmarks that no longer exist are dropped. A tag set on a bookmark that
has no shared ID yet waits in `pending` until the next sync gives it one.
The file version guards the write; a concurrent write from another browser
is merged on a retry. With encryption on, `tags.json` is encrypted like the
other files.

AI sorting proposes 1-3 tags (reusing the user's existing ones) and gives
them to the bookmark only if it has none. The popup shows tags on results,
edits them inline and filters with `#tag` (also by prefix; `#italian-food`
for "italian food"); the most used tags are listed under the search box.
Firefox's own tags are not readable through the WebExtension API, so they
cannot be imported.

## Popup search

The popup searches this browser's bookmarks as you type (`core/search.ts`):
every word must appear in the title, address, folder path or the site
description AI sorting saved; case and accents are ignored and matches are
highlighted. Enter opens in a new tab, Shift+Enter in the current tab,
Ctrl+Enter in the background; `/` focuses the field.

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
