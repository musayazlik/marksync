import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { MarksyncDrive } from './drive';

/**
 * The tools. Reading works without any browser open (straight from Drive);
 * writing is only ever a proposal the user approves in the extension.
 */

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

export function createServer(drive: MarksyncDrive, version: string): McpServer {
  const server = new McpServer({ name: 'marksync', version });

  server.registerTool(
    'search_bookmarks',
    {
      description:
        "Search the user's bookmarks (synced by Marksync across their browsers) by words in the title, address, folder or tags. A word starting with # filters by tag. Returns ids, titles, addresses, folders and tags.",
      inputSchema: z.object({
        query: z.string().min(1).max(200).describe('Words to look for, e.g. "postgres docs" or "#recipe pasta".'),
        limit: z.number().int().min(1).max(100).optional().describe('Results at most (default 20).'),
      }),
    },
    async ({ query, limit }) => {
      try {
        return json((await drive.library()).search(query, limit ?? 20));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_folders',
    {
      description: 'Every bookmark folder with its id, full path and how many bookmarks and subfolders it holds. Use the ids in list_folder and propose_changes.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return json((await drive.library()).folders());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_folder',
    {
      description: 'The subfolders and bookmarks directly in one folder, given by id, by top-level key (toolbar, menu, other, mobile) or by its full path.',
      inputSchema: z.object({ folder: z.string().min(1).max(500) }),
    },
    async ({ folder }) => {
      try {
        const found = (await drive.library()).listFolder(folder);
        return found ? json(found) : fail(`No folder "${folder}". Use list_folders to see the folders.`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_bookmark',
    {
      description: 'One bookmark (or folder) by id: title, address, folder and tags.',
      inputSchema: z.object({ id: z.string().min(1).max(128) }),
    },
    async ({ id }) => {
      try {
        const found = (await drive.library()).get(id);
        return found ? json(found) : fail(`No bookmark or folder with id "${id}".`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  const change = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('move'), recordId: z.string().describe('Bookmark or folder id.'), toFolderId: z.string().describe('Target folder id or top-level key.'), reason: z.string().max(200).optional() }),
    z.object({ kind: z.literal('retitle'), recordId: z.string().describe('Bookmark id.'), title: z.string().min(2).max(120), reason: z.string().max(200).optional() }),
    z.object({ kind: z.literal('rename'), folderId: z.string(), name: z.string().min(2).max(60), reason: z.string().max(200).optional() }),
    z.object({ kind: z.literal('merge'), folderId: z.string().describe('Folder to merge away.'), intoId: z.string().describe('Folder that takes its contents.'), reason: z.string().max(200).optional() }),
  ]);

  server.registerTool(
    'propose_changes',
    {
      description:
        "Propose changes to the user's bookmarks: move a bookmark or folder, retitle a bookmark, rename a folder, or merge one folder into another. Nothing changes now: the proposals wait until the user opens Marksync's Settings, where they review, edit and approve each one (and can undo it later). Use ids from the other tools.",
      inputSchema: z.object({
        changes: z.array(change).min(1).max(200),
        assistant: z.string().max(60).optional().describe('Your name, shown to the user next to the proposals (e.g. "Claude").'),
      }),
    },
    async ({ changes, assistant }) => {
      try {
        const library = await drive.library(true);
        const { ok, refused } = library.checkProposals(changes, assistant ?? 'AI assistant', Date.now());
        const waiting = ok.length ? await drive.addProposals(ok) : 0;
        return json({
          saved: ok.length,
          refused,
          waiting,
          next: ok.length ? 'The user sees the proposals the next time they open Marksync Settings, and approves them there.' : 'Nothing was saved.',
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
