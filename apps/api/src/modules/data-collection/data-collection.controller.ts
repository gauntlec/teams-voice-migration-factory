import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  can,
  discoveryFlowSchema,
  discoveryListQuerySchema,
  discoveryNetworkSchema,
  discoverySiteOverviewSchema,
  discoverySiteSchema,
  siteHandsetStatusSchema,
  type DiscoveryFlowInput,
  type DiscoveryListQuery,
  type DiscoveryNetworkInput,
  type DiscoverySiteInput,
  type DiscoverySiteOverviewInput,
  type SiteHandsetStatusInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { DataCollectionService } from './data-collection.service';
import { GeocodeService } from './geocode.service';

/**
 * Data Collection view - the customer's discovery of their current voice
 * estate. Replaces the discovery workbook. See docs/DATA-MODEL.md.
 */
@Controller('t/:tenantId/discovery')
@UseGuards(TenantGuard)
export class DataCollectionController {
  constructor(
    private readonly svc: DataCollectionService,
    private readonly geo: GeocodeService,
  ) {}

  private review(u: AuthedUser) {
    return can(u.role, 'discovery:review');
  }

  @Get()
  @RequirePermission('discovery:read')
  get(@TenantCtx() t: TenantContext) {
    return this.svc.get(t);
  }

  /** Street address -> { latitude, longitude, label } | null. Admin/engineer only. */
  @Get('geocode')
  @RequirePermission('discovery:sites:manage')
  geocode(@Query('q') q?: string) {
    return this.geo.lookup(q ?? '');
  }

  @Get('sites/:siteId')
  @RequirePermission('discovery:read')
  siteSummary(@TenantCtx() t: TenantContext, @Param('siteId') siteId: string) {
    return this.svc.siteSummary(t, siteId);
  }

  /** The handset models the site's users and common area phones need, with the project manager's stage for each. */
  @Get('sites/:siteId/handsets')
  @RequirePermission('discovery:read')
  siteHandsets(@TenantCtx() t: TenantContext, @Param('siteId') siteId: string) {
    return this.svc.siteHandsets(t, siteId);
  }

  /** Records how far one handset model has got (ordered, added to tooling & updated, installed & working). Admin / PM / engineer only. */
  @Put('sites/:siteId/handsets')
  @RequirePermission('discovery:sites:manage')
  setSiteHandsetStatus(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('siteId') siteId: string,
    @Body(new ZodBody(siteHandsetStatusSchema)) body: SiteHandsetStatusInput,
  ) {
    return this.svc.setSiteHandsetStatus(t, u, siteId, body);
  }

  /** Active users that can be picked for a site's roles (Site contact(s), Provider PM, ...). */
  @Get('contact-candidates')
  @RequirePermission('discovery:sites:manage')
  listContactCandidates(@TenantCtx() t: TenantContext) {
    return this.svc.listContactCandidates(t);
  }

  /** Write a site's overview, including the people on it. Admin / PM / engineer only. */
  @Patch('sites/:siteId/overview')
  @RequirePermission('discovery:sites:manage')
  updateSiteOverview(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('siteId') siteId: string,
    @Body(new ZodBody(discoverySiteOverviewSchema)) body: DiscoverySiteOverviewInput,
  ) {
    return this.svc.updateSiteOverview(t, u, siteId, body, this.review(u));
  }

  /* ----------------------------- site review ----------------------------- */

  /** Submit one site for review. Anyone who can write it, including a site contact limited to that site. */
  @Post('sites/:siteId/submit')
  @RequirePermission('discovery:write')
  submitSite(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('siteId') siteId: string) {
    return this.svc.submitSite(t, u, siteId);
  }

  @Post('sites/:siteId/accept')
  @RequirePermission('discovery:review')
  acceptSite(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('siteId') siteId: string) {
    return this.svc.acceptSite(t, u, siteId);
  }

  @Post('sites/:siteId/reopen')
  @RequirePermission('discovery:review')
  reopenSite(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('siteId') siteId: string) {
    return this.svc.reopenSite(t, u, siteId);
  }

  /** Changes made to the site since it was submitted that nobody has acknowledged yet. */
  @Get('sites/:siteId/changes')
  @RequirePermission('discovery:review')
  listSiteChanges(@TenantCtx() t: TenantContext, @Param('siteId') siteId: string) {
    return this.svc.listSiteChanges(t, siteId);
  }

  @Post('sites/:siteId/changes/acknowledge')
  @RequirePermission('discovery:review')
  acknowledgeSiteChanges(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('siteId') siteId: string) {
    return this.svc.acknowledgeSiteChanges(t, u, siteId);
  }

  /* -------------------------------- sites -------------------------------- */

  @Post('sites')
  @RequirePermission('discovery:sites:manage')
  addSite(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoverySiteSchema)) body: DiscoverySiteInput,
  ) {
    return this.svc.addSite(t, u, body, this.review(u));
  }

  @Patch('sites/:id')
  @RequirePermission('discovery:sites:manage')
  updateSite(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(discoverySiteSchema.partial())) body: Partial<DiscoverySiteInput>,
  ) {
    return this.svc.updateSite(t, u, id, body, this.review(u));
  }

  @Delete('sites/:id')
  @RequirePermission('discovery:sites:manage')
  deleteSite(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteSite(t, u, id, this.review(u));
  }

  /* number ranges + telephony -> data-collection.telephony.controller.ts */

  /* ------------------------------- network ----------------------------- */

  @Get('network')
  @RequirePermission('discovery:read')
  listNetwork(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(discoveryListQuerySchema)) q: DiscoveryListQuery,
  ) {
    return this.svc.listNetwork(t, q);
  }

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

  @Get('flows')
  @RequirePermission('discovery:read')
  listFlows(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(discoveryListQuerySchema)) q: DiscoveryListQuery,
  ) {
    return this.svc.listFlows(t, q);
  }

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
