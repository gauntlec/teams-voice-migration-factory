import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { filesQuerySchema, type FilesQuery } from '@tvmf/shared';
import { TenantCtx } from '../../auth/auth.decorators';
import type { TenantContext } from '../../common/request';
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

  @Get()
  @RequirePermission('files:read')
  list(@TenantCtx() t: TenantContext, @Query(new ZodBody(filesQuerySchema)) query: FilesQuery) {
    return this.svc.list(t, query);
  }

  @Get(':id')
  @RequirePermission('files:read')
  get(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.get(t, id);
  }

  @Get(':id/download')
  @RequirePermission('files:read')
  async download(@TenantCtx() t: TenantContext, @Param('id') id: string, @Res() res: Response) {
    const { row, data } = await this.svc.readBytes(t, id);
    res.setHeader('Content-Type', row.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(row.byteSize));
    res.send(data);
  }
}
