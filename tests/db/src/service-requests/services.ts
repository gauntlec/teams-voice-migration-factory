import type { DbHandle } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import type { MailService } from '../../../../apps/api/src/mail/mail.service';
import { BuildService } from '../../../../apps/api/src/modules/build/build.service';
import { DataCollectionService } from '../../../../apps/api/src/modules/data-collection/data-collection.service';
import { DeploymentService } from '../../../../apps/api/src/modules/deployment/deployment.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
import { AgentAdminService } from '../../../../apps/api/src/modules/incidents/agent-admin.service';
import { AgentEventsService } from '../../../../apps/api/src/modules/incidents/agent-events.service';
import { ServiceRequestsService } from '../../../../apps/api/src/modules/service-requests/service-requests.service';
import { SrAgentApiService } from '../../../../apps/api/src/modules/service-requests/sr-agent-api.service';
import { SrAgentView } from '../../../../apps/api/src/modules/service-requests/sr-agent-view.service';
import { SrAgentsService } from '../../../../apps/api/src/modules/service-requests/sr-agents.service';
import { SrClaimsService } from '../../../../apps/api/src/modules/service-requests/sr-claims.service';
import { SrProposalsService } from '../../../../apps/api/src/modules/service-requests/sr-proposals.service';
import { unused } from '../helpers';

export interface QueuedJob {
  name: string;
  data: Record<string, unknown>;
}

/**
 * The service request services wired the way the API wires them: the mail queue is a no-op (or a recorder), file storage is
 * in memory, and the deployment queue is a recorder, so a deploy ends with a queued job instead of reaching a tenant.
 */
export function srServices(handle: DbHandle, mail: Pick<MailService, 'enqueue'> = { enqueue: async () => ({ id: 'm' }) }) {
  const cfg = { WEB_ORIGIN: 'https://app.test/', JWT_REFRESH_SECRET: 'sr-secret-for-tests-0123456789' } as AppConfig;
  const audit = new AuditService(handle.db);
  const files = new FilesService(handle.db, { write: async () => {}, read: async () => Buffer.alloc(0), delete: async () => {}, exists: async () => true, deleteFolder: async () => {}, folderStats: async () => ({ files: 0, bytes: 0 }) });
  const jobs: QueuedJob[] = [];
  const queue = { add: async (name: string, data: Record<string, unknown>) => (jobs.push({ name, data }), { id: 'j' }) };
  const build = new BuildService(handle.db, audit, unused('validation'), unused('discovery'), unused('documentBuilder'), files);
  const dataCollection = new DataCollectionService(handle.db, audit);
  const deployment = new DeploymentService(handle.db, queue as never, audit, files, unused('documentBuilder'));
  const events = new AgentEventsService(handle.db);
  const claims = new SrClaimsService(handle.db, events);
  const view = new SrAgentView(handle.db, claims);
  const requests = new ServiceRequestsService(handle.db, mail as MailService, audit, cfg, build, dataCollection, deployment, files, claims, view, events);
  const proposals = new SrProposalsService(handle.db, audit, requests, claims, events, deployment);
  return {
    requests,
    build,
    deployment,
    claims,
    proposals,
    events,
    jobs,
    humanAgents: new SrAgentsService(handle.db, audit, claims, requests, events),
    agentApi: new SrAgentApiService(handle.db, audit, requests, claims, proposals, events, deployment),
    agentAdmin: new AgentAdminService(handle.db, audit),
  };
}
