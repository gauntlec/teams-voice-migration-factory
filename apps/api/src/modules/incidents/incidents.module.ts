import { Module } from '@nestjs/common';
import { MailModule } from '../../mail/mail.module';
import { FilesModule } from '../files/files.module';
import { AgentAdminController } from './agent-admin.controller';
import { AgentAdminService } from './agent-admin.service';
import { AgentApiController } from './agent-api.controller';
import { AgentApiService } from './agent-api.service';
import { AgentAuthGuard } from './agent-auth.guard';
import { AgentEventsService } from './agent-events.service';
import { IncidentProposalsService } from './agent-proposals.service';
import { BuiltinAgentsService } from './builtin-agents.service';
import { InboundEmailController } from './inbound-email.controller';
import { InboundEmailService } from './inbound-email.service';
import { InboundReplyService } from './inbound-reply.service';
import { IncidentIntakeService } from './incident-intake.service';
import { IntakeController, IntakeAdminController } from './intake.controller';
import { IntakeAdminService } from './intake-admin.service';
import { IntakeAuthGuard } from './intake-auth.guard';
import { IncidentAgentView } from './incident-agent-view.service';
import { IncidentAgentsController } from './incident-agents.controller';
import { IncidentAgentsService } from './incident-agents.service';
import { IncidentClaimsService } from './incident-claims.service';
import { IncidentDiagnosticsController } from './incident-diagnostics.controller';
import { IncidentDiagnosticsService } from './incident-diagnostics.service';
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
  // IncidentAgentsController and IncidentMajorController first: their fixed paths (problems, report, notices ...) must win over IncidentsController's :id.
  controllers: [IncidentAgentsController, IncidentDiagnosticsController, IntakeAdminController, IntakeController, InboundEmailController, IncidentMajorController, IncidentsController, IncidentResponseController, MspIncidentsController, AgentApiController, AgentAdminController],
  providers: [IncidentsService, IncidentNotifier, IncidentResponseService, IncidentMajorService, ProblemsService, IncidentReviewService, IncidentReportService, MspIncidentsService, AgentEventsService, IncidentClaimsService, IncidentAgentView, IncidentProposalsService, IncidentAgentsService, IncidentDiagnosticsService, AgentApiService, BuiltinAgentsService, IncidentIntakeService, IntakeAdminService, IntakeAuthGuard, InboundEmailService, InboundReplyService, AgentAdminService, AgentAuthGuard],
  exports: [IncidentsService, IncidentNotifier, AgentEventsService, AgentAuthGuard, BuiltinAgentsService],
})
export class IncidentsModule {}
