import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { FilesModule } from '../files/files.module';
import { IncidentNotifier } from './incident-notifier';
import { IncidentResponseController } from './incident-response.controller';
import { IncidentResponseService } from './incident-response.service';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';

@Module({
  // FilesModule: incident attachments. MailModule: incident emails.
  imports: [FilesModule, MailModule],
  controllers: [IncidentsController, IncidentResponseController],
  providers: [IncidentsService, IncidentNotifier, IncidentResponseService],
  exports: [IncidentsService],
})
export class IncidentsModule {}
