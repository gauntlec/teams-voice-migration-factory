import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { BugReportsController } from './bug-reports.controller';
import { BugReportsService } from './bug-reports.service';

@Module({
  imports: [MailModule],
  controllers: [BugReportsController],
  providers: [BugReportsService],
})
export class BugReportsModule {}
