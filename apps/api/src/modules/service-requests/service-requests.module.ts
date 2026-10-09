import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { MspServiceRequestsController } from './msp-service-requests.controller';
import { MspServiceRequestsService } from './msp-service-requests.service';
import { BuildModule } from '../build/build.module';
import { DataCollectionModule } from '../data-collection/data-collection.module';
import { DeploymentModule } from '../deployment/deployment.module';
import { FilesModule } from '../files/files.module';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  // BuildModule / DataCollectionModule: "Create in Design & Build" reuses their create paths.
  // DeploymentModule: the request's Deploy tab runs the normal deployment path.
  // FilesModule: request attachments.
  imports: [MailModule, BuildModule, DataCollectionModule, DeploymentModule, FilesModule],
  controllers: [ServiceRequestsController, MspServiceRequestsController],
  providers: [ServiceRequestsService, MspServiceRequestsService],
})
export class ServiceRequestsModule {}
