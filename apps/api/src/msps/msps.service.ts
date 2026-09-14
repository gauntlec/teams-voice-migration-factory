import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { platformDb } from '@tvmf/db';
import type { Branding, CreateMspInput, UpdateMspBrandingInput, UpdateMspInput } from '@tvmf/shared';
import { AuditService, type AuditActor } from '../common/audit.service';
import { LOGO_CONTENT_TYPES, readImageDimensions } from '../common/logo-image.util';
import { FILE_STORAGE_BACKEND, type FileStorageBackend } from '../modules/files/file-storage.interface';
import { InjectDb, type Db } from '../db/db.module';

@Injectable()
export class MspsService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE_BACKEND) private readonly storage: FileStorageBackend,
  ) {}

  async list() {
    return platformDb(this.db)
      .selectFrom('msps')
      .select(['id', 'name', 'slug', 'domains', 'branding', 'created_at'])
      .orderBy('name')
      .execute();
  }

  async create(input: CreateMspInput, actor: AuditActor) {
    const dup = await platformDb(this.db)
      .selectFrom('msps')
      .select('id')
      .where('slug', '=', input.slug)
      .executeTakeFirst();
    if (dup) throw new BadRequestException('That slug is already taken');

    const id = randomUUID();
    const msp = await platformDb(this.db)
      .insertInto('msps')
      .values({
        id,
        name: input.name,
        slug: input.slug,
        domains: [...new Set(input.domains ?? [])],
        created_by: actor.id ?? null,
      })
      .returning(['id', 'name', 'slug', 'domains', 'branding', 'created_at'])
      .executeTakeFirstOrThrow();

    await this.audit.platform('msp.created', {
      actor,
      targetType: 'msp',
      targetId: id,
      detail: { slug: input.slug },
    });
    return msp;
  }

  async update(mspId: string, input: UpdateMspInput, actor: AuditActor) {
    await this.getMspOrThrow(mspId);
    const msp = await platformDb(this.db)
      .updateTable('msps')
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.domains !== undefined ? { domains: [...new Set(input.domains)] } : {}),
      })
      .where('id', '=', mspId)
      .returning(['id', 'name', 'slug', 'domains', 'branding', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('msp.updated', {
      actor,
      targetType: 'msp',
      targetId: mspId,
      detail: input,
    });
    return msp;
  }

  /**
   * White-label branding - logo + accent color, same shape as tenant
   * branding (packages/shared/src/index.ts's `Branding`). null anywhere
   * this is read means "use default Voxshift branding".
   */
  async updateBranding(mspId: string, input: UpdateMspBrandingInput, actor: AuditActor) {
    const m = await this.getMspOrThrow(mspId);
    const branding: Branding = { logo: m.branding?.logo ?? null, accentColor: input.accentColor };
    const msp = await platformDb(this.db)
      .updateTable('msps')
      .set({ branding })
      .where('id', '=', mspId)
      .returning(['id', 'name', 'slug', 'domains', 'branding', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('msp.branding_updated', {
      actor,
      targetType: 'msp',
      targetId: mspId,
      detail: { accentColor: input.accentColor },
    });
    return msp;
  }

  async uploadLogo(mspId: string, file: { buffer: Buffer; mimetype: string } | undefined, actor: AuditActor) {
    if (!file) throw new BadRequestException('No file uploaded');
    const ext = LOGO_CONTENT_TYPES[file.mimetype];
    if (!ext) throw new BadRequestException('Logo must be a PNG or JPEG image');
    const { width, height } = readImageDimensions(file.buffer, file.mimetype);

    const m = await this.getMspOrThrow(mspId);
    const version = (m.branding?.logo?.version ?? 0) + 1;
    const path = `branding/msps/${mspId}/logo-${version}.${ext}`;
    await this.storage.write(path, file.buffer);
    if (m.branding?.logo) await this.storage.delete(m.branding.logo.path); // old bytes now unreachable - clean up

    const branding: Branding = {
      accentColor: m.branding?.accentColor ?? '#4657D2',
      logo: { path, contentType: file.mimetype, version, width, height },
    };
    const msp = await platformDb(this.db)
      .updateTable('msps')
      .set({ branding })
      .where('id', '=', mspId)
      .returning(['id', 'name', 'slug', 'domains', 'branding', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('msp.branding_logo_uploaded', {
      actor,
      targetType: 'msp',
      targetId: mspId,
      detail: { version },
    });
    return msp;
  }

  async removeLogo(mspId: string, actor: AuditActor) {
    const m = await this.getMspOrThrow(mspId);
    if (m.branding?.logo) await this.storage.delete(m.branding.logo.path);
    const branding: Branding | null = m.branding ? { ...m.branding, logo: null } : null;
    const msp = await platformDb(this.db)
      .updateTable('msps')
      .set({ branding })
      .where('id', '=', mspId)
      .returning(['id', 'name', 'slug', 'domains', 'branding', 'created_at'])
      .executeTakeFirstOrThrow();
    await this.audit.platform('msp.branding_logo_removed', { actor, targetType: 'msp', targetId: mspId });
    return msp;
  }

  /** Backs the unauthenticated `GET /public/msps/:id/logo` route - logo bytes are not sensitive. */
  async readLogoBytes(mspId: string): Promise<{ data: Buffer; contentType: string }> {
    const m = await this.getMspOrThrow(mspId);
    if (!m.branding?.logo) throw new NotFoundException('no logo set for this MSP');
    const data = await this.storage.read(m.branding.logo.path);
    return { data, contentType: m.branding.logo.contentType };
  }

  private async getMspOrThrow(mspId: string) {
    const m = await platformDb(this.db)
      .selectFrom('msps')
      .select(['id', 'branding'])
      .where('id', '=', mspId)
      .executeTakeFirst();
    if (!m) throw new NotFoundException('MSP not found');
    return m;
  }
}
