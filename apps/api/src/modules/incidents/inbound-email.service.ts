import { Inject, Injectable } from '@nestjs/common';
import { platformDb, tenantDb, tenantSchemaName } from '@tvmf/db';
import {
  can,
  cleanEmailReply,
  emailOf,
  emailSubjectToTitle,
  inboundEmailSchema,
  inboundTarget,
  isAutoReply,
  isGlobalRole,
  type IncSettings,
  type InboundEmail,
  type InboundOutcome,
} from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { IncidentsService } from './incidents.service';
import { InboundReplyService } from './inbound-reply.service';

export interface InboundResult {
  outcome: InboundOutcome;
  detail?: string;
  incident?: string;
}

/**
 * A message posted by the mail forwarder (docs/INTAKE.md). Nothing is acted on unless the forwarder vouches for the sender
 * (SPF/DKIM/DMARC passed), and a sender can only ever act as themselves:
 *  - a reply to one of our emails carries the token of the person it was sent to; the sender must be that person. A customer's reply
 *    is a comment on the incident (which ends "waiting on customer"); a team member's is an internal note, never a public message.
 *  - mail to the incidents address itself raises an incident, for customers whose Super Admin switched that on, from a customer
 *    user at that customer (one customer, or `incidents+<slug>@` to say which).
 * Auto-replies and delivery failures are dropped (they would loop), a message is handled once, and every outcome is logged.
 */
@Injectable()
export class InboundEmailService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly incidents: IncidentsService,
    private readonly replies: InboundReplyService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async handle(body: unknown): Promise<InboundResult> {
    const mail = inboundEmailSchema.parse(body);
    const from = emailOf(mail.from.email);
    const p = platformDb(this.db);
    // Once only: the forwarder may retry.
    const claimed = await p.insertInto('inbound_email_log').values({ message_id: mail.messageId, from_email: from, subject: mail.subject.slice(0, 300), outcome: 'error', detail: 'in progress' }).onConflict((oc) => oc.column('message_id').doNothing()).returning('id').executeTakeFirst();
    if (!claimed) return { outcome: 'duplicate' };
    let result: InboundResult & { tenantId?: string; incidentId?: string };
    try {
      result = await this.process(mail, from);
    } catch (e) {
      result = { outcome: 'error', detail: (e as Error).message.slice(0, 300) };
    }
    await p.updateTable('inbound_email_log').set({ outcome: result.outcome, detail: result.detail ?? '', tenant_id: result.tenantId ?? null, incident_id: result.incidentId ?? null }).where('id', '=', claimed.id).execute();
    return { outcome: result.outcome, detail: result.detail, incident: result.incident };
  }

  private async process(mail: InboundEmail, from: string): Promise<InboundResult & { tenantId?: string; incidentId?: string }> {
    const base = this.cfg.INBOUND_EMAIL_ADDRESS;
    if (!base) return { outcome: 'disabled' };
    if (isAutoReply({ headers: mail.headers, subject: mail.subject, from })) return { outcome: 'auto_reply' };
    const target = inboundTarget([...mail.to, ...(mail.cc ?? [])], base);
    if (!target) return { outcome: 'not_ours' };
    if (!mail.authenticated) return { outcome: 'unauthenticated', detail: 'The forwarder did not vouch for the sender.' };
    const text = cleanEmailReply(mail.text);
    if (target.kind === 'reply') return this.reply(target.token, from, text, mail);
    return this.raise(target.hint, from, text, mail);
  }

  private async user(email: string) {
    const u = await platformDb(this.db).selectFrom('users').select(['id', 'email', 'display_name', 'role', 'status']).where('email', '=', email).executeTakeFirst();
    return u && u.status === 'active' ? u : null;
  }

  private asUser(u: { id: string; email: string; display_name: string; role: AuthedUser['role'] }): AuthedUser {
    return { id: u.id, email: u.email, displayName: u.display_name, role: u.role, totpEnrolled: true, enrolOnly: false, pwresetOnly: false };
  }

  /** The customer context for this person, as TenantGuard would build it: refused unless they belong to it. */
  private async context(user: { id: string; role: AuthedUser['role'] }, tenantId: string): Promise<{ t: TenantContext; settings: IncSettings } | null> {
    const p = platformDb(this.db);
    const tenant = await p.selectFrom('tenants').select(['id', 'slug', 'name', 'schema_name', 'status', 'teams_read_only', 'managed_services_enabled', 'inc_settings']).where('id', '=', tenantId).executeTakeFirst();
    if (!tenant || tenant.status !== 'active' || !tenant.managed_services_enabled) return null;
    let siteScope: string[] | null = null;
    if (!isGlobalRole(user.role)) {
      const m = await p.selectFrom('tenant_memberships').select('site_ids').where('user_id', '=', user.id).where('tenant_id', '=', tenantId).executeTakeFirst();
      if (!m) return null;
      if (Array.isArray(m.site_ids) && m.site_ids.length > 0) siteScope = m.site_ids;
    }
    return { t: { id: tenant.id, slug: tenant.slug, name: tenant.name, schema: tenant.schema_name || tenantSchemaName(tenant.id), siteScope, teamsReadOnly: tenant.teams_read_only, managedServices: true }, settings: (tenant.inc_settings ?? {}) as IncSettings };
  }

  private async reply(token: string, from: string, text: string, mail: InboundEmail): Promise<InboundResult & { tenantId?: string; incidentId?: string }> {
    const tok = await this.replies.lookup(token);
    if (!tok) return { outcome: 'bad_token' };
    const u = await this.user(from);
    const owner = await platformDb(this.db).selectFrom('users').select(['id', 'email', 'status']).where('id', '=', tok.user_id).executeTakeFirst();
    // The token was made for one person: only they can use it, whoever the email was forwarded to.
    if (!owner || owner.email.toLowerCase() !== from) return { outcome: 'sender_mismatch', tenantId: tok.tenant_id, incidentId: tok.incident_id };
    if (!u) return { outcome: 'user_inactive', tenantId: tok.tenant_id, incidentId: tok.incident_id };
    const ctx = await this.context(u, tok.tenant_id);
    if (!ctx) return { outcome: 'not_member', tenantId: tok.tenant_id, incidentId: tok.incident_id };
    const row = await tenantDb(this.db, ctx.t.schema).selectFrom('incidents').select(['id', 'number', 'status']).where('id', '=', tok.incident_id).executeTakeFirst();
    if (!row) return { outcome: 'incident_gone', tenantId: tok.tenant_id };
    if (!text) return { outcome: 'empty', tenantId: tok.tenant_id, incidentId: row.id };
    const user = this.asUser(u);
    const staff = can(user.role, 'inc:manage');
    try {
      // The team's replies stay internal: replying to a notification must never publish to the customer by accident.
      await this.incidents.comment(ctx.t, user, row.id, { body: text, internal: staff }, staff);
    } catch (e) {
      return { outcome: 'incident_closed', detail: (e as Error).message.slice(0, 200), tenantId: tok.tenant_id, incidentId: row.id };
    }
    return { outcome: staff ? 'noted' : 'replied', incident: `INC-${String(row.number).padStart(4, '0')}`, tenantId: tok.tenant_id, incidentId: row.id };
  }

  private async raise(hint: string | null, from: string, text: string, mail: InboundEmail): Promise<InboundResult & { tenantId?: string; incidentId?: string }> {
    const u = await this.user(from);
    if (!u) return { outcome: 'unknown_sender' };
    const p = platformDb(this.db);
    // Which customer: the one they belong to (or the one the address names), if it has email intake switched on.
    const tenants = await p.selectFrom('tenants').select(['id', 'slug', 'inc_settings', 'managed_services_enabled', 'status']).where('status', '=', 'active').where('managed_services_enabled', '=', true).execute();
    const member = isGlobalRole(u.role) ? null : new Set((await p.selectFrom('tenant_memberships').select('tenant_id').where('user_id', '=', u.id).execute()).map((m) => m.tenant_id));
    let eligible = tenants.filter((t) => (member ? member.has(t.id) : true));
    if (hint) eligible = eligible.filter((t) => t.slug.toLowerCase() === hint.toLowerCase());
    else if (!member) return { outcome: 'ambiguous_customer', detail: 'Staff say which customer: incidents+<customer>@' };
    eligible = eligible.filter((t) => ((t.inc_settings ?? {}) as IncSettings).emailIntake);
    if (eligible.length === 0) return { outcome: 'disabled', detail: 'Raising incidents by email is not switched on for that customer.' };
    if (eligible.length > 1) return { outcome: 'ambiguous_customer', detail: 'Say which customer: incidents+<customer>@' };
    const ctx = await this.context(u, eligible[0]!.id);
    if (!ctx) return { outcome: 'not_member' };
    const user = this.asUser(u);
    const staff = can(user.role, 'inc:manage');
    if (!text || text.length < 3) return { outcome: 'empty', tenantId: ctx.t.id };
    // A site contact raises for their own site, and must have just one.
    let siteId: string | null = null;
    if (ctx.t.siteScope) {
      if (ctx.t.siteScope.length !== 1) return { outcome: 'site_ambiguous', tenantId: ctx.t.id, detail: 'Several sites: raise it in Voxshift so the site can be chosen.' };
      siteId = ctx.t.siteScope[0]!;
    }
    const { row } = await this.incidents.createFromIntake(ctx.t, user, {
      title: emailSubjectToTitle(mail.subject, from),
      description: `${text}\n\n(Raised by email${mail.attachments ? `; ${mail.attachments} attachment${mail.attachments === 1 ? ' was' : 's were'} not kept: add ${mail.attachments === 1 ? 'it' : 'them'} in Voxshift` : ''}.)`,
      category: 'other',
      impact: 'team',
      urgency: 'degraded',
      siteId,
      source: 'email',
      dedupKey: null,
      reporterId: u.id,
      staffRaised: staff,
    });
    return { outcome: 'raised', incident: row.reference, tenantId: ctx.t.id, incidentId: row.id };
  }
}

