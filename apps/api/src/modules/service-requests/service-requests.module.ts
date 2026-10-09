import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { BuildModule } from '../build/build.module';
import { DataCollectionModule } from '../data-collection/data-collection.module';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  // BuildModule / DataCollectionModule: "Create in Design & Build" reuses their create paths.
  imports: [MailModule, BuildModule, DataCollectionModule],
  controllers: [ServiceRequestsController],
  providers: [ServiceRequestsService],
})
export class ServiceRequestsModule {}
