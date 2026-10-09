import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { MspServiceRequestsController } from './msp-service-requests.controller';
import { MspServiceRequestsService } from './msp-service-requests.service';
import { BuildModule } from '../build/build.module';
import { DataCollectionModule } from '../data-collection/data-collection.module';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  // BuildModule / DataCollectionModule: "Create in Design & Build" reuses their create paths.
  imports: [MailModule, BuildModule, DataCollectionModule],
  controllers: [ServiceRequestsController, MspServiceRequestsController],
  providers: [ServiceRequestsService, MspServiceRequestsService],
})
export class ServiceRequestsModule {}
