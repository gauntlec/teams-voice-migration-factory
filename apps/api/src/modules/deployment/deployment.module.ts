import { Module } from '@nestjs/common';
import { DeploymentController } from './deployment.controller';
import { DeploymentService } from './deployment.service';

@Module({
  controllers: [DeploymentController],
  providers: [DeploymentService],
  // Discovery reuses the same live device-code connection flow.
  exports: [DeploymentService],
})
export class DeploymentModule {}
