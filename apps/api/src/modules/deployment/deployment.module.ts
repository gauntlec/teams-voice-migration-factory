import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { DeploymentController } from './deployment.controller';
import { DeploymentDocumentService } from './deployment-document.service';
import { DeploymentService } from './deployment.service';

@Module({
  imports: [FilesModule],
  controllers: [DeploymentController],
  providers: [DeploymentService, DeploymentDocumentService],
  // Discovery reuses the same live device-code connection flow.
  exports: [DeploymentService],
})
export class DeploymentModule {}
