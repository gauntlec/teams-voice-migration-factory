import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { MspServiceRequestsController } from './msp-service-requests.controller';
import { MspServiceRequestsService } from './msp-service-requests.service';
import { ServiceRequestsController } from './service-requests.controller';
import { ServiceRequestsService } from './service-requests.service';

@Module({
  imports: [MailModule],
  controllers: [ServiceRequestsController, MspServiceRequestsController],
  providers: [ServiceRequestsService, MspServiceRequestsService],
})
export class ServiceRequestsModule {}
