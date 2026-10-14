import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { FilesModule } from '../files/files.module';
import { IncidentMajorController } from './incident-major.controller';
import { IncidentMajorService } from './incident-major.service';
import { IncidentNotifier } from './incident-notifier';
import { IncidentReportService } from './incident-report.service';
import { IncidentReviewService } from './incident-review.service';
import { MspIncidentsController } from './msp-incidents.controller';
import { MspIncidentsService } from './msp-incidents.service';
import { ProblemsService } from './problems.service';
import { IncidentResponseController } from './incident-response.controller';
import { IncidentResponseService } from './incident-response.service';
import { IncidentsController } from './incidents.controller';
import { IncidentsService } from './incidents.service';

@Module({
  // FilesModule: incident attachments. MailModule: incident emails.
  imports: [FilesModule, MailModule],
  // IncidentMajorController first: its fixed paths (problems, report, notices ...) must win over IncidentsController's :id.
  controllers: [IncidentMajorController, IncidentsController, IncidentResponseController, MspIncidentsController],
  providers: [IncidentsService, IncidentNotifier, IncidentResponseService, IncidentMajorService, ProblemsService, IncidentReviewService, IncidentReportService, MspIncidentsService],
  exports: [IncidentsService, IncidentNotifier],
})
export class IncidentsModule {}
