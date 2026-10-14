import type { DbHandle } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import type { MailService } from '../../../../apps/api/src/mail/mail.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { AgentAdminService } from '../../../../apps/api/src/modules/incidents/agent-admin.service';
import { AgentApiService } from '../../../../apps/api/src/modules/incidents/agent-api.service';
import { AgentAuthGuard } from '../../../../apps/api/src/modules/incidents/agent-auth.guard';
import { AgentEventsService } from '../../../../apps/api/src/modules/incidents/agent-events.service';
import { IncidentProposalsService } from '../../../../apps/api/src/modules/incidents/agent-proposals.service';
import { BuiltinAgentsService } from '../../../../apps/api/src/modules/incidents/builtin-agents.service';
import { IncidentAgentView } from '../../../../apps/api/src/modules/incidents/incident-agent-view.service';
import { IncidentAgentsService } from '../../../../apps/api/src/modules/incidents/incident-agents.service';
import { IncidentClaimsService } from '../../../../apps/api/src/modules/incidents/incident-claims.service';
import { IncidentDiagnosticsService } from '../../../../apps/api/src/modules/incidents/incident-diagnostics.service';
import { InboundEmailService } from '../../../../apps/api/src/modules/incidents/inbound-email.service';
import { InboundReplyService } from '../../../../apps/api/src/modules/incidents/inbound-reply.service';
import { IncidentIntakeService } from '../../../../apps/api/src/modules/incidents/incident-intake.service';
import { IntakeAdminService } from '../../../../apps/api/src/modules/incidents/intake-admin.service';
import { IntakeAuthGuard } from '../../../../apps/api/src/modules/incidents/intake-auth.guard';
import { IncidentKnowledgeService } from '../../../../apps/api/src/modules/incidents/incident-knowledge.service';
import { MspNotifier } from '../../../../apps/api/src/modules/incidents/msp-notifier';
import { IncidentMajorService } from '../../../../apps/api/src/modules/incidents/incident-major.service';
import { IncidentNotifier } from '../../../../apps/api/src/modules/incidents/incident-notifier';
import { IncidentReportService } from '../../../../apps/api/src/modules/incidents/incident-report.service';
import { IncidentResponseService } from '../../../../apps/api/src/modules/incidents/incident-response.service';
import { IncidentReviewService } from '../../../../apps/api/src/modules/incidents/incident-review.service';
import { IncidentsService } from '../../../../apps/api/src/modules/incidents/incidents.service';
import { MspIncidentsService } from '../../../../apps/api/src/modules/incidents/msp-incidents.service';
import { ProblemsService } from '../../../../apps/api/src/modules/incidents/problems.service';

export const TEST_SECRET = 'incident-secret-for-tests-0123456789';

/**
 * The incident services wired the way the API wires them, with the mail queue swapped
 * for whatever `mail` is (a recorder, or a no-op) and file storage held in memory.
 */
export function incidentServices(handle: DbHandle, mail: Pick<MailService, 'enqueue'> = { enqueue: async () => ({ id: 'm' }) }, opts: { inbound?: boolean } = {}) {
  const cfg = { WEB_ORIGIN: 'https://app.test/', JWT_REFRESH_SECRET: TEST_SECRET, INBOUND_EMAIL_ADDRESS: opts.inbound === false ? '' : 'incidents@mail.test', INBOUND_EMAIL_SECRET: opts.inbound === false ? '' : 'inbound-secret-for-tests' } as AppConfig;
  const audit = new AuditService(handle.db);
  const replies = new InboundReplyService(handle.db, cfg);
  const notifier = new IncidentNotifier(handle.db, mail as MailService, cfg, replies, new MspNotifier(handle.db));
  const events = new AgentEventsService(handle.db);
  const claims = new IncidentClaimsService(handle.db, events, notifier);
  const agentView = new IncidentAgentView(handle.db, claims);
  const major = new IncidentMajorService(handle.db, audit, notifier, events);
  const files = new FilesService(handle.db, { write: async () => {}, read: async () => Buffer.alloc(0), delete: async () => {}, exists: async () => true });
  const svc = new IncidentsService(handle.db, audit, files, notifier, major, events, claims, agentView);
  const problems = new ProblemsService(handle.db, audit, notifier);
  const diagnostics = new IncidentDiagnosticsService(handle.db);
  const proposals = new IncidentProposalsService(handle.db, audit, svc, major, problems, claims, events, notifier);
  const knowledge = new IncidentKnowledgeService(handle.db, audit);
  const agentApi = new AgentApiService(handle.db, svc, claims, proposals, events, problems, notifier, diagnostics, knowledge);
  return {
    svc,
    notifier,
    major,
    problems,
    events,
    claims,
    proposals,
    diagnostics,
    reviews: new IncidentReviewService(handle.db, audit, notifier),
    reports: new IncidentReportService(handle.db),
    msp: new MspIncidentsService(handle.db, svc),
    response: new IncidentResponseService(handle.db, cfg, svc),
    humanAgents: new IncidentAgentsService(handle.db, audit, claims, svc, events),
    agentApi,
    knowledge,
    intake: new IncidentIntakeService(handle.db, svc),
    replies,
    inbound: new InboundEmailService(handle.db, svc, replies, cfg),
    intakeAdmin: new IntakeAdminService(handle.db, audit),
    intakeGuard: new IntakeAuthGuard(handle.db),
    builtin: new BuiltinAgentsService(handle.db, agentApi, events),
    agentAdmin: new AgentAdminService(handle.db, audit),
    agentGuard: new AgentAuthGuard(handle.db),
  };
}
