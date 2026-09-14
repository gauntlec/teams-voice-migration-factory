import { Module } from '@nestjs/common';
import { BugReportsController } from './bug-reports.controller';
import { BugReportsService } from './bug-reports.service';

@Module({
  controllers: [BugReportsController],
  providers: [BugReportsService],
})
export class BugReportsModule {}
