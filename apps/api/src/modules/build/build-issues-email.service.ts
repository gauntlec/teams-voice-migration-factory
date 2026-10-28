import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import { siteContactTargets, type BuildIssueRecipient, type DiscoverySiteOverview, type EmailBuildIssuesInput, type EmailBuildIssuesResult, type ValidationIssuesAlertItem } from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { MailService } from '../../mail/mail.service';
import { assertSiteInScope } from '../data-collection/site-scope';
import { BuildService } from './build.service';

const SHEET_LABEL = { users: 'User', caps: 'Common area phone', 'resource-accounts': 'Resource account' } as const;

/**
 * Tells a site's contacts which issues on the Validation issues tab need resolving. An engineer picks the issues; the people it goes
 * to are the site's Site contact(s) from the Overview (users picked there, and people typed in), optionally narrowed. The picked
 * issues are checked against the site's current issues, so only what is still wrong goes out, in the tab's own words.
 */
@Injectable()
export class BuildIssuesEmailService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
    private readonly build: BuildService,
    private readonly mail: MailService,
  ) {}

  private async site(t: TenantContext, siteId: string) {
    const site = await tenantDb(this.db, t.schema).selectFrom('discovery_sites').select(['id', 'sitecode', 'name', 'overview']).where('id', '=', siteId).executeTakeFirst();
    if (!site) throw new BadRequestException('Unknown site for this customer.');
    assertSiteInScope(t, site.id);
    return site;
  }

  /** The site's contacts an issues email would go to. */
  async recipients(t: TenantContext, siteId: string): Promise<BuildIssueRecipient[]> {
    const site = await this.site(t, siteId);
    const targets = siteContactTargets(site.overview as DiscoverySiteOverview);
    const out = new Map<string, BuildIssueRecipient>();
    if (targets.userIds.length) {
      const users = await platformDb(this.db).selectFrom('users').select(['email', 'display_name']).where('id', 'in', targets.userIds).where('status', '=', 'active').execute();
      for (const u of users) out.set(u.email.toLowerCase(), { email: u.email, name: (u.display_name as string | null) ?? null, kind: 'user' });
    }
    for (const c of targets.typed) if (!out.has(c.email.toLowerCase())) out.set(c.email.toLowerCase(), { email: c.email, name: c.name, kind: 'typed' });
    return [...out.values()];
  }

  async send(t: TenantContext, u: AuthedUser, input: EmailBuildIssuesInput): Promise<EmailBuildIssuesResult> {
    const site = await this.site(t, input.site_id);
    let to = await this.recipients(t, input.site_id);
    if (!to.length) throw new BadRequestException("This site has no site contact to email. Add one under Site contact(s) on the site's Overview.");
    if (input.recipients) {
      const wanted = new Set(input.recipients.map((e) => e.toLowerCase()));
      to = to.filter((r) => wanted.has(r.email.toLowerCase()));
      if (!to.length) throw new BadRequestException('None of the chosen people are contacts on this site.');
    }

    // Only what is still an issue, in the tab's own words, whatever the caller sent.
    const current = await this.build.siteIssues(t, input.site_id);
    const key = (sheet: string, rowId: string, code: string, detail: string) => `${sheet}|${rowId}|${code}|${detail}`;
    const byKey = new Map(current.map((i) => [key(i.sheet, i.rowId, i.issue.code, i.issue.detail), i]));
    const picked = new Set<string>();
    const items: ValidationIssuesAlertItem[] = [];
    for (const want of input.issues) {
      const k = key(want.sheet, want.row_id, want.code, want.detail);
      const hit = byKey.get(k);
      if (!hit || picked.has(k) || hit.issue.severity === 'info') continue;
      picked.add(k);
      items.push({ name: hit.displayName, upn: hit.upn, sheet: SHEET_LABEL[hit.sheet], label: hit.issue.label, detail: hit.issue.detail });
    }
    if (!items.length) throw new ConflictException('These issues are no longer showing, so there is nothing to send. Refresh the list.');

    const message = input.message?.trim() || null;
    for (const r of to) {
      await this.mail.enqueue({
        template: 'validation_issues_alert',
        to: { email: r.email, name: r.name },
        context: { recipientName: r.name, customerName: t.name, siteName: site.name ?? site.sitecode, sitecode: site.sitecode, senderName: u.displayName || u.email, message, issues: items },
        related: { type: 'discovery_site', id: site.id },
        createdBy: u.id,
        tenantId: t.id,
        replyTo: u.email,
      });
    }
    await this.audit.tenant(t.schema, 'build.issues_emailed', {
      actor: { id: u.id, email: u.email },
      targetType: 'discovery_site',
      targetId: site.id,
      detail: { issues: items.length, recipients: to.map((r) => r.email), skipped: input.issues.length - items.length },
    });
    return { sent: to.length, issues: items.length, skipped: input.issues.length - items.length };
  }
}
