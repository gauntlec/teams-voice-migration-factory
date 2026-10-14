import type { DbHandle } from '@tvmf/db';
import { AuditService } from '../../../../apps/api/src/common/audit.service';
import type { AppConfig } from '../../../../apps/api/src/common/config';
import type { MailService } from '../../../../apps/api/src/mail/mail.service';
import { FilesService } from '../../../../apps/api/src/modules/files/files.service';
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
export function incidentServices(handle: DbHandle, mail: Pick<MailService, 'enqueue'> = { enqueue: async () => ({ id: 'm' }) }) {
  const cfg = { WEB_ORIGIN: 'https://app.test/', JWT_REFRESH_SECRET: TEST_SECRET } as AppConfig;
  const audit = new AuditService(handle.db);
  const notifier = new IncidentNotifier(handle.db, mail as MailService, cfg);
  const major = new IncidentMajorService(handle.db, audit, notifier);
  const files = new FilesService(handle.db, { write: async () => {}, read: async () => Buffer.alloc(0), delete: async () => {}, exists: async () => true });
  const svc = new IncidentsService(handle.db, audit, files, notifier, major);
  return {
    svc,
    notifier,
    major,
    problems: new ProblemsService(handle.db, audit, notifier),
    reviews: new IncidentReviewService(handle.db, audit, notifier),
    reports: new IncidentReportService(handle.db),
    msp: new MspIncidentsService(handle.db, svc),
    response: new IncidentResponseService(handle.db, cfg, svc),
  };
}
