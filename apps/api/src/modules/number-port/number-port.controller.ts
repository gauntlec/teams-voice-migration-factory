import { Body, Controller, Get, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  numberPortItemRejectSchema,
  numberPortItemWaiveSchema,
  numberPortRequestItemsSchema,
  portDocumentTypeSchema,
  sitePortDocumentTypeSchema,
  type NumberPortItemRejectInput,
  type NumberPortItemWaiveInput,
  type NumberPortRequestItemsInput,
  type PortDocumentTypeInput,
  type SitePortDocumentTypeInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { NumberPortService } from './number-port.service';

/**
 * "LOA Data Collection and Tracking" - number-port document checklist.
 * Shares the `t/:tenantId/discovery` base with DataCollectionController /
 * TelephonyController, since this is conceptually part of Data Collection.
 */
@Controller('t/:tenantId/discovery')
@UseGuards(TenantGuard)
export class NumberPortController {
  constructor(private readonly svc: NumberPortService) {}

  /* -------------------------- global catalog -------------------------- */

  @Get('document-types')
  @RequirePermission('discovery:sites:manage')
  listDocumentTypes(@TenantCtx() t: TenantContext) {
    return this.svc.listDocumentTypes(t);
  }

  @Post('document-types')
  @RequirePermission('discovery:sites:manage')
  createDocumentType(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(portDocumentTypeSchema)) body: PortDocumentTypeInput,
  ) {
    return this.svc.createDocumentType(t, u, body);
  }

  @Patch('document-types/:id')
  @RequirePermission('discovery:sites:manage')
  updateDocumentType(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(portDocumentTypeSchema.partial())) body: Partial<PortDocumentTypeInput>,
  ) {
    return this.svc.updateDocumentType(t, u, id, body);
  }

  /* -------------------------- site enablement -------------------------- */

  @Get('sites/:siteId/document-types')
  @RequirePermission('discovery:sites:manage')
  listSiteDocumentTypes(@TenantCtx() t: TenantContext, @Param('siteId') siteId: string) {
    return this.svc.listSiteDocumentTypes(t, siteId);
  }

  @Patch('sites/:siteId/document-types')
  @RequirePermission('discovery:sites:manage')
  setSiteDocumentType(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('siteId') siteId: string,
    @Body(new ZodBody(sitePortDocumentTypeSchema)) body: SitePortDocumentTypeInput,
  ) {
    return this.svc.setSiteDocumentType(t, u, siteId, body);
  }

  /* ------------------------------ requests ------------------------------ */

  @Get('number-ranges/:rangeId/port-request')
  @RequirePermission('discovery:read')
  getOrCreateRequest(@TenantCtx() t: TenantContext, @Param('rangeId') rangeId: string) {
    return this.svc.getOrCreateRequest(t, rangeId);
  }

  @Patch('port-requests/:id/items')
  @RequirePermission('discovery:review')
  saveItems(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(numberPortRequestItemsSchema)) body: NumberPortRequestItemsInput,
  ) {
    return this.svc.saveItems(t, u, id, body);
  }

  @Post('port-requests/:id/submit')
  @RequirePermission('discovery:review')
  submitRequest(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.submitRequest(t, u, id);
  }

  @Post('port-requests/:id/items/:itemId/upload')
  @RequirePermission('discovery:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  uploadItem(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.svc.uploadItem(t, u, id, itemId, file);
  }

  @Post('port-requests/:id/items/:itemId/reject')
  @RequirePermission('discovery:review')
  rejectItem(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(new ZodBody(numberPortItemRejectSchema)) body: NumberPortItemRejectInput,
  ) {
    return this.svc.rejectItem(t, u, id, itemId, body);
  }

  @Patch('port-requests/:id/items/:itemId/waive')
  @RequirePermission('discovery:review')
  waiveItem(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body(new ZodBody(numberPortItemWaiveSchema)) body: NumberPortItemWaiveInput,
  ) {
    return this.svc.waiveItem(t, u, id, itemId, body.waived);
  }
}
