import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  can,
  buildAutoAttendantCreateSchema,
  buildAutoAttendantPatchSchema,
  buildBulkPatchSchema,
  buildCallQueueCreateSchema,
  buildCallQueuePatchSchema,
  buildCapCreateSchema,
  buildCapPatchSchema,
  buildIdentityCreateSchema,
  buildIdentityPatchSchema,
  buildImportAndLinkResourceAccountSchema,
  buildListQuerySchema,
  buildPopulateSchema,
  buildResourceAccountCreateSchema,
  buildResourceAccountPatchSchema,
  buildResourceAccountRequestSchema,
  buildTemplateApplySchema,
  buildTemplateCreateSchema,
  buildTemplateListQuerySchema,
  buildTemplatePatchSchema,
  buildValidateSchema,
  callingPolicyMapListQuerySchema,
  callingPolicySiteMapSetSchema,
  type BuildAutoAttendantCreateInput,
  type BuildAutoAttendantPatchInput,
  type BuildBulkPatchInput,
  type BuildCallQueueCreateInput,
  type BuildCallQueuePatchInput,
  type BuildCapCreateInput,
  type BuildCapPatchInput,
  type BuildIdentityCreateInput,
  type BuildIdentityPatchInput,
  type BuildImportAndLinkResourceAccountInput,
  type BuildListQuery,
  type BuildPopulateInput,
  type BuildResourceAccountCreateInput,
  type BuildResourceAccountPatchInput,
  type BuildResourceAccountRequestInput,
  type BuildTemplateApplyInput,
  type BuildTemplateCreateInput,
  type BuildTemplateListQuery,
  type BuildTemplatePatchInput,
  type BuildValidateInput,
  type CallingPolicyMapListQuery,
  type CallingPolicySiteMapSetInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { BuildService } from './build.service';

/**
 * Design & Build - target configuration for Users, Common Area Phones and
 * Resource Accounts, organised per site (same shape as Data Collection).
 * Replaces the ATTC build workbook: [VRP]/[DOP]/... target columns are the
 * write side here, `G-*` live-comparison columns are the computed
 * `validation` field (see BuildValidationService), `S-*` status columns are
 * `status`/`errors` + the deployment_changes audit trail.
 */
@Controller('t/:tenantId/build')
@UseGuards(TenantGuard)
export class BuildController {
  constructor(private readonly svc: BuildService) {}

  @Get('summary')
  @RequirePermission('build:read')
  siteRollup(@TenantCtx() t: TenantContext) {
    return this.svc.siteRollup(t);
  }

  /* users */

  @Get('users')
  @RequirePermission('build:read')
  listUsers(@TenantCtx() t: TenantContext, @Query(new ZodBody(buildListQuerySchema)) q: BuildListQuery) {
    return this.svc.listUsers(t, q);
  }
  @Get('users/:id')
  @RequirePermission('build:read')
  getUser(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getUser(t, id);
  }
  @Post('users')
  @RequirePermission('build:write')
  createUser(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildIdentityCreateSchema)) body: BuildIdentityCreateInput,
  ) {
    return this.svc.createUser(t, user, body);
  }
  @Patch('users/bulk')
  @RequirePermission('build:write')
  bulkUpdateUsers(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildBulkPatchSchema)) body: BuildBulkPatchInput,
  ) {
    return this.svc.bulkUpdateUsers(t, user, body);
  }
  @Patch('users/:id')
  @RequirePermission('build:write')
  updateUser(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(buildIdentityPatchSchema)) body: BuildIdentityPatchInput,
  ) {
    return this.svc.updateUser(t, user, id, body);
  }
  @Delete('users/:id')
  @RequirePermission('build:write')
  deleteUser(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteUser(t, user, id);
  }
  @Post('users/populate')
  @RequirePermission('build:write')
  populateUsers(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildPopulateSchema)) body: BuildPopulateInput,
  ) {
    return this.svc.populateUsers(t, user, body.site_id);
  }

  /* common area phones */

  @Get('caps')
  @RequirePermission('build:read')
  listCaps(@TenantCtx() t: TenantContext, @Query(new ZodBody(buildListQuerySchema)) q: BuildListQuery) {
    return this.svc.listCaps(t, q);
  }
  @Get('caps/:id')
  @RequirePermission('build:read')
  getCap(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getCap(t, id);
  }
  @Post('caps')
  @RequirePermission('build:write')
  createCap(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildCapCreateSchema)) body: BuildCapCreateInput,
  ) {
    return this.svc.createCap(t, user, body);
  }
  @Patch('caps/bulk')
  @RequirePermission('build:write')
  bulkUpdateCaps(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildBulkPatchSchema)) body: BuildBulkPatchInput,
  ) {
    return this.svc.bulkUpdateCaps(t, user, body);
  }
  @Patch('caps/:id')
  @RequirePermission('build:write')
  updateCap(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(buildCapPatchSchema)) body: BuildCapPatchInput,
  ) {
    return this.svc.updateCap(t, user, id, body);
  }
  @Delete('caps/:id')
  @RequirePermission('build:write')
  deleteCap(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteCap(t, user, id);
  }
  @Post('caps/populate')
  @RequirePermission('build:write')
  populateCaps(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildPopulateSchema)) body: BuildPopulateInput,
  ) {
    return this.svc.populateCaps(t, user, body.site_id);
  }

  /* resource accounts */

  @Get('resource-accounts')
  @RequirePermission('build:read')
  listResourceAccounts(@TenantCtx() t: TenantContext, @Query(new ZodBody(buildListQuerySchema)) q: BuildListQuery) {
    return this.svc.listResourceAccounts(t, q);
  }
  @Get('resource-accounts/:id')
  @RequirePermission('build:read')
  getResourceAccount(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getResourceAccount(t, id);
  }
  @Post('resource-accounts')
  @RequirePermission('build:write')
  createResourceAccount(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildResourceAccountCreateSchema)) body: BuildResourceAccountCreateInput,
  ) {
    return this.svc.createResourceAccount(t, user, body);
  }
  @Patch('resource-accounts/:id')
  @RequirePermission('build:write')
  updateResourceAccount(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(buildResourceAccountPatchSchema)) body: BuildResourceAccountPatchInput,
  ) {
    return this.svc.updateResourceAccount(t, user, id, body);
  }
  @Delete('resource-accounts/:id')
  @RequirePermission('build:write')
  deleteResourceAccount(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteResourceAccount(t, user, id);
  }
  @Post('resource-accounts/populate')
  @RequirePermission('build:write')
  populateResourceAccounts(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildPopulateSchema)) body: BuildPopulateInput,
  ) {
    return this.svc.populateResourceAccounts(t, user, body.site_id);
  }
  @Post('resource-accounts/import-and-link')
  @RequirePermission('build:write')
  importAndLinkResourceAccount(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildImportAndLinkResourceAccountSchema)) body: BuildImportAndLinkResourceAccountInput,
  ) {
    return this.svc.importAndLinkResourceAccount(t, user, body.object_id, body.site_id, can(user.role, 'discovery:review'));
  }
  @Post('resource-accounts/request-document')
  @RequirePermission('build:write')
  generateResourceAccountRequestDocument(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildResourceAccountRequestSchema)) body: BuildResourceAccountRequestInput,
  ) {
    return this.svc.generateResourceAccountRequestDocument(t, user, body.site_id, body.rowIds);
  }

  /* call queues */

  @Get('call-queues')
  @RequirePermission('build:read')
  listCallQueues(@TenantCtx() t: TenantContext, @Query(new ZodBody(buildListQuerySchema)) q: BuildListQuery) {
    return this.svc.listCallQueues(t, q);
  }
  @Get('call-queues/:id')
  @RequirePermission('build:read')
  getCallQueue(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getCallQueue(t, id);
  }
  @Post('call-queues')
  @RequirePermission('build:write')
  createCallQueue(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildCallQueueCreateSchema)) body: BuildCallQueueCreateInput,
  ) {
    return this.svc.createCallQueue(t, user, body);
  }
  @Patch('call-queues/:id')
  @RequirePermission('build:write')
  updateCallQueue(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(buildCallQueuePatchSchema)) body: BuildCallQueuePatchInput,
  ) {
    return this.svc.updateCallQueue(t, user, id, body);
  }
  @Delete('call-queues/:id')
  @RequirePermission('build:write')
  deleteCallQueue(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteCallQueue(t, user, id);
  }

  /* auto attendants */

  @Get('auto-attendants')
  @RequirePermission('build:read')
  listAutoAttendants(@TenantCtx() t: TenantContext, @Query(new ZodBody(buildListQuerySchema)) q: BuildListQuery) {
    return this.svc.listAutoAttendants(t, q);
  }
  @Get('auto-attendants/:id')
  @RequirePermission('build:read')
  getAutoAttendant(@TenantCtx() t: TenantContext, @Param('id') id: string) {
    return this.svc.getAutoAttendant(t, id);
  }
  @Post('auto-attendants')
  @RequirePermission('build:write')
  createAutoAttendant(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildAutoAttendantCreateSchema)) body: BuildAutoAttendantCreateInput,
  ) {
    return this.svc.createAutoAttendant(t, user, body);
  }
  @Patch('auto-attendants/:id')
  @RequirePermission('build:write')
  updateAutoAttendant(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(buildAutoAttendantPatchSchema)) body: BuildAutoAttendantPatchInput,
  ) {
    return this.svc.updateAutoAttendant(t, user, id, body);
  }
  @Delete('auto-attendants/:id')
  @RequirePermission('build:write')
  deleteAutoAttendant(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteAutoAttendant(t, user, id);
  }

  /* validate */

  @Post('validate')
  @RequirePermission('build:write')
  validateSite(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildValidateSchema)) body: BuildValidateInput,
  ) {
    return this.svc.validateSite(t, user, body.site_id, body.live ?? true);
  }

  /**
   * Wipe every Users/CAPs/Resource accounts row for a site so it can be
   * Populated from Discovery again from scratch. Doesn't touch Data
   * Collection or the customer tenant - only this site's build_* rows.
   */
  @Post('reset')
  @RequirePermission('build:write')
  resetSite(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildPopulateSchema)) body: BuildPopulateInput,
  ) {
    return this.svc.resetSite(t, user, body.site_id);
  }

  /* calling-policy site map */

  @Get('calling-policy-map')
  @RequirePermission('build:write')
  listCallingPolicyMap(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(callingPolicyMapListQuerySchema)) q: CallingPolicyMapListQuery,
  ) {
    return this.svc.listCallingPolicyMap(t, q.siteId);
  }
  @Post('calling-policy-map')
  @RequirePermission('build:write')
  setCallingPolicyMap(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(callingPolicySiteMapSetSchema)) body: CallingPolicySiteMapSetInput,
  ) {
    return this.svc.setCallingPolicyMap(t, user, body);
  }
  @Delete('calling-policy-map/:id')
  @RequirePermission('build:write')
  deleteCallingPolicyMap(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteCallingPolicyMap(t, user, id);
  }

  /* templates */

  @Get('templates')
  @RequirePermission('build:write')
  listTemplates(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(buildTemplateListQuerySchema)) q: BuildTemplateListQuery,
  ) {
    return this.svc.listTemplates(t, q.siteId, q.kind);
  }
  @Post('templates')
  @RequirePermission('build:write')
  createTemplate(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(buildTemplateCreateSchema)) body: BuildTemplateCreateInput,
  ) {
    return this.svc.createTemplate(t, user, body);
  }
  @Patch('templates/:id')
  @RequirePermission('build:write')
  updateTemplate(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(buildTemplatePatchSchema)) body: BuildTemplatePatchInput,
  ) {
    return this.svc.updateTemplate(t, user, id, body);
  }
  @Delete('templates/:id')
  @RequirePermission('build:write')
  deleteTemplate(@TenantCtx() t: TenantContext, @CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteTemplate(t, user, id);
  }
  @Post('templates/:id/apply')
  @RequirePermission('build:write')
  applyTemplate(
    @TenantCtx() t: TenantContext,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(buildTemplateApplySchema)) body: BuildTemplateApplyInput,
  ) {
    return this.svc.applyTemplate(t, user, id, body.ids);
  }
}
