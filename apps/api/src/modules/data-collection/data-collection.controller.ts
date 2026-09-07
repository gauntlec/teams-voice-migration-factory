import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  can,
  discoveryFlowSchema,
  discoveryGeneralSchema,
  discoveryNetworkSchema,
  discoverySiteSchema,
  type DiscoveryFlowInput,
  type DiscoveryGeneralInput,
  type DiscoveryNetworkInput,
  type DiscoverySiteInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { DataCollectionService } from './data-collection.service';

/**
 * Data Collection view - the customer's discovery of their current voice
 * estate. Replaces the discovery workbook. See docs/DATA-MODEL.md.
 */
@Controller('t/:tenantId/discovery')
@UseGuards(TenantGuard)
export class DataCollectionController {
  constructor(private readonly svc: DataCollectionService) {}

  private review(u: AuthedUser) {
    return can(u.role, 'discovery:review');
  }

  @Get()
  @RequirePermission('discovery:read')
  get(@TenantCtx() t: TenantContext) {
    return this.svc.get(t);
  }

  @Patch('general')
  @RequirePermission('discovery:write')
  updateGeneral(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoveryGeneralSchema)) body: DiscoveryGeneralInput,
  ) {
    return this.svc.updateGeneral(t, u, body, this.review(u));
  }

  @Post('submit')
  @RequirePermission('discovery:write')
  submit(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser) {
    return this.svc.submit(t, u);
  }

  @Post('accept')
  @RequirePermission('discovery:review')
  accept(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser) {
    return this.svc.accept(t, u);
  }

  @Post('reopen')
  @RequirePermission('discovery:review')
  reopen(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser) {
    return this.svc.reopen(t, u);
  }

  /* -------------------------------- sites -------------------------------- */

  @Post('sites')
  @RequirePermission('discovery:write')
  addSite(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoverySiteSchema)) body: DiscoverySiteInput,
  ) {
    return this.svc.addSite(t, u, body, this.review(u));
  }

  @Patch('sites/:id')
  @RequirePermission('discovery:write')
  updateSite(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(discoverySiteSchema.partial())) body: Partial<DiscoverySiteInput>,
  ) {
    return this.svc.updateSite(t, u, id, body, this.review(u));
  }

  @Delete('sites/:id')
  @RequirePermission('discovery:write')
  deleteSite(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteSite(t, u, id, this.review(u));
  }

  /* number ranges + telephony -> data-collection.telephony.controller.ts */

  /* ------------------------------- network ----------------------------- */

  @Post('network')
  @RequirePermission('discovery:write')
  addNetwork(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoveryNetworkSchema)) body: DiscoveryNetworkInput,
  ) {
    return this.svc.addNetwork(t, u, body, this.review(u));
  }

  @Patch('network/:id')
  @RequirePermission('discovery:write')
  updateNetwork(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(discoveryNetworkSchema.partial())) body: Partial<DiscoveryNetworkInput>,
  ) {
    return this.svc.updateNetwork(t, u, id, body, this.review(u));
  }

  @Delete('network/:id')
  @RequirePermission('discovery:write')
  deleteNetwork(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteNetwork(t, u, id, this.review(u));
  }

  /* -------------------------------- flows ------------------------------- */

  @Post('flows')
  @RequirePermission('discovery:write')
  addFlow(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoveryFlowSchema)) body: DiscoveryFlowInput,
  ) {
    return this.svc.addFlow(t, u, body, this.review(u));
  }

  @Patch('flows/:id')
  @RequirePermission('discovery:write')
  updateFlow(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(discoveryFlowSchema.partial())) body: Partial<DiscoveryFlowInput>,
  ) {
    return this.svc.updateFlow(t, u, id, body, this.review(u));
  }

  @Delete('flows/:id')
  @RequirePermission('discovery:write')
  deleteFlow(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteFlow(t, u, id, this.review(u));
  }
}
