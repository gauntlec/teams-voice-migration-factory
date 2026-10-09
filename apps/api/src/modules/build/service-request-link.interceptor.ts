import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { mergeMap, type Observable } from 'rxjs';
import { tenantDb } from '@tvmf/db';
import { SR_BUILD_ROUTE_KIND, SR_DESIGN_HEADER, SR_STATUS_LABELS, can, srDesignEditable, srReference } from '@tvmf/shared';
import type { AppRequest } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Managed Services: a service request's Design tab uses the normal Design &
 * Build editors and sends the request id in the x-service-request header.
 * When one of the create routes in SR_BUILD_ROUTE_KIND gets that header, the
 * new row is linked to the request (service_request_items), so the request's
 * Deploy tab deploys exactly what was designed for it.
 *
 * Checked before the row is made, so nothing is created that can't be linked:
 * Managed Services is on, the caller can manage requests, the request is
 * Planned, and the row is for the request's site. Without the header (the
 * normal Design & Build page) this does nothing.
 */
@Injectable()
export class ServiceRequestLinkInterceptor implements NestInterceptor {
  constructor(@InjectDb() private readonly db: Db) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const header = req.headers[SR_DESIGN_HEADER];
    const requestId = Array.isArray(header) ? header[0] : header;
    if (req.method !== 'POST' || !requestId) return next.handle();
    const kind = SR_BUILD_ROUTE_KIND[String(Reflect.getMetadata(PATH_METADATA, ctx.getHandler()) ?? '')];
    if (!kind) return next.handle();

    const t = req.tenant;
    const user = req.user;
    if (!t || !user) return next.handle();
    if (!UUID_RE.test(requestId)) throw new BadRequestException('Unknown service request.');
    if (!t.managedServices) throw new ForbiddenException('Managed Services is not switched on for this customer.');
    if (!can(user.role, 'sr:manage')) throw new ForbiddenException('Only the engineers on this customer can design a service request.');

    const s = tenantDb(this.db, t.schema);
    const sr = await s.selectFrom('service_requests').select(['id', 'number', 'status', 'site_id']).where('id', '=', requestId).executeTakeFirst();
    if (!sr) throw new NotFoundException('service request not found');
    const reference = srReference(sr.number);
    if (!srDesignEditable(sr.status)) {
      throw new BadRequestException(`${reference} is ${SR_STATUS_LABELS[sr.status]}, so its design can't change. Only a Planned request can be designed.`);
    }
    const siteId = (req.body as { site_id?: unknown } | undefined)?.site_id;
    if (!sr.site_id || siteId !== sr.site_id) {
      throw new BadRequestException(`Rows for ${reference} must be on the request's own site.`);
    }

    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        const rowId = (result as { id?: unknown } | null)?.id;
        if (typeof rowId === 'string') {
          await s
            .insertInto('service_request_items')
            .values({ request_id: sr.id, kind, row_id: rowId, created_by: user.id })
            .onConflict((oc) => oc.doNothing())
            .execute();
          await s.updateTable('service_requests').set({ updated_at: new Date().toISOString() }).where('id', '=', sr.id).execute();
        }
        return result;
      }),
    );
  }
}
