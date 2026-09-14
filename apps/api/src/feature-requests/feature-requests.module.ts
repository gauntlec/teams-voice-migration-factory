import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { FeatureRequestsController } from './feature-requests.controller';
import { FeatureRequestsService } from './feature-requests.service';

@Module({
  imports: [MailModule],
  controllers: [FeatureRequestsController],
  providers: [FeatureRequestsService],
})
export class FeatureRequestsModule {}
