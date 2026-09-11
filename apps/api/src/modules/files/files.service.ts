import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { tenantDb } from '@tvmf/db';
import type { FileRow, FilesQuery } from '@tvmf/shared';
import { assertSiteInScope, isSiteScoped } from '../data-collection/site-scope';
import type { TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { FILE_STORAGE_BACKEND, type FileStorageBackend } from './file-storage.interface';

export interface StoreFileInput {
  category: 'deployment_change_document';
  sourceType: string;
  sourceId: string;
  siteId: string | null;
  filename: string;
  contentType: string;
  data: Buffer;
  uploadedBy: string | null;
  metadata?: Record<string, unknown>;
}

/** Strip path separators and other characters that don't belong in a stored filename. */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, '_').trim() || 'file';
}

function toRow(r: {
  id: string;
  category: string;
  source_type: string;
  source_id: string;
  site_id: string | null;
  filename: string;
  content_type: string;
  byte_size: number | string;
  uploaded_by: string | null;
  metadata: unknown;
  created_at: unknown;
}): FileRow {
  return {
    id: r.id,
    category: r.category as FileRow['category'],
    sourceType: r.source_type,
    sourceId: r.source_id,
    siteId: r.site_id,
    filename: r.filename,
    contentType: r.content_type,
    byteSize: Number(r.byte_size),
    uploadedBy: r.uploaded_by,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: String(r.created_at),
  };
}

/**
 * General-purpose per-tenant file store: local-disk bytes (via
 * FileStorageBackend), indexed in the tenant's `files` table. First consumer
 * is Deployment's change-recording documents; designed for Data Collection,
 * Discovery, Design & Build and Service Handover to register files here too.
 * No upload/write HTTP route exists yet - the only writer today is
 * DeploymentService.generateChangeDocument calling store() in-process.
 */
@Injectable()
export class FilesService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(FILE_STORAGE_BACKEND) private readonly storage: FileStorageBackend,
  ) {}

  async store(t: TenantContext, input: StoreFileInput): Promise<FileRow> {
    const id = randomUUID();
    const filename = sanitizeFilename(input.filename);
    const storagePath = `${t.schema}/${input.category}/${id}-${filename}`;
    await this.storage.write(storagePath, input.data);

    const row = await tenantDb(this.db, t.schema)
      .insertInto('files')
      .values({
        id,
        category: input.category,
        source_type: input.sourceType,
        source_id: input.sourceId,
        site_id: input.siteId,
        filename,
        content_type: input.contentType,
        byte_size: input.data.byteLength,
        storage_path: storagePath,
        uploaded_by: input.uploadedBy,
        metadata: input.metadata ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toRow(row);
  }

  async list(t: TenantContext, filter: FilesQuery): Promise<FileRow[]> {
    let q = tenantDb(this.db, t.schema).selectFrom('files').selectAll().orderBy('created_at', 'desc');
    if (filter.siteId) q = q.where('site_id', '=', filter.siteId);
    if (filter.category) q = q.where('category', '=', filter.category);
    if (filter.sourceType) q = q.where('source_type', '=', filter.sourceType);
    if (filter.sourceId) q = q.where('source_id', '=', filter.sourceId);
    if (isSiteScoped(t)) q = q.where('site_id', 'in', t.siteScope);
    const rows = await q.execute();
    return rows.map(toRow);
  }

  private async loadRow(t: TenantContext, id: string) {
    const row = await tenantDb(this.db, t.schema).selectFrom('files').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new NotFoundException('file not found');
    assertSiteInScope(t, row.site_id);
    return row;
  }

  async get(t: TenantContext, id: string): Promise<FileRow> {
    return toRow(await this.loadRow(t, id));
  }

  async readBytes(t: TenantContext, id: string): Promise<{ row: FileRow; data: Buffer }> {
    const raw = await this.loadRow(t, id);
    const data = await this.storage.read(raw.storage_path);
    return { row: toRow(raw), data };
  }
}
