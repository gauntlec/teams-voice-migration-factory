import { sql } from 'kysely';
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import { createIncidentSchema, type CreateIncidentInput } from '@tvmf/shared';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';
import { IncidentKnowledgeService } from './incident-knowledge.service';
import { IncidentMajorService } from './incident-major.service';
import { IncidentsService } from './incidents.service';

/**
 * Demo incidents for a TEST customer (docs/INTAKE.md): a believable spread (a major incident, urgent and routine ones, one on hold, one
 * resolved and one closed, and what was learned from the fixed one) so the module can be shown, trained on or checked without raising
 * things by hand. Refused for a real customer, and only done once. Emails go where a test customer's emails always go.
 */
@Injectable()
export class IncidentDemoService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly incidents: IncidentsService,
    private readonly major: IncidentMajorService,
    private readonly knowledge: IncidentKnowledgeService,
  ) {}

  async seed(t: TenantContext, user: AuthedUser): Promise<{ created: number }> {
    if (!t.managedServices) throw new BadRequestException('Managed Services is not switched on for this customer.');
    const tenant = await platformDb(this.db).selectFrom('tenants').select('sandbox').where('id', '=', t.id).executeTakeFirst();
    if (!tenant?.sandbox) throw new ForbiddenException('Demo incidents can only be added to a test customer.');
    const s = tenantDb(this.db, t.schema);
    const already = await s.selectFrom('incidents').select('id').where(sql<boolean>`details @> '{"demo": true}'::jsonb`).limit(1).executeTakeFirst();
    if (already) throw new ConflictException('This customer already has demo incidents.');
    const sites = await s.selectFrom('discovery_sites').select(['id', 'sitecode']).where('mode', '=', 'operations').orderBy('sitecode').limit(2).execute();
    if (sites.length === 0) throw new BadRequestException('Move a site to operations first (Service Requests -> Site modes): incidents are raised for sites that are live.');
    const [a, b = a] = sites;

    const make = async (input: Record<string, unknown>) => {
      const row = await this.incidents.create(t, user, createIncidentSchema.parse(input) as CreateIncidentInput, true);
      await s.updateTable('incidents').set({ details: JSON.stringify({ ...(row.details as object), demo: true }) }).where('id', '=', row.id).execute();
      return row;
    };
    const move = (id: string, to: string, note?: string, extra: Record<string, unknown> = {}) => this.incidents.move(t, user, id, { to, note, ...extra } as never, true);
    const note = (id: string, body: string, internal = true) => this.incidents.comment(t, user, id, { body, internal }, true);

    // 1. A live major incident.
    const p1 = await make({ title: 'No inbound or outbound calls at the main site', category: 'call_failure', subcategory: 'outbound_fail', siteId: a!.id, impact: 'site', urgency: 'cannot_call', description: 'Nobody at the main site can make or receive calls since 09:05. Desk phones show "no service".', answers: { direction: 'Outbound calls', started: 'Today 09:05' } });
    await move(p1.id, 'in_progress');
    await note(p1.id, 'SBC shows the carrier trunk down. Carrier raised.');
    await this.major.declare(t, user, p1.id, { leadId: user.id, commsId: user.id, summary: 'We are aware that calls at the main site are failing. The carrier trunk is down and the carrier is working on it.' });
    // 2. Urgent, being worked.
    const q = await make({ title: 'Support queue is not ringing agents', category: 'queues_aa', subcategory: 'queue_not_ringing', siteId: b!.id, impact: 'team', urgency: 'degraded', description: 'Calls to the Support queue go straight to voicemail even though agents are signed in.', answers: { which: 'Support queue', expected: 'Agents ring', actual: 'Straight to voicemail', started: 'Today 08:30' } });
    await move(q.id, 'in_progress');
    await this.incidents.assign(t, user, q.id, { userId: user.id });
    await note(q.id, 'Two of the five agents have Enterprise Voice off. Checking with the customer who removed it.');
    // 3. Routine, new.
    await make({ title: 'Choppy audio on calls from home', category: 'call_quality', subcategory: 'choppy_audio', siteId: a!.id, impact: 'individual', urgency: 'degraded', description: 'One user hears robotic audio on Teams calls from home, fine in the office.', answers: { where: 'Working from home', how_often: 'Most calls', started: 'This week' } });
    // 4. On hold with a vendor.
    const h = await make({ title: 'Desk phone will not provision', category: 'devices', subcategory: 'desk_phone', siteId: b!.id, impact: 'individual', urgency: 'feature_broken', description: 'A new desk phone stays on the manufacturer logo and never reaches the sign-in screen.', answers: { started: 'Yesterday', device: 'Desk phone', affected_user: 'Reception' } });
    await move(h.id, 'in_progress');
    await move(h.id, 'on_hold', 'Waiting for the vendor to confirm the firmware fault.', { holdReason: 'vendor' });
    // 5. Fixed, and what was learned.
    const r = await make({ title: 'One-way audio on wifi handsets', category: 'call_quality', subcategory: 'one_way_audio', siteId: a!.id, impact: 'team', urgency: 'degraded', description: 'Callers on the wifi network hear nothing from our side; wired phones are fine.', answers: { where: 'In the office on wifi', how_often: 'Every call', started: 'Last week' } });
    await move(r.id, 'in_progress');
    await move(r.id, 'restored', 'Opened UDP 3478-3481 to the Teams media range on the site firewall.');
    await move(r.id, 'resolved', 'Opened UDP 3478-3481 to the Teams media range on the site firewall. Audio is two-way on wifi again.');
    await this.knowledge.create(t, user, { title: 'One-way audio on wifi handsets', category: 'call_quality', subcategory: 'one_way_audio', symptoms: 'Callers on the wifi network hear nothing from our side; wired phones are fine.', fix: 'Open UDP 3478-3481 to the Teams media range on the site firewall.', customerText: 'If calls on wifi have no audio, ask your IT team to check the firewall allows the Teams media ports (UDP 3478-3481).', sourceIncidentId: r.id });
    // 6. Closed.
    const c = await make({ title: 'Voicemail greeting not playing', category: 'voicemail_recording', subcategory: 'vm_greeting', siteId: b!.id, impact: 'individual', urgency: 'feature_broken', description: 'The recorded greeting is skipped and callers hear the default message.', answers: { started: 'Two weeks ago', affected_user: 'Sam' } });
    await move(c.id, 'in_progress');
    await move(c.id, 'restored', 'Re-recorded the greeting.');
    await move(c.id, 'resolved', 'Re-recorded the greeting and checked it plays.');
    await move(c.id, 'closed');
    return { created: 6 };
  }
}
