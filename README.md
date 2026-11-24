# Marksync

[![CI](https://github.com/musayazlik/marksync/actions/workflows/ci.yml/badge.svg)](https://github.com/musayazlik/marksync/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/musayazlik/marksync)](https://github.com/musayazlik/marksync/releases)

Open-source bookmark sync for **Chrome, Brave, Edge and Firefox**, with
backups in **your own Google Drive**.

Add a bookmark in Brave, open Firefox, and it is there, in the same folder
and position. No account on a third-party server: everything is stored in a
`Marksync` folder in your Google Drive, and the extension cannot see any
other file there.

[Türkçe](README.tr.md)

## Features

- Two-way sync between Chromium browsers and Firefox, on any number of computers
- Bookmarks bar, Other bookmarks, Mobile and Firefox's Bookmarks Menu mapped between browsers
- Conflict handling per field: a rename in one browser and a move in another both survive
- No duplicates when you connect a browser that already has the same bookmarks
- Safety stop when a sync would delete most of your bookmarks
- Automatic and manual backups in Google Drive, restore with one click
- Import from another browser (with Marksync, or from any browser's HTML export), merged without duplicates or into a new folder
- Export to a standard HTML bookmarks file
- Interface in English and Turkish; a badge on the toolbar icon when sync needs you
- Optional AI sorting with your own [OpenRouter](https://openrouter.ai) key: pick an inbox folder, and bookmarks you add to it are moved to the folder that fits best; every decision is listed on a log page with Undo

## Supported browsers

| Browser | Install from | Notes |
|---|---|---|
| Chrome, Brave, Vivaldi, Arc, Yandex and other Chromium browsers | Chrome Web Store | Chrome signed in to Google: both the account and the "only on this device" bookmarks are synced |
| Microsoft Edge | Edge Add-ons, or Chrome Web Store | |
| Opera | Opera Add-ons, or Chrome Web Store | "Unsorted bookmarks" is synced as Other bookmarks; Trash and Speed Dial are not synced |
| Firefox, LibreWolf, Waterfox, Zen, Floorp (desktop) | Firefox Add-ons | Bookmarks Menu appears as a "Bookmarks Menu" folder in Chromium browsers |
| Safari | not possible | Safari extensions have no bookmarks API. Export an HTML file from Safari and import it in another browser |
| Mobile browsers | not possible | No extension bookmarks API on Android or iOS |

The sync rules are tested against simulated Chrome (with and without a Google
account), Opera and Firefox bookmark trees (`tests/`). Vivaldi and Arc have not
been tested yet; reports are welcome.

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

Requirements: Node.js 20+, pnpm.

```sh
pnpm install
cp .env.example .env      # add your Google OAuth client ID, see docs/GOOGLE_SETUP.md
pnpm dev                  # Chrome with hot reload
pnpm dev:firefox          # Firefox
pnpm test                 # unit and end-to-end sync tests
pnpm typecheck
pnpm build:dev            # development build to load unpacked (.output/chrome-mv3-dev)
pnpm build:all            # store builds; Firefox needs WXT_GECKO_ID set to an ID you own
pnpm zip:all              # store packages (+ sources zip for Firefox Add-ons)
```

Releases are automated: see [CONTRIBUTING.md](CONTRIBUTING.md#releases). Every version's
changes are in [CHANGELOG.md](CHANGELOG.md), and its store packages are attached to the
[GitHub release](https://github.com/musayazlik/marksync/releases).

Load the build manually:

- **Chrome / Brave / Edge**: `chrome://extensions` (or `brave://`, `edge://`) → Developer mode →
  *Load unpacked* → `.output/chrome-mv3-dev` (from `pnpm build:dev`)
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
  `.output/firefox-mv3/manifest.json`

## Google sign-in

You need a Google Cloud project with the Drive API and an OAuth client of type
*Web application*. Step-by-step: [docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md).

## Privacy

- Requested Google scopes: `drive.file` (only files Marksync creates), `openid`, `email`.
- Bookmarks go straight from your browser to Google Drive; there is no Marksync server.
- Access tokens are kept in session storage and cleared when the browser closes.
- *Disconnect* unlinks only the browser you click it in; your other browsers stay connected.
  To remove Marksync's access everywhere, use https://myaccount.google.com/permissions.
- AI sorting is off by default. Only when you turn it on in a browser (which asks for permission
  to contact `openrouter.ai`), that browser sends the title and address (without the query string)
  of each bookmark you add to the inbox, plus your folder names, to OpenRouter and the model you
  chose. Your OpenRouter key is kept in that browser's local storage and never uploaded to Drive.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Licence: [MIT](LICENSE).
