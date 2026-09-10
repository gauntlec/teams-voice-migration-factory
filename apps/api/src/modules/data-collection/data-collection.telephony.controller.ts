import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  callingPolicySchema,
  can,
  discoveryCapSchema,
  discoveryListQuerySchema,
  discoveryNumberRangeSchema,
  discoveryResourceAccountSchema,
  discoveryUserSchema,
  numberReserveSchema,
  relinkUsersSchema,
  resourceAccountNumberSchema,
  usersImportSchema,
  type CallingPolicyInput,
  type DiscoveryCapInput,
  type DiscoveryListQuery,
  type DiscoveryNumberRangeInput,
  type DiscoveryResourceAccountInput,
  type DiscoveryUserInput,
  type RelinkUsersInput,
  type UsersImportInput,
} from '@tvmf/shared';
import { CurrentUser, TenantCtx } from '../../auth/auth.decorators';
import type { AuthedUser, TenantContext } from '../../common/request';
import { ZodBody } from '../../common/zod.pipe';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { TenantGuard } from '../../rbac/tenant.guard';
import { TelephonyService } from './data-collection.telephony.service';

@Controller('t/:tenantId/discovery')
@UseGuards(TenantGuard)
export class TelephonyController {
  constructor(private readonly svc: TelephonyService) {}

  private review(u: AuthedUser) {
    return can(u.role, 'discovery:review');
  }

  /* --------------------- paginated list reads --------------------- */

  @Get('users')
  @RequirePermission('discovery:read')
  listUsers(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(discoveryListQuerySchema)) q: DiscoveryListQuery,
  ) {
    return this.svc.listUsers(t, q);
  }

  @Get('caps')
  @RequirePermission('discovery:read')
  listCaps(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(discoveryListQuerySchema)) q: DiscoveryListQuery,
  ) {
    return this.svc.listCaps(t, q);
  }

  @Get('resource-accounts')
  @RequirePermission('discovery:read')
  listRas(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(discoveryListQuerySchema)) q: DiscoveryListQuery,
  ) {
    return this.svc.listResourceAccounts(t, q);
  }

  @Get('number-ranges')
  @RequirePermission('discovery:read')
  listRanges(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(discoveryListQuerySchema)) q: DiscoveryListQuery,
  ) {
    return this.svc.listRanges(t, q);
  }

  @Get('numbers')
  @RequirePermission('discovery:read')
  listNumbers(
    @TenantCtx() t: TenantContext,
    @Query(new ZodBody(discoveryListQuerySchema)) q: DiscoveryListQuery,
  ) {
    return this.svc.listNumbers(t, q);
  }

  /* ----------------------- calling policies ----------------------- */

  @Post('calling-policies')
  @RequirePermission('discovery:write')
  addPolicy(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(callingPolicySchema)) body: CallingPolicyInput,
  ) {
    return this.svc.addCallingPolicy(t, u, body, this.review(u));
  }

  @Patch('calling-policies/:id')
  @RequirePermission('discovery:write')
  updatePolicy(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(callingPolicySchema.partial())) body: Partial<CallingPolicyInput>,
  ) {
    return this.svc.updateCallingPolicy(t, u, id, body, this.review(u));
  }

  @Delete('calling-policies/:id')
  @RequirePermission('discovery:write')
  deletePolicy(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteCallingPolicy(t, u, id, this.review(u));
  }

  /* ------------------------- number ranges ------------------------- */

  @Post('number-ranges')
  @RequirePermission('discovery:write')
  addRange(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoveryNumberRangeSchema)) body: DiscoveryNumberRangeInput,
  ) {
    return this.svc.addRange(t, u, body, this.review(u));
  }

  @Patch('number-ranges/:id')
  @RequirePermission('discovery:write')
  updateRange(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(discoveryNumberRangeSchema.partial())) body: Partial<DiscoveryNumberRangeInput>,
  ) {
    return this.svc.updateRange(t, u, id, body, this.review(u));
  }

  @Delete('number-ranges/:id')
  @RequirePermission('discovery:write')
  deleteRange(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteRange(t, u, id, this.review(u));
  }

  @Patch('numbers/:id/reserve')
  @RequirePermission('discovery:write')
  reserveNumber(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(numberReserveSchema)) body: { reserved: boolean },
  ) {
    return this.svc.reserveNumber(t, u, id, body.reserved, this.review(u));
  }

  /* ----------------------------- users ----------------------------- */

  @Post('users')
  @RequirePermission('discovery:write')
  addUser(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoveryUserSchema)) body: DiscoveryUserInput,
  ) {
    return this.svc.addUser(t, u, body, this.review(u));
  }

  @Patch('users/:id')
  @RequirePermission('discovery:write')
  updateUser(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(discoveryUserSchema.partial())) body: Partial<DiscoveryUserInput>,
  ) {
    return this.svc.updateUser(t, u, id, body, this.review(u));
  }

  @Delete('users/:id')
  @RequirePermission('discovery:write')
  deleteUser(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteUser(t, u, id, this.review(u));
  }

  /** Link every unlinked user for a site to the tenant user with the same UPN. */
  @Post('users/relink')
  @RequirePermission('discovery:write')
  relinkUsers(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(relinkUsersSchema)) body: RelinkUsersInput,
  ) {
    return this.svc.relinkUsers(t, u, body.site_id, this.review(u));
  }

  /** Bulk-create users for a site from parsed spreadsheet rows. */
  @Post('users/import')
  @RequirePermission('discovery:write')
  importUsers(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(usersImportSchema)) body: UsersImportInput,
  ) {
    return this.svc.importUsers(t, u, body.site_id, body.rows, this.review(u));
  }

  /* ------------------------------ caps ------------------------------ */

  @Post('caps')
  @RequirePermission('discovery:write')
  addCap(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoveryCapSchema)) body: DiscoveryCapInput,
  ) {
    return this.svc.addCap(t, u, body, this.review(u));
  }

  @Patch('caps/:id')
  @RequirePermission('discovery:write')
  updateCap(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(discoveryCapSchema.partial())) body: Partial<DiscoveryCapInput>,
  ) {
    return this.svc.updateCap(t, u, id, body, this.review(u));
  }

  @Delete('caps/:id')
  @RequirePermission('discovery:write')
  deleteCap(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteCap(t, u, id, this.review(u));
  }

  /* ----------------------- resource accounts ----------------------- */

  @Post('resource-accounts')
  @RequirePermission('discovery:write')
  addRa(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Body(new ZodBody(discoveryResourceAccountSchema)) body: DiscoveryResourceAccountInput,
  ) {
    return this.svc.addResourceAccount(t, u, body, this.review(u));
  }

  @Patch('resource-accounts/:id')
  @RequirePermission('discovery:write')
  updateRa(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(discoveryResourceAccountSchema.partial())) body: Partial<DiscoveryResourceAccountInput>,
  ) {
    return this.svc.updateResourceAccount(t, u, id, body, this.review(u));
  }

  @Delete('resource-accounts/:id')
  @RequirePermission('discovery:write')
  deleteRa(@TenantCtx() t: TenantContext, @CurrentUser() u: AuthedUser, @Param('id') id: string) {
    return this.svc.deleteResourceAccount(t, u, id, this.review(u));
  }

  @Post('resource-accounts/:id/numbers')
  @RequirePermission('discovery:write')
  attachRaNumber(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(resourceAccountNumberSchema)) body: { phone_number_id: string },
  ) {
    return this.svc.attachRaNumber(t, u, id, body.phone_number_id, this.review(u));
  }

  @Delete('resource-accounts/:id/numbers/:numberId')
  @RequirePermission('discovery:write')
  detachRaNumber(
    @TenantCtx() t: TenantContext,
    @CurrentUser() u: AuthedUser,
    @Param('id') id: string,
    @Param('numberId') numberId: string,
  ) {
    return this.svc.detachRaNumber(t, u, id, numberId, this.review(u));
  }
}
