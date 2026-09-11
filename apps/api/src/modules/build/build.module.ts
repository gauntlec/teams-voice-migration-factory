import { Module } from '@nestjs/common';
import { TenantDiscoveryModule } from '../tenant-discovery/tenant-discovery.module';
import { BuildController } from './build.controller';
import { BuildService } from './build.service';
import { BuildValidationService } from './build-validation.service';

@Module({
  // For the targeted live user check "Validate against tenant" can trigger.
  imports: [TenantDiscoveryModule],
  controllers: [BuildController],
  providers: [BuildService, BuildValidationService],
  exports: [BuildService],
})
export class BuildModule {}
