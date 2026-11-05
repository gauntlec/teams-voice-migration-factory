import { Module } from '@nestjs/common';
import { IncidentsModule } from '../incidents/incidents.module';
import { ProgressModule } from '../progress/progress.module';
import { ServiceRequestsModule } from '../service-requests/service-requests.module';
import { InsightsController } from './insights.controller';
import { InsightsSnapshotService } from './insights-snapshot.service';
import { InsightsReportsService } from './insights-reports.service';
import { InsightsService } from './insights.service';

/** Voxshift Insights: the shared figures, the daily snapshots and site go-live dates (docs/INSIGHTS.md). */
@Module({
  imports: [ProgressModule, IncidentsModule, ServiceRequestsModule],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsReportsService, InsightsSnapshotService],
  exports: [InsightsService, InsightsReportsService],
})
export class InsightsModule {}
