import { Inject, Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import type { FileStorageBackend } from './file-storage.interface';

/** Local-disk implementation, rooted at APP_CONFIG.FILES_DIR (see docker-compose.yml's `filesdata` volume). */
@Injectable()
export class LocalDiskStorageBackend implements FileStorageBackend {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private resolve(relativePath: string): string {
    // relativePath is always server-generated (FilesService.store), never
    // taken verbatim from a request - this is a cheap defense-in-depth check,
    // not the primary guarantee of safety.
    const normalized = normalize(relativePath);
    if (normalized.startsWith('..') || normalized.startsWith(sep)) {
      throw new Error(`Invalid storage path: ${relativePath}`);
    }
    return join(this.config.FILES_DIR, normalized);
  }

  async write(relativePath: string, data: Buffer): Promise<void> {
    const full = this.resolve(relativePath);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async read(relativePath: string): Promise<Buffer> {
    return fs.readFile(this.resolve(relativePath));
  }

  async delete(relativePath: string): Promise<void> {
    await fs.unlink(this.resolve(relativePath)).catch(() => undefined);
  }

  async deleteFolder(relativePath: string): Promise<void> {
    const full = this.resolveFolder(relativePath);
    await fs.rm(full, { recursive: true, force: true });
  }

  async folderStats(relativePath: string): Promise<{ files: number; bytes: number }> {
    const total = { files: 0, bytes: 0 };
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // not there
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          total.files += 1;
          total.bytes += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
        }
      }
    };
    await walk(this.resolveFolder(relativePath));
    return total;
  }

  /** Like resolve(), but never the storage root itself: a folder to remove must be named. */
  private resolveFolder(relativePath: string): string {
    const normalized = normalize(relativePath).replace(/[\\/]+$/, '');
    if (!normalized || normalized === '.') throw new Error('Refusing to use the storage root as a folder');
    return this.resolve(normalized);
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relativePath));
      return true;
    } catch {
      return false;
    }
  }
}
