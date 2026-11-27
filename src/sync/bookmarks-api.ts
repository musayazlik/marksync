/**
 * The part of the `bookmarks` WebExtension API that sync uses. The background
 * script passes `browser.bookmarks`; tests pass an in-memory fake.
 */
export interface BookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  /** Firefox: 'bookmark' | 'folder' | 'separator'. */
  type?: string;
  /** When the bookmark was created, in milliseconds since the epoch. */
  dateAdded?: number;
  /** Chrome 114+: when the bookmark was last opened. */
  dateLastUsed?: number;
  /** Chrome 134+: 'bookmarks-bar' | 'other' | 'mobile' | 'managed'. */
  folderType?: string;
  /**
   * Chrome 134+: true for the copy of a top-level folder that is stored in
   * the user's Google account; false for the "only on this device" copy.
   */
  syncing?: boolean;
  /** Chromium: set on managed (policy) bookmarks, which cannot be changed. */
  unmodifiable?: string;
  children?: BookmarkNode[];
}

export interface BookmarksApi {
  getTree(): Promise<BookmarkNode[]>;
  getChildren(id: string): Promise<BookmarkNode[]>;
  create(details: { parentId: string; title: string; url?: string; index?: number }): Promise<BookmarkNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkNode>;
  move(id: string, destination: { parentId?: string; index?: number }): Promise<BookmarkNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
  /**
   * Opera only: its extra top-level folders, e.g. 'unsorted', 'trash',
   * 'speed_dial'. Their IDs differ between installs, so they are looked up.
   */
  getRootByName?(name: string): Promise<BookmarkNode | undefined>;
}

export type BrowserFlavor = 'chromium' | 'firefox';
