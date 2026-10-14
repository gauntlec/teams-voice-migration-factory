import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import { can, incCanReopen, incReference, type IncStatus, type IncidentResponseInput } from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { verifyIncidentLink } from './incident-links';
import { IncidentsService } from './incidents.service';

const BAD_LINK = 'This link has expired or is not valid. Sign in to Voxshift and answer on the incident page instead.';

/**
 * "Is it fixed?" answered from the email, without signing in. The signed link
 * (incident-links.ts) stands in for the person it was sent to; the answer then
 * goes through the same rules as if they had clicked in the app, so only the
 * reporter or a follower can close or reopen, and only while it is resolved.
 * Answering twice is harmless.
 */
@Injectable()
export class IncidentResponseService {
  constructor(
    @InjectDb() private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly incidents: IncidentsService,
  ) {}

  private async open(token: string) {
    const link = verifyIncidentLink(this.cfg.JWT_REFRESH_SECRET, token);
    if (!link) throw new BadRequestException(BAD_LINK);
    const p = platformDb(this.db);
    const [tenant, user] = await Promise.all([
      p.selectFrom('tenants').select(['id', 'slug', 'name', 'schema_name', 'managed_services_enabled', 'status']).where('id', '=', link.t).executeTakeFirst(),
      p.selectFrom('users').select(['id', 'email', 'display_name', 'role', 'status', 'totp_enrolled']).where('id', '=', link.u).executeTakeFirst(),
    ]);
    if (!tenant || tenant.status !== 'active' || !tenant.managed_services_enabled || !user || user.status !== 'active') throw new BadRequestException(BAD_LINK);
    const incident = await tenantDb(this.db, tenant.schema_name).selectFrom('incidents').selectAll().where('id', '=', link.i).executeTakeFirst();
    if (!incident) throw new NotFoundException('That incident no longer exists.');
    const t: TenantContext = { id: tenant.id, slug: tenant.slug, name: tenant.name, schema: tenant.schema_name, siteScope: null, teamsReadOnly: false, managedServices: true };
    const who: AuthedUser = { id: user.id, email: user.email, displayName: user.display_name, role: user.role, totpEnrolled: user.totp_enrolled, enrolOnly: false, pwresetOnly: false };
    return { t, who, incident };
  }

  /** What the answer page shows. Reads only, so a link scanner opening it changes nothing. */
  async preview(token: string) {
    const { t, who, incident } = await this.open(token);
    return {
      customerName: t.name,
      person: who.displayName,
      reference: incReference(incident.number),
      title: incident.title,
      status: incident.status,
      canAnswer: incident.status === 'resolved' || (incident.status === 'closed' && incCanReopen(incident.status, incident.resolved_at)),
      canReopen: incCanReopen(incident.status, incident.resolved_at),
      incidentId: incident.id,
    };
  }

  async respond(input: IncidentResponseInput): Promise<{ status: IncStatus; reference: string; already: boolean }> {
    const { t, who, incident } = await this.open(input.t);
    const reference = incReference(incident.number);
    const staff = can(who.role, 'inc:manage');
    if (input.action === 'fixed') {
      if (incident.status === 'closed') return { status: 'closed', reference, already: true };
      const r = await this.incidents.move(t, who, incident.id, { to: 'closed' }, staff);
      return { status: r.status, reference, already: false };
    }
    if (!input.note?.trim()) throw new BadRequestException('Say what is still wrong.');
    // Already reopened (a double click, or someone beat them to it).
    if (['new', 'in_progress', 'on_hold', 'restored'].includes(incident.status)) return { status: incident.status, reference, already: true };
    const r = await this.incidents.move(t, who, incident.id, { to: 'in_progress', note: input.note }, staff);
    return { status: r.status, reference, already: false };
  }
}
