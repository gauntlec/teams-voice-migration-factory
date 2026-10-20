import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../modules/files/files.module';
import { TenantDeletionService } from './tenant-deletion.service';
import { TenantLogoPublicController } from './tenant-logo-public.controller';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [FilesModule, AuthModule],
  controllers: [TenantsController, TenantLogoPublicController],
  providers: [TenantsService, TenantDeletionService],
})
export class TenantsModule {}
