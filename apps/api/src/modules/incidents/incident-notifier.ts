import { Inject, Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  INC_AUTOCLOSE_DAYS,
  INC_HOLD_CUSTOMER_LABELS,
  INC_PRIORITY_CUSTOMER_TEXT,
  INC_PRIORITY_LABELS,
  incCategoryLabel,
  incDetailLines,
  incReference,
  type EmailTemplate,
  type IncDetails,
  type IncHoldReason,
  type IncMoveKind,
  type IncPriority,
  type IncSettings,
  type IncidentActivityContext,
  type IncidentCreatedContext,
  type IncidentMessageContext,
  type IncidentResolvedContext,
  type IncidentStatusChangedContext,
} from '@tvmf/shared';
import { APP_CONFIG, type AppConfig } from '../../common/config';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { MailService } from '../../mail/mail.service';
import { signIncidentLink } from './incident-links';

export interface StaffMember {
  id: string;
  email: string;
  display_name: string;
  role: string;
}

/** The incident columns the emails are built from. */
export interface NotifiableIncident {
  id: string;
  number: number;
  title: string;
  category: string;
  subcategory: string | null;
  priority: IncPriority;
  assigned_to: string | null;
  reporter_id: string;
}

/**
 * Who hears about what on an incident (docs/INCIDENT-MANAGEMENT.md, section 6).
 * Customer-side mail goes to the reporter and anyone following the incident,
 * never to whoever just did the thing. Team-side mail goes to the assignee, or
 * every engineer and Super Admin on the customer when nobody is assigned. A
 * mail problem never fails the change that caused it.
 */
@Injectable()
export class IncidentNotifier {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private url(id: string) {
    return `${this.cfg.WEB_ORIGIN.replace(/\/+$/, '')}/incidents/${id}`;
  }

  /** The people who work this customer's incidents: its engineers and every Super Admin. */
  async staff(t: TenantContext): Promise<StaffMember[]> {
    const p = platformDb(this.db);
    const [engineers, admins] = await Promise.all([
      p
        .selectFrom('tenant_memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select(['u.id as id', 'u.email as email', 'u.display_name as display_name', 'u.role as role'])
        .where('m.tenant_id', '=', t.id)
        .where('u.role', '=', 'ENGINEER')
        .where('u.status', '=', 'active')
        .execute(),
      p.selectFrom('users').select(['id', 'email', 'display_name', 'role']).where('role', '=', 'SUPER_ADMIN').where('status', '=', 'active').execute(),
    ]);
    const byId = new Map<string, StaffMember>();
    for (const u of [...engineers, ...admins]) byId.set(u.id, u);
    return [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  /** The reporter and followers who can still be emailed, except `exceptUserId`. */
  private async customerSide(t: TenantContext, incidentId: string, reporterId: string, exceptUserId: string | null) {
    const watchers = await tenantDb(this.db, t.schema).selectFrom('incident_watchers').select('user_id').where('incident_id', '=', incidentId).execute();
    const ids = [...new Set([reporterId, ...watchers.map((w) => w.user_id)])].filter((id) => id !== exceptUserId);
    if (ids.length === 0) return [];
    return platformDb(this.db).selectFrom('users').select(['id', 'email', 'display_name']).where('id', 'in', ids).where('status', '=', 'active').execute();
  }

  private async teamSide(t: TenantContext, row: NotifiableIncident, exceptUserId: string | null, assigneeOnly = false) {
    const staff = await this.staff(t);
    const assignee = row.assigned_to ? staff.find((m) => m.id === row.assigned_to) : undefined;
    const to = assignee ? [assignee] : assigneeOnly ? [] : staff;
    return to.filter((m) => m.id !== exceptUserId);
  }

  private async send(t: TenantContext, template: EmailTemplate, to: { email: string; display_name: string }[], context: object, incidentId: string, createdBy: string | null) {
    for (const r of to) {
      try {
        await this.mail.enqueue({
          template,
          to: { email: r.email, name: r.display_name },
          context: context as Record<string, unknown>,
          related: { type: 'incident', id: incidentId },
          createdBy,
          tenantId: t.id,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[incidents] could not queue ${template} for ${incidentId}: ${(e as Error).message}`);
      }
    }
  }

  private base(t: TenantContext, row: NotifiableIncident) {
    return { customerName: t.name, reference: incReference(row.number), title: row.title, runUrl: this.url(row.id) };
  }

  /** A new incident: "we've got it" to the reporter (when a customer raised it), and the team is told. */
  async created(
    t: TenantContext,
    actor: AuthedUser,
    row: NotifiableIncident & { details: IncDetails },
    opts: { siteLabel: string | null; staffRaised: boolean; settings: IncSettings; respondText: string | null },
  ) {
    const common = { customerName: t.name, reference: incReference(row.number), title: row.title, categoryLabel: incCategoryLabel(row.category, row.subcategory), siteLabel: opts.siteLabel, raisedBy: actor.displayName, runUrl: this.url(row.id), lines: incDetailLines(row.category, row.details.answers ?? {}) };
    if (!opts.staffRaised) {
      const ctx: IncidentCreatedContext = { ...common, audience: 'reporter', priorityLabel: INC_PRIORITY_CUSTOMER_TEXT[row.priority], respondText: opts.respondText };
      await this.send(t, 'incident_created', [{ email: actor.email, display_name: actor.displayName }], ctx, row.id, actor.id);
    }
    const teamCtx: IncidentCreatedContext = { ...common, audience: 'team', priorityLabel: INC_PRIORITY_LABELS[row.priority], respondText: null };
    await this.send(t, 'incident_created', (await this.staff(t)).filter((m) => m.id !== actor.id), teamCtx, row.id, actor.id);
  }

  /** A status move: the customer side hears about the ones that matter to them, the team hears when the customer acts. */
  async moved(t: TenantContext, actor: AuthedUser, row: NotifiableIncident, kind: IncMoveKind, opts: { staff: boolean; note: string | null; holdReason: IncHoldReason | null }) {
    const base = this.base(t, row);
    const teamCtx = (k: IncidentActivityContext['kind']): IncidentActivityContext => ({
      ...base,
      categoryLabel: incCategoryLabel(row.category, row.subcategory),
      priorityLabel: INC_PRIORITY_LABELS[row.priority],
      kind: k,
      author: actor.displayName,
      body: opts.note,
    });
    if (!opts.staff) {
      // The customer acted: tell the team.
      const k = kind === 'close' ? 'confirmed' : kind === 'reopen' ? 'reopened' : kind === 'cancel' ? 'cancelled' : null;
      if (k) await this.send(t, 'incident_activity', await this.teamSide(t, row, actor.id), teamCtx(k), row.id, actor.id);
      return;
    }
    const to = await this.customerSide(t, row.id, row.reporter_id, actor.id);
    if (to.length === 0) return;
    if (kind === 'resolve') {
      for (const r of to) {
        const token = signIncidentLink(this.cfg.JWT_REFRESH_SECRET, { t: t.id, i: row.id, u: r.id });
        const origin = this.cfg.WEB_ORIGIN.replace(/\/+$/, '');
        const ctx: IncidentResolvedContext = {
          ...base,
          author: actor.displayName,
          note: opts.note,
          fixedUrl: `${origin}/incident-response?t=${token}&a=fixed`,
          brokenUrl: `${origin}/incident-response?t=${token}&a=broken`,
          autoCloseDays: INC_AUTOCLOSE_DAYS,
        };
        await this.send(t, 'incident_resolved', [r], ctx, row.id, actor.id);
      }
      return;
    }
    const kinds: Partial<Record<IncMoveKind, IncidentStatusChangedContext['kind']>> = {
      acknowledge: 'acknowledge',
      restore: 'restore',
      close: 'close',
      cancel: 'cancel',
      duplicate: 'duplicate',
      reopen: 'reopen',
      // A hold on the customer is announced by the question that caused it.
      hold: opts.holdReason && opts.holdReason !== 'customer' ? 'hold' : undefined,
    };
    const k = kinds[kind];
    if (!k) return;
    const ctx: IncidentStatusChangedContext = { ...base, kind: k, holdLabel: opts.holdReason ? INC_HOLD_CUSTOMER_LABELS[opts.holdReason] : null, note: opts.note };
    await this.send(t, 'incident_status_changed', to, ctx, row.id, actor.id);
  }

  /** A comment: public from the team goes to the customer side; the customer's goes to the team; a note goes to the assignee. */
  async commented(t: TenantContext, actor: AuthedUser, row: NotifiableIncident, c: { body: string; internal: boolean; question: boolean; staff: boolean; resumed: boolean }) {
    const base = this.base(t, row);
    if (c.staff && !c.internal) {
      const ctx: IncidentMessageContext = { ...base, kind: c.question ? 'question' : 'comment', author: actor.displayName, body: c.body };
      await this.send(t, 'incident_message', await this.customerSide(t, row.id, row.reporter_id, actor.id), ctx, row.id, actor.id);
      return;
    }
    const ctx: IncidentActivityContext = {
      ...base,
      categoryLabel: incCategoryLabel(row.category, row.subcategory),
      priorityLabel: INC_PRIORITY_LABELS[row.priority],
      kind: c.internal ? 'internal_note' : c.resumed ? 'replied' : 'comment',
      author: actor.displayName,
      body: c.body,
    };
    await this.send(t, 'incident_activity', await this.teamSide(t, row, actor.id, c.internal), ctx, row.id, actor.id);
  }

  /** The priority changed: the customer side is told it did (not why). */
  async priorityChanged(t: TenantContext, actor: AuthedUser, row: NotifiableIncident) {
    const ctx: IncidentStatusChangedContext = { ...this.base(t, row), kind: 'priority', priorityText: INC_PRIORITY_CUSTOMER_TEXT[row.priority] };
    await this.send(t, 'incident_status_changed', await this.customerSide(t, row.id, row.reporter_id, actor.id), ctx, row.id, actor.id);
  }

  /** Assigned to someone else: tell them. */
  async assigned(t: TenantContext, actor: AuthedUser, row: NotifiableIncident, assigneeId: string | null) {
    if (!assigneeId || assigneeId === actor.id) return;
    const ctx: IncidentActivityContext = {
      ...this.base(t, row),
      categoryLabel: incCategoryLabel(row.category, row.subcategory),
      priorityLabel: INC_PRIORITY_LABELS[row.priority],
      kind: 'assigned',
      author: actor.displayName,
      body: null,
    };
    const to = (await this.staff(t)).filter((m) => m.id === assigneeId);
    await this.send(t, 'incident_activity', to, ctx, row.id, actor.id);
  }
}
