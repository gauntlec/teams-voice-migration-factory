import { Module } from '@nestjs/common';
import { TenantDiscoveryModule } from '../tenant-discovery/tenant-discovery.module';
import { DeploymentModule } from '../deployment/deployment.module';
import { FilesModule } from '../files/files.module';
import { BuildController } from './build.controller';
import { BuildService } from './build.service';
import { BuildValidationService } from './build-validation.service';

@Module({
  // TenantDiscoveryModule: the targeted live user check "Validate against
  // tenant" can trigger. DeploymentModule: DeploymentDocumentService, reused
  // for the Resource Account Request document. FilesModule: stores it.
  imports: [TenantDiscoveryModule, DeploymentModule, FilesModule],
  controllers: [BuildController],
  providers: [BuildService, BuildValidationService],
  exports: [BuildService],
})
export class BuildModule {}
