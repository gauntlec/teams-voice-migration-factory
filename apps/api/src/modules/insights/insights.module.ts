import { BrandingModule } from '../branding/branding.module';
import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { IncidentsModule } from '../incidents/incidents.module';
import { ProgressModule } from '../progress/progress.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { InsightsController } from './insights.controller';
import { InsightsPortfolioController } from './insights-portfolio.controller';
import { InsightsPortfolioService } from './insights-portfolio.service';
import { InsightsSnapshotService } from './insights-snapshot.service';
import { InsightsReportsService } from './insights-reports.service';
import { InsightsScheduleService } from './insights-schedule.service';
import { InsightsService } from './insights.service';

/** Voxshift Insights: the shared figures, the daily snapshots and site go-live dates (docs/INSIGHTS.md). */
@Module({
  imports: [BrandingModule, MailModule, ProgressModule, IncidentsModule, ServiceRequestsModule],
  controllers: [InsightsController, InsightsPortfolioController],
  providers: [InsightsService, InsightsReportsService, InsightsScheduleService, InsightsSnapshotService, InsightsPortfolioService],
  exports: [InsightsService, InsightsReportsService],
})
export class InsightsModule {}
