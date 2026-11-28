# marksync-mcp

An [MCP](https://modelcontextprotocol.io) server for [Marksync](https://github.com/musayazlik/marksync):
let AI assistants (Claude Desktop, Claude Code, Cursor, ...) search the bookmarks Marksync syncs
between your browsers, and propose changes that you approve in the extension.

- **Reads** straight from the Marksync folder in your Google Drive (`sync-state.json`, `tags.json`),
  so it works without any browser open. End-to-end encrypted libraries are read with your passphrase.
- **Never edits your bookmarks.** `propose_changes` writes proposals to `Marksync/proposals.json`.
  The next time you open Marksync's Settings they appear in the *Tidy up the library* review,
  where you tick, apply and later undo them.
- Asks Google only for `drive.file`: access to the files Marksync created, nothing else in your Drive.

## Tools

| Tool | What it does |
|---|---|
| `search_bookmarks` | Words in title, address, folder or tags; `#tag` filters by tag |
| `list_folders` | Every folder with id, path and counts |
| `list_folder` | Subfolders and bookmarks of one folder (id, `toolbar`/`menu`/`other`/`mobile`, or path) |
| `get_bookmark` | One bookmark or folder by id |
| `propose_changes` | Move, retitle, rename a folder or merge folders; approved by you in Marksync |

## Setup

1. **Google OAuth client.** In the Google Cloud project that holds Marksync's OAuth client (see
   [docs/GOOGLE_SETUP.md](../docs/GOOGLE_SETUP.md)), create another OAuth client of type
   *Desktop app*. It must be in the **same project**: `drive.file` lets the project's apps see the
   files any of them created, which is how this server sees the Marksync folder.
2. **Sign in once:**

   ```sh
   MARKSYNC_GOOGLE_CLIENT_ID=… MARKSYNC_GOOGLE_CLIENT_SECRET=… npx marksync-mcp login
   ```

   A browser opens for Google's consent page. The refresh token is stored in
   `~/.config/marksync-mcp/credentials.json` (`%APPDATA%\marksync-mcp` on Windows), readable only by you.
   `npx marksync-mcp logout` removes it.
3. **Add it to your MCP client**, for example Claude Desktop's `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "marksync": {
         "command": "npx",
         "args": ["-y", "marksync-mcp"],
         "env": {
           "MARKSYNC_GOOGLE_CLIENT_ID": "….apps.googleusercontent.com",
           "MARKSYNC_GOOGLE_CLIENT_SECRET": "…",
           "MARKSYNC_PASSPHRASE": "only if end-to-end encryption is on"
         }
       }
     }
   }
   ```

   Claude Code: `claude mcp add marksync -e MARKSYNC_GOOGLE_CLIENT_ID=… -e MARKSYNC_GOOGLE_CLIENT_SECRET=… -- npx -y marksync-mcp`

## Privacy

Your bookmarks go from Google Drive to this server on your computer, and from there to the AI
assistant you connect it to (that is the point of it). Nothing goes anywhere else. With encryption
on, the passphrase stays in your MCP client's configuration; proposals are written encrypted.

## Development

```sh
cd mcp
npm install
npm run typecheck
npm run build      # dist/index.js, one file with the parts of Marksync's core it uses
```

The tests run with the extension's tests (`pnpm test` at the repository root, `tests/mcp.test.ts`).
