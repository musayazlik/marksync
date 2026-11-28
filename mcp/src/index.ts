import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { MarksyncDrive } from './drive';
import { accessToken, clientFromEnv, forgetAccessToken, login, logout } from './google';
import { createServer } from './server';

/**
 * marksync-mcp: an MCP server over the bookmarks Marksync keeps in Google Drive.
 *
 *   marksync-mcp login    sign in with Google once (opens the browser)
 *   marksync-mcp logout   forget the stored sign-in
 *   marksync-mcp          run the server on stdio (what an MCP client starts)
 *
 * stdout belongs to the MCP protocol; messages go to stderr.
 */

declare const __VERSION__: string;
const version = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0';
const log = (line: string) => process.stderr.write(`${line}\n`);

async function main() {
  const command = process.argv[2];
  if (command === '--version' || command === '-v') {
    log(version);
    return;
  }
  if (command === 'logout') {
    await logout();
    log('Signed out.');
    return;
  }
  const client = clientFromEnv();
  if (command === 'login') {
    await login(client, log);
    log('Signed in. Add marksync-mcp to your MCP client (see the README).');
    return;
  }
  if (command && command !== 'serve') {
    log(`Unknown command "${command}". Use: login, logout, or no argument to run the server.`);
    process.exitCode = 2;
    return;
  }
  const drive = new MarksyncDrive(
    () => accessToken(client),
    async () => forgetAccessToken(),
    process.env.MARKSYNC_PASSPHRASE || undefined,
  );
  const server = createServer(drive, version);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
