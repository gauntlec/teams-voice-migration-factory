import { Controller, Get, Param, ParseUUIDPipe, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { can, filesQuerySchema, type FilesQuery } from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { FilesService } from './files.service';

/**
 * File browser - lists and downloads files generated/stored by other modules
 * (Deployment's change-recording documents today). Visible to all 4 roles
 * (files:read); there is no upload route here - writers call
 * FilesService.store() in-process from their own module.
 */
@Controller('t/:tenantId/files')
@UseGuards(TenantGuard)
export class FilesController {
  constructor(private readonly svc: FilesService) {}

  /** Customers only see a handover pack's document once it's issued. */
  private access(u: AuthedUser) {
    return { hideDraftHandover: !can(u.role, 'handover:generate') };
  }

  @Get()
  @RequirePermission('files:read')
  list(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Query(new ZodBody(filesQuerySchema)) query: FilesQuery) {
    return this.svc.list(t, query, this.access(u));
  }

  @Get(':id')
  @RequirePermission('files:read')
  get(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(t, id, this.access(u));
  }

  @Get(':id/download')
  @RequirePermission('files:read')
  async download(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const { row, data } = await this.svc.readBytes(t, id, this.access(u));
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(row.byteSize));
    res.send(data);
  }
}
