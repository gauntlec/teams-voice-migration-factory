import { Module } from '@nestjs/common';
import { FilesModule } from '../modules/files/files.module';
import { TenantLogoPublicController } from './tenant-logo-public.controller';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [FilesModule],
  controllers: [TenantsController, TenantLogoPublicController],
  providers: [TenantsService],
})
export class TenantsModule {}
