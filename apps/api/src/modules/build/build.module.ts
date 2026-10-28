import { Module } from '@nestjs/common';
import { TenantDiscoveryModule } from '../tenant-discovery/tenant-discovery.module';
import { DeploymentModule } from '../deployment/deployment.module';
import { MailModule } from '../../mail/mail.module';
import { FilesModule } from '../files/files.module';
import { BuildController } from './build.controller';
import { BuildIssuesEmailService } from './build-issues-email.service';
import { BuildService } from './build.service';
import { BuildValidationService } from './build-validation.service';

@Module({
  // TenantDiscoveryModule: the targeted live user check "Validate against
  // tenant" can trigger. DeploymentModule: DeploymentDocumentService, reused
  // for the Resource Account Request document. FilesModule: stores it.
  imports: [TenantDiscoveryModule, DeploymentModule, FilesModule, MailModule],
  controllers: [BuildController],
  providers: [BuildService, BuildValidationService, BuildIssuesEmailService],
  exports: [BuildService],
})
export class BuildModule {}
