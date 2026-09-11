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
}

export const FILE_STORAGE_BACKEND = Symbol('FILE_STORAGE_BACKEND');
