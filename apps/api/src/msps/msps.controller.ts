import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  createMspSchema,
  updateMspBrandingSchema,
  updateMspSchema,
  type CreateMspInput,
  type UpdateMspBrandingInput,
  type UpdateMspInput,
} from '@tvmf/shared';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthedUser } from '../common/request';
import { ZodBody } from '../common/zod.pipe';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { MspsService } from './msps.service';

@Controller('msps')
export class MspsController {
  constructor(private readonly msps: MspsService) {}

  private actor(u: AuthedUser) {
    return { id: u.id, email: u.email, role: u.role };
  }

  @Get()
  @RequirePermission('msp:read')
  list() {
    return this.msps.list();
  }

  @Post()
  @RequirePermission('msp:create')
  create(
    @Body(new ZodBody(createMspSchema)) body: CreateMspInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.msps.create(body, this.actor(user));
  }

  @Patch(':mspId')
  @RequirePermission('msp:update')
  update(
    @Param('mspId') mspId: string,
    @Body(new ZodBody(updateMspSchema)) body: UpdateMspInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.msps.update(mspId, body, this.actor(user));
  }

  @Patch(':mspId/branding')
  @RequirePermission('msp:update')
  updateBranding(
    @Param('mspId') mspId: string,
    @Body(new ZodBody(updateMspBrandingSchema)) body: UpdateMspBrandingInput,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.msps.updateBranding(mspId, body, this.actor(user));
  }

  @Post(':mspId/branding/logo')
  @RequirePermission('msp:update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadLogo(
    @Param('mspId') mspId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthedUser,
  ) {
    return this.msps.uploadLogo(mspId, file, this.actor(user));
  }

  @Delete(':mspId/branding/logo')
  @RequirePermission('msp:update')
  removeLogo(@Param('mspId') mspId: string, @CurrentUser() user: AuthedUser) {
    return this.msps.removeLogo(mspId, this.actor(user));
  }
}
