import { TFolder, Vault } from 'obsidian';

/**
 * Helpers for finding and removing empty folders.
 *
 * Two entry points:
 *   - `pruneEmptyAncestors(path)` walks UP from a starting path, deleting
 *     each ancestor folder that's now empty. Used after a single file
 *     delete or rename to clean up the directory the file used to live in.
 *   - `pruneAllEmptyFolders()` walks the entire vault bottom-up and
 *     deletes every empty folder it finds. Used by the manual command
 *     and the "Delete all empty folders" settings button.
 *
 * Both honour ignore-path callbacks so cleanups don't reflect back as
 * file-watcher delete events. Vault root is always preserved.
 */
export class EmptyFolderService {
  private ignorePathFn: ((path: string) => void) | null = null;
  private unignorePathFn: ((path: string) => void) | null = null;

  constructor(private vault: Vault) {}

  setIgnorePathCallbacks(
    ignorePath: (path: string) => void,
    unignorePath: (path: string) => void
  ): void {
    this.ignorePathFn = ignorePath;
    this.unignorePathFn = unignorePath;
  }

  /**
   * Walk up from `startPath` (a file or folder path), deleting any ancestor
   * folder that has zero children after each deletion. Stops at the root or
   * the first non-empty folder. Returns the number of folders removed.
   */
  async pruneEmptyAncestors(startPath: string): Promise<number> {
    let parentPath = this.parentPath(startPath);
    let removed = 0;

    while (parentPath) {
      const node = this.vault.getAbstractFileByPath(parentPath);
      if (!(node instanceof TFolder)) break;
      if (node.children.length > 0) break;

      const deletedPath = node.path;
      try {
        if (this.ignorePathFn) this.ignorePathFn(deletedPath);
        await this.vault.delete(node);
        removed++;
      } catch (err) {
        console.warn(`[EmptyFolderService] Failed to delete empty folder ${deletedPath}:`, err);
        break;
      } finally {
        if (this.unignorePathFn) {
          const unignore = this.unignorePathFn;
          setTimeout(() => unignore(deletedPath), 500);
        }
      }

      parentPath = this.parentPath(parentPath);
    }

    return removed;
  }

  /**
   * Walk the entire vault bottom-up and delete every folder that ends up
   * empty after its descendants are processed. Returns the number of
   * folders deleted.
   *
   * Recursive so folders that become empty due to their children being
   * deleted in this same pass are also cleaned up.
   */
  async pruneAllEmptyFolders(): Promise<number> {
    return await this.pruneFolderRecursive(this.vault.getRoot());
  }

  private async pruneFolderRecursive(folder: TFolder): Promise<number> {
    let removed = 0;

    // Snapshot children up-front — we'll be deleting some of them, which
    // mutates folder.children mid-iteration if we iterate the live array.
    const childFolders: TFolder[] = folder.children.filter(
      (c): c is TFolder => c instanceof TFolder
    );
    for (const child of childFolders) {
      removed += await this.pruneFolderRecursive(child);
    }

    // Don't delete the vault root.
    if (folder.path === '' || folder.path === '/') {
      return removed;
    }

    if (folder.children.length === 0) {
      const deletedPath = folder.path;
      try {
        if (this.ignorePathFn) this.ignorePathFn(deletedPath);
        await this.vault.delete(folder);
        removed++;
      } catch (err) {
        console.warn(`[EmptyFolderService] Failed to delete empty folder ${deletedPath}:`, err);
      } finally {
        if (this.unignorePathFn) {
          const unignore = this.unignorePathFn;
          setTimeout(() => unignore(deletedPath), 500);
        }
      }
    }

    return removed;
  }

  private parentPath(path: string): string | null {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return null;
    return path.substring(0, lastSlash);
  }
}
