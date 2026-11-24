import { findDuplicates, type DuplicateGroup } from '../core/dedupe';
import { statusItem } from '../shared/state';
import { removeCopies } from '../sync/dedupe';
import { detectSpecialRoots } from '../sync/local-tree';
import { createBackup } from './backup-service';
import { localBookmarks } from './sync-service';

/**
 * The duplicate finder (duplicates page). Scanning only reads; removing goes
 * through the normal bookmarks API, so the removals sync to every browser
 * like any other change.
 */

export async function scanDuplicates(): Promise<DuplicateGroup[]> {
  const bookmarks = localBookmarks();
  const [tree, special] = await Promise.all([bookmarks.getTree(), detectSpecialRoots(bookmarks)]);
  return findDuplicates(tree, { exclude: special.exclude });
}

export interface RemoveDuplicatesResult {
  removed: number;
  /** Already gone, changed to another page, or not removable. */
  skipped: number;
  /** A backup was saved to Drive first. */
  backedUp: boolean;
}

/**
 * Removes the given copies (id → the normalized address it was listed under).
 * When connected to Drive, a backup is saved first; if that fails, nothing is
 * removed, because removing without the safety net is not what the user agreed to.
 */
export async function removeDuplicates(expected: Record<string, string>): Promise<RemoveDuplicatesResult> {
  if (!Object.keys(expected).length) return { removed: 0, skipped: 0, backedUp: false };
  let backedUp = false;
  if ((await statusItem.getValue()).connected) {
    await createBackup('before-cleanup');
    backedUp = true;
  }
  return { ...(await removeCopies(localBookmarks(), expected)), backedUp };
}
