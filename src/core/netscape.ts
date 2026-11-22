import { ROOT_TITLES } from './import';
import { childrenByParent } from './records';
import type { RecordMap } from './types';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Exports records in the Netscape bookmark file format, which every browser
 * can import (Settings → Import bookmarks → HTML file). The layout follows
 * Firefox: Bookmarks Menu items at the top level, the bar and Other
 * bookmarks marked with attributes, so `parseNetscapeHtml` reads it back
 * into the same top-level folders.
 */
export function toNetscapeHtml(records: RecordMap): string {
  const groups = childrenByParent(records);
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];
  const walk = (parentId: string, depth: number) => {
    const pad = '    '.repeat(depth);
    for (const r of groups.get(parentId) ?? []) {
      if (r.kind === 'folder') {
        lines.push(`${pad}<DT><H3>${esc(r.title)}</H3>`, `${pad}<DL><p>`);
        walk(r.id, depth + 1);
        lines.push(`${pad}</DL><p>`);
      } else {
        lines.push(`${pad}<DT><A HREF="${esc(r.url ?? '')}">${esc(r.title)}</A>`);
      }
    }
  };
  const section = (key: 'toolbar' | 'other' | 'mobile', attr: string) => {
    if (!groups.get(key)?.length) return;
    lines.push(`    <DT><H3${attr}>${ROOT_TITLES[key]}</H3>`, '    <DL><p>');
    walk(key, 2);
    lines.push('    </DL><p>');
  };
  walk('menu', 1);
  section('toolbar', ' PERSONAL_TOOLBAR_FOLDER="true"');
  section('other', ' UNFILED_BOOKMARKS_FOLDER="true"');
  section('mobile', '');
  lines.push('</DL><p>');
  return lines.join('\n');
}
