import type { Kysely } from 'kysely';
import { platformDb, tenantDb, type DB } from '@tvmf/db';
import { SR_CUSTOMER_NOTIFY_STATUSES, SR_TYPE_DEFS, srReference, type ServiceRequestStatusChangedContext } from '@tvmf/shared';
import type { MailEnqueuer } from './mail/enqueue';

/**
 * Managed Services: a deployment run started from a service request's Deploy
 * tab (scope.serviceRequestId) has finished.
 *
 * - Always: a staff-only 'deployment' entry on the request's timeline with
 *   the run's outcome, linked to the run.
 * - A live run with no failed changes, on a request that is Designed & built,
 *   moves the request to Deployed (status_changed entry) and emails the
 *   requester - the same email the API sends when an engineer moves it by hand.
 *
 * Best-effort, like the completion email: a problem here is logged and never
 * fails the run itself.
 */
export async function recordServiceRequestRun(
  db: Kysely<DB>,
  enqueueMail: MailEnqueuer,
  args: {
    tenantId: string;
    schema: string;
    serviceRequestId: string;
    deploymentId: string;
    operatorUserId: string;
    mode: 'dry_run' | 'execute';
    counts: { applied: number; skipped: number; failed: number; whatif: number };
    /** Set when the run itself didn't finish. */
    errorMessage?: string;
  },
): Promise<void> {
  try {
    const s = tenantDb(db, args.schema);
    const sr = await s
      .selectFrom('service_requests')
      .select(['id', 'number', 'type', 'title', 'status', 'requested_by'])
      .where('id', '=', args.serviceRequestId)
      .executeTakeFirst();
    if (!sr) return;

    const what = args.mode === 'execute' ? 'Deployment' : 'What-If run';
    const { applied, skipped, failed, whatif } = args.counts;
    const clean = !args.errorMessage && failed === 0;
    const body = args.errorMessage
      ? `${what} failed: ${args.errorMessage}`
      : failed > 0
        ? `${what} finished with ${failed} failed change${failed === 1 ? '' : 's'} (${applied} applied, ${skipped} skipped). Fix them and deploy again.`
        : args.mode === 'execute'
          ? `${what} finished: ${applied} change${applied === 1 ? '' : 's'} applied, ${skipped} already in place.`
          : `${what} finished: ${whatif} change${whatif === 1 ? '' : 's'} would be made, ${skipped} already in place.`;
    await s
      .insertInto('service_request_events')
      .values({ request_id: sr.id, kind: 'deployment', body, internal: true, deployment_id: args.deploymentId, author_id: args.operatorUserId })
      .execute();

    if (args.mode !== 'execute' || !clean || sr.status !== 'built') {
      await s.updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', sr.id).execute();
      return;
    }

    const now = new Date().toISOString();
    const moved = await s
      .updateTable('service_requests')
      .set({ status: 'deployed', deployed_at: now, updated_at: now })
      .where('id', '=', sr.id)
      .where('status', '=', 'built') // an engineer moving it at the same moment wins
      .returning('id')
      .executeTakeFirst();
    if (!moved) return;
    const note = 'Deployed to Microsoft Teams.';
    await s
      .insertInto('service_request_events')
      .values({ request_id: sr.id, kind: 'status_changed', from_status: 'built', to_status: 'deployed', body: note, author_id: args.operatorUserId })
      .execute();

    if (!SR_CUSTOMER_NOTIFY_STATUSES.includes('deployed') || sr.requested_by === args.operatorUserId) return;
    const [requester, tenant] = await Promise.all([
      platformDb(db).selectFrom('users').select(['email', 'display_name', 'status']).where('id', '=', sr.requested_by).executeTakeFirst(),
      platformDb(db).selectFrom('tenants').select('name').where('id', '=', args.tenantId).executeTakeFirst(),
    ]);
    if (!requester || requester.status !== 'active') return;
    const webOrigin = (process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');
    const context: ServiceRequestStatusChangedContext = {
      customerName: tenant?.name ?? 'your organisation',
      reference: srReference(sr.number),
      title: sr.title,
      typeLabel: SR_TYPE_DEFS[sr.type].label,
      fromStatus: 'built',
      toStatus: 'deployed',
      note,
      runUrl: `${webOrigin}/service-requests/${sr.id}`,
    };
    await enqueueMail({
      template: 'service_request_status_changed',
      to: { email: requester.email, name: requester.display_name },
      context,
      related: { type: 'service_request', id: sr.id },
      createdBy: args.operatorUserId,
      tenantId: args.tenantId,
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[deployment ${args.deploymentId}] service request update failed: ${(e as Error).message}`);
  }
}
