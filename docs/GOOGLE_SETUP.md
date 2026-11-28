# Google Cloud setup

Marksync signs in with Google and stores files in the user's own Drive. Each
build of the extension needs an OAuth client ID. The client ID is public (it
ships inside the extension), so it is fine to commit it in a fork's release
pipeline. There is no client secret.

## 1. Create the project

1. Open <https://console.cloud.google.com/> and create a project, e.g. "Marksync".
2. **APIs & Services → Library** → enable **Google Drive API**.

## 2. Consent screen

**Google Auth Platform** (formerly "OAuth consent screen"):

1. **Branding**: app name, support email, logo (optional while testing).
2. **Audience**: *External*. While the app is in *Testing*, add the Google
   accounts that may sign in under **Test users** (up to 100).
3. **Data access** → **Add or remove scopes** and add:
   - `.../auth/drive.file` – files this app creates in the user's Drive
   - `openid`
   - `.../auth/userinfo.email`

`drive.file` is a non-sensitive scope, so publishing the app later needs brand
verification only, not the security assessment that full Drive access requires.

## 3. OAuth client

**Clients → Create client → Web application** (not "Chrome extension": that
type only works with `identity.getAuthToken`, which Brave and Firefox do not
support).

Create **two** clients: one for store builds (production) and one for
development builds. Google hands a token to whichever extension owns a
registered redirect URI, so a development ID (an unpacked extension anyone
can reproduce from a public key) must never be registered in the production
client.

**Production client**, Authorized redirect URIs, one per store ID:

| Where the extension comes from | Redirect URI |
|---|---|
| Chrome Web Store: Chrome, Brave, Vivaldi, Arc, and Edge/Opera users who install from there | `https://<chrome-web-store-id>.chromiumapp.org/` |
| Edge Add-ons (assigns its own ID) | `https://<edge-addons-id>.chromiumapp.org/` |
| Opera Add-ons (assigns its own ID) | `https://<opera-addons-id>.chromiumapp.org/` |
| Firefox Add-ons (Firefox, LibreWolf, Waterfox, Zen, Floorp) | `https://<hash>.extensions.allizom.org/` for your own `WXT_GECKO_ID` |

**Development client**: the redirect URIs your development builds show
(pinned `WXT_EXTENSION_KEY` ID, Firefox development ID).

Chrome Web Store + Firefox Add-ons alone cover every supported browser, so
two redirect URIs are enough to start. Publishing to Edge Add-ons and Opera
Add-ons is optional and adds one URI each.

The exact URI for the browser you are in is shown at the bottom of the
extension's Settings page in **development builds** (`pnpm dev`,
`pnpm build:dev`, `pnpm build:dev:firefox`). Store builds (`pnpm build`,
`pnpm zip`) do not show it; end users never need it.

Put the client IDs in `.env`:

```sh
WXT_GOOGLE_CLIENT_ID=1234567890-prod.apps.googleusercontent.com
WXT_GOOGLE_CLIENT_ID_DEV=1234567890-dev.apps.googleusercontent.com
```

Development builds use `WXT_GOOGLE_CLIENT_ID_DEV` when it is set; store
builds always use `WXT_GOOGLE_CLIENT_ID`.

The client ID is compiled into the extension. End users only click
"Connect Google Drive"; they never see or enter it. A fork uses its own `.env`.

## 4. Firefox add-on ID (required for store builds)

The Firefox redirect URI is computed from the add-on ID, so the ID must be one
nobody else can claim. Set `WXT_GECKO_ID` to an address on a domain you
control (`marksync@yourdomain.com`) or to the UUID addons.mozilla.org assigns,
and register that add-on on AMO under your account before adding its redirect
URI to the production client. A production Firefox build **fails** when
`WXT_GECKO_ID` is empty or a placeholder (`@example.org`, `.invalid`, ...).
Never register a redirect URI for an ID you do not own.

## 5. Same extension ID in Chrome, Brave and Edge while developing

An unpacked extension gets an ID from its folder path, so every machine and
browser would need its own redirect URI. Pin it with a key instead:

```sh
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out key.pem
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
```

Put the printed value in `.env` as `WXT_EXTENSION_KEY=...`, run
`pnpm build:dev`, load `.output/chrome-mv3-dev` and read its ID on
`chrome://extensions`. Do not commit `key.pem`. The key is added only to
development builds; store builds get their ID from the store. Register this
ID's redirect URI in the development client only.

## 6. More clients in the same project (optional)

`drive.file` gives a project's apps access to the files any of them created,
so these clients must be in the **same project** as the extension's: then
they see the Marksync folder the extension created.

| For | Client type | Settings |
|---|---|---|
| The web viewer (`viewer/`, the PWA for phones) | Web application | **Authorized JavaScript origins**: the viewer's origin, e.g. `https://<user>.github.io` |
| The MCP server (`mcp/`, `marksync-mcp`) | Desktop app | none (it signs in through `http://127.0.0.1`) |

The web viewer's client ID goes into the repository variable
`VIEWER_GOOGLE_CLIENT_ID` (Settings → Secrets and variables → Actions →
Variables); the "Web viewer" workflow builds and publishes the viewer to
GitHub Pages only when it is set (Settings → Pages → Source: GitHub Actions).
For a local build put it in `.env` as `VITE_GOOGLE_CLIENT_ID` and run
`pnpm build:viewer` (output in `.output/viewer`).

The MCP server's client ID and secret are set by each user in their MCP
client configuration (see [mcp/README.md](../mcp/README.md)). A Desktop
client's secret is not confidential (Google treats installed apps as public
clients), but it still belongs in local configuration, not in the repository.
