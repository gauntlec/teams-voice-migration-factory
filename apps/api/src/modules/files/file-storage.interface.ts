/**
 * Abstraction over "where file bytes actually live", separate from the
 * `files` table (the index). Local disk is the only implementation today
 * (LocalDiskStorageBackend); the interface exists so this can move to
 * object storage later without touching FilesService or its callers.
 */
export interface FileStorageBackend {
  write(relativePath: string, data: Buffer): Promise<void>;
  read(relativePath: string): Promise<Buffer>;
  delete(relativePath: string): Promise<void>;
  exists(relativePath: string): Promise<boolean>;
  /** Removes a whole folder and everything in it. Not an error when it is already gone, so a deletion can be run again. */
  deleteFolder(relativePath: string): Promise<void>;
  /** How many files a folder holds (in every sub-folder) and their total size in bytes. A folder that is not there holds none. */
  folderStats(relativePath: string): Promise<{ files: number; bytes: number }>;
}

export const FILE_STORAGE_BACKEND = Symbol('FILE_STORAGE_BACKEND');
