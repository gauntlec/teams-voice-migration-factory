import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { platformDb, tenantDb } from '@tvmf/db';
import {
  INC_CATEGORY_BY_KEY,
  SR_TYPE_DEFS,
  incEffectiveMatrix,
  incEffectiveTargets,
  incPause,
  incPriority,
  srEffectiveTargets,
  type IncHoldReason,
  type IncImpact,
  type IncPriority,
  type IncSettings,
  type IncStatus,
  type IncUrgency,
  type SrFieldSpec,
  type SrPriority,
  type SrStatus,
  type SrType,
} from '@tvmf/shared';
import { AuditService } from '../../common/audit.service';
import type { AuthedUser, TenantContext } from '../../common/request';
import { InjectDb, type Db } from '../../db/db.module';

/**
 * Demo history for a customer (docs/INTAKE.md, "Demo data"): about two months of believable incidents and service requests so the queues,
 * dashboards and reports have something to show: closed cases at a mix of speeds (some targets missed), a few open and on hold, two past
 * major incidents with reviews, a live one, problems, knowledge and requests at every stage. People come from the customer's own Discovery
 * (the affected users and the people in requests are real accounts from the tenant) and its own team.
 *
 * It writes straight to the database with the times it simulates, running the real pause rules, and sends NO emails and raises NO
 * assistant events. Every row is tagged (`details.demo`, a "(Demo data)" problem) so `remove()` takes it all away again.
 */

type Rnd = () => number;
const mulberry32 = (seed: number): Rnd => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const hashSeed = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
export const DEMO_PROBLEM_MARK = '(Demo data) ';

interface Person {
  upn: string;
  name: string;
}
interface Staff {
  id: string;
  name: string;
}

interface IncTemplate {
  category: string;
  sub: string | null;
  impact: IncImpact;
  urgency: IncUrgency;
  title: (u: Person) => string;
  description: (u: Person) => string;
  notes: string[];
  fix: string;
  tip?: string;
}

const TEMPLATES: IncTemplate[] = [
  { category: 'call_failure', sub: 'outbound_fail', impact: 'team', urgency: 'cannot_call', title: () => 'Several people cannot make outbound calls', description: (u) => `${u.name} and others on the team get a fast busy tone when they dial out. Inbound calls are fine.`, notes: ['Checked the voice routing policy assignments: three users lost the policy after a licence change.', 'Reassigned the policy and asked the team to sign out and in.'], fix: 'Re-assigned the voice routing policy that dropped off after the licence change. Outbound calls work again.' },
  { category: 'call_failure', sub: 'inbound_fail', impact: 'individual', urgency: 'cannot_call', title: (u) => `${u.name} is not receiving inbound calls`, description: (u) => `Callers to ${u.name}'s direct number hear a busy tone. Outbound calls work.`, notes: ['Number shows as assigned in the tenant but the usage location was blank.', 'Set the usage location and re-applied the number.'], fix: 'Set the missing usage location and re-applied the number. Inbound calls ring again.' },
  { category: 'call_failure', sub: 'wrong_destination', impact: 'team', urgency: 'degraded', title: () => 'Main number rings the wrong team', description: () => 'Calls to the main number go to the Sales queue instead of Reception since this morning.', notes: ['The auto attendant routing was changed yesterday evening.', 'Compared with the design: the after-hours target had been saved into the business-hours branch.'], fix: 'Put the business-hours target back to Reception on the auto attendant and confirmed with a test call.' },
  { category: 'call_failure', sub: 'calls_drop', impact: 'individual', urgency: 'degraded', title: (u) => `Calls drop after about two minutes for ${u.name}`, description: (u) => `${u.name}'s calls end by themselves after roughly two minutes, always on the office wifi.`, notes: ['Pattern fits the wifi access point roaming between bands.', 'Customer IT pinned the handset to the 5GHz network.'], fix: 'Customer IT pinned the device to the 5GHz network; calls no longer drop.' },
  { category: 'call_quality', sub: 'choppy_audio', impact: 'individual', urgency: 'degraded', title: (u) => `Robotic audio on calls from home for ${u.name}`, description: (u) => `${u.name} hears robotic audio on Teams calls from home. It is fine in the office.`, notes: ['Call analytics show high packet loss from the home broadband.', 'Asked the user to switch off the VPN for Teams media.'], fix: 'Teams media excluded from the home VPN; call quality is clean again.' },
  { category: 'call_quality', sub: 'one_way_audio', impact: 'team', urgency: 'degraded', title: () => 'One-way audio on wifi handsets', description: () => 'Callers on the wifi network hear nothing from our side. Wired phones are fine.', notes: ['Reproduced from a wifi handset. Teams media ports look blocked on the guest VLAN.', 'Firewall change raised with the customer IT team.'], fix: 'Opened UDP 3478-3481 to the Teams media range on the site firewall. Audio is two-way on wifi again.', tip: 'If calls on wifi have no audio, ask your IT team to check the firewall allows the Teams media ports (UDP 3478-3481).' },
  { category: 'call_quality', sub: 'echo', impact: 'individual', urgency: 'degraded', title: (u) => `Echo on ${u.name}'s calls with the headset`, description: (u) => `People hear their own voice echo when ${u.name} is on a call with the USB headset.`, notes: ['Headset also set as the speaker and a second laptop audio device was active.'], fix: 'Disabled the second audio device and set the headset as the only device. Echo gone.' },
  { category: 'direct_routing', sub: 'trunk_down', impact: 'site', urgency: 'cannot_call', title: () => 'Carrier trunk down: no calls at the site', description: () => 'Nobody at the site can make or receive external calls. Internal Teams calls work.', notes: ['SBC shows the carrier trunk down (OPTIONS failing).', 'Carrier ticket raised; they confirm a fault on their side.'], fix: 'Carrier restored the trunk. SBC shows OPTIONS healthy and test calls pass.' },
  { category: 'direct_routing', sub: 'certificate', impact: 'site', urgency: 'feature_broken', title: () => 'SBC certificate expires in five days', description: () => 'The SBC TLS certificate expires on Friday. The certificate renewal request has not been completed.', notes: ['CSR generated and submitted to the certificate authority.'], fix: 'New certificate installed on the SBC and verified against the Microsoft trusted root.' },
  { category: 'numbers', sub: 'caller_id', impact: 'individual', urgency: 'feature_broken', title: (u) => `Wrong caller ID shown on outbound calls for ${u.name}`, description: (u) => `${u.name}'s outbound calls show the main number instead of the direct dial.`, notes: ['Caller ID policy on the user was the tenant default.'], fix: 'Assigned the site caller ID policy so the direct dial is presented.' },
  { category: 'numbers', sub: 'number_not_working', impact: 'individual', urgency: 'cannot_call', title: (u) => `${u.name}'s direct number gives a busy tone`, description: (u) => `Callers dialling ${u.name}'s direct number get a busy tone.`, notes: ['Number was released from the user during a clean-up and still shown in the design.'], fix: 'Re-assigned the number to the user and updated the design to match.' },
  { category: 'users', sub: 'no_dialpad', impact: 'individual', urgency: 'cannot_call', title: (u) => `${u.name} has no dial pad in Teams`, description: (u) => `${u.name} can see Teams chat but there is no Calls tab or dial pad.`, notes: ['Enterprise Voice not enabled; Teams Phone licence assigned yesterday.'], fix: 'Enabled Enterprise Voice and assigned the number. Dial pad visible after a Teams restart.' },
  { category: 'users', sub: 'licence', impact: 'individual', urgency: 'cannot_call', title: (u) => `Teams Phone licence missing for ${u.name}`, description: (u) => `${u.name}'s phone features disappeared. IT think the licence was removed.`, notes: ['Licence group membership removed during a leaver clean-up that matched the wrong account.'], fix: 'Customer IT re-added the Teams Phone licence group. Calling restored.' },
  { category: 'users', sub: 'voicemail', impact: 'individual', urgency: 'feature_broken', title: (u) => `Voicemail not delivered to email for ${u.name}`, description: (u) => `${u.name} sees voicemails in Teams but nothing arrives by email.`, notes: ['Transcription and email delivery were off in the voicemail policy.'], fix: 'Turned on email delivery in the voicemail policy.' },
  { category: 'users', sub: 'forwarding', impact: 'individual', urgency: 'feature_broken', title: (u) => `Call forwarding to mobile not working for ${u.name}`, description: (u) => `${u.name} set forwarding to a mobile number but callers still ring the desk.`, notes: ['Forwarding to external numbers blocked by the calling policy.'], fix: 'Allowed forwarding to external numbers in the calling policy.' },
  { category: 'queues_aa', sub: 'queue_not_ringing', impact: 'team', urgency: 'degraded', title: () => 'Support queue not ringing all agents', description: () => 'Calls to the Support queue go to voicemail even though agents are signed in.', notes: ['Two of the five agents have Enterprise Voice off.', 'Checked the opt-in setting: agents had opted out of the queue.'], fix: 'Enabled Enterprise Voice for the agents and reset their queue opt-in. All agents ring.' },
  { category: 'queues_aa', sub: 'hours_holiday', impact: 'team', urgency: 'feature_broken', title: () => 'Auto attendant played the out-of-hours message in the day', description: () => 'Callers at 10am heard the closed greeting.', notes: ['Opening hours were set in the wrong time zone after a copy of the attendant.'], fix: 'Corrected the time zone on the auto attendant schedule.' },
  { category: 'devices', sub: 'desk_phone', impact: 'individual', urgency: 'feature_broken', title: (u) => `Desk phone will not provision for ${u.name}`, description: (u) => `${u.name}'s new desk phone stays on the manufacturer logo and never reaches the sign-in screen.`, notes: ['Phone has firmware from 2022. Vendor ticket raised.'], fix: 'Vendor supplied updated firmware; the phone provisions and signs in.' },
  { category: 'devices', sub: 'headset', impact: 'individual', urgency: 'degraded', title: (u) => `Headset not detected in Teams for ${u.name}`, description: (u) => `${u.name}'s headset works in other apps but Teams does not list it.`, notes: ['Teams was using a stale device list after an update.'], fix: 'Cleared the Teams cache and re-selected the headset.' },
  { category: 'voicemail_recording', sub: 'vm_greeting', impact: 'individual', urgency: 'feature_broken', title: (u) => `Voicemail greeting not playing for ${u.name}`, description: (u) => `Callers hear the default message instead of ${u.name}'s recorded greeting.`, notes: ['Greeting file was recorded but not saved after the change of language.'], fix: 'Re-recorded the greeting and checked that it plays.' },
  { category: 'emergency', sub: 'wrong_location', impact: 'site', urgency: 'degraded', title: () => 'Emergency location shows the wrong floor', description: () => 'A test emergency call shows the second floor; the phones are on the fourth.', notes: ['Subnet to location mapping missing for the new fourth floor VLAN.'], fix: 'Added the subnet to the emergency location map and validated a test call.' },
  { category: 'other', sub: null, impact: 'individual', urgency: 'question', title: (u) => `Question about calling permissions for ${u.name}`, description: (u) => `Can ${u.name} be allowed to call premium rate numbers for a campaign?`, notes: ['Explained the current policy and the option for a restricted exception.'], fix: 'Advised on the calling policy options. Customer will raise a service request if they want a change.' },
];

const FALLBACK_PEOPLE: Person[] = [
  { upn: 'sam.carter@example.com', name: 'Sam Carter' },
  { upn: 'priya.shah@example.com', name: 'Priya Shah' },
  { upn: 'tom.reid@example.com', name: 'Tom Reid' },
  { upn: 'maria.lopez@example.com', name: 'Maria Lopez' },
  { upn: 'dan.morgan@example.com', name: 'Dan Morgan' },
  { upn: 'aisha.khan@example.com', name: 'Aisha Khan' },
];

type Archetype = 'closed' | 'resolved' | 'restored' | 'in_progress' | 'new' | 'on_hold' | 'cancelled' | 'duplicate' | 'reopened';

interface IncEvent {
  at: Date;
  kind: string;
  from?: string | null;
  to?: string | null;
  body?: string | null;
  internal?: boolean;
  author: string | null;
  meta?: Record<string, unknown>;
}

@Injectable()
export class IncidentDemoDataService {
  constructor(
    @InjectDb() private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** How much demo data this customer has (so the screen knows whether to offer "Add" or "Remove"). */
  async status(t: TenantContext) {
    const s = tenantDb(this.db, t.schema);
    const demo = sql<boolean>`details @> '{"demo": true}'::jsonb`;
    const [inc, req, prob] = await Promise.all([
      s.selectFrom('incidents').select((eb) => eb.fn.countAll<string>().as('n')).where(demo).executeTakeFirst(),
      s.selectFrom('service_requests').select((eb) => eb.fn.countAll<string>().as('n')).where(demo).executeTakeFirst(),
      s.selectFrom('problems').select((eb) => eb.fn.countAll<string>().as('n')).where('description', 'like', `${DEMO_PROBLEM_MARK}%`).executeTakeFirst(),
    ]);
    return { incidents: Number(inc?.n ?? 0), requests: Number(req?.n ?? 0), problems: Number(prob?.n ?? 0) };
  }

  async seed(t: TenantContext, user: AuthedUser, opts: { days?: number; now?: Date } = {}) {
    if (!t.managedServices) throw new BadRequestException('Managed Services is not switched on for this customer.');
    const existing = await this.status(t);
    if (existing.incidents + existing.requests > 0) throw new ConflictException('This customer already has demo data. Remove it first to start again.');
    const now = opts.now ?? new Date();
    const days = Math.min(120, Math.max(14, opts.days ?? 56));
    const rnd = mulberry32(hashSeed(t.id));
    const s = tenantDb(this.db, t.schema);
    const p = platformDb(this.db);

    // The customer's own team, sites and tenant users.
    const members = await p
      .selectFrom('tenant_memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id as id', 'u.display_name as name', 'u.role as role'])
      .where('m.tenant_id', '=', t.id)
      .where('u.status', '=', 'active')
      .where('u.role', 'in', ['ENGINEER', 'PROJECT_MANAGER'])
      .execute();
    const team: Staff[] = [{ id: user.id, name: user.displayName }, ...members.filter((m) => m.id !== user.id).map((m) => ({ id: m.id, name: m.name }))];
    const engineers: Staff[] = [{ id: user.id, name: user.displayName }, ...members.filter((m) => m.role === 'ENGINEER' && m.id !== user.id).map((m) => ({ id: m.id, name: m.name }))];
    const found = await s
      .selectFrom('tenant_users')
      .select(['upn', 'display_name'])
      .where('removed_at', 'is', null)
      .where('display_name', 'is not', null)
      .where((eb) => eb.or([eb('account_enabled', 'is', null), eb('account_enabled', '=', true)]))
      .orderBy('upn')
      .limit(500)
      .execute();
    const people: Person[] = found.length >= 6 ? found.map((f) => ({ upn: f.upn, name: f.display_name as string })) : FALLBACK_PEOPLE;
    const opsSites = await s.selectFrom('discovery_sites').select(['id', 'sitecode']).where('mode', '=', 'operations').orderBy('sitecode').execute();
    const sites = opsSites.length ? opsSites : await s.selectFrom('discovery_sites').select(['id', 'sitecode']).orderBy('sitecode').limit(3).execute();
    const settings = ((await p.selectFrom('tenants').select('inc_settings').where('id', '=', t.id).executeTakeFirst())?.inc_settings ?? null) as IncSettings | null;
    const targets = incEffectiveTargets(settings);
    const matrix = incEffectiveMatrix(settings);
    const srTargets = srEffectiveTargets(null);

    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const between = (a: number, b: number) => a + rnd() * (b - a);
    /** A working-hours moment `ago` days back (never a weekend), before `now`. */
    const workMoment = (ago: number) => {
      const d = new Date(now.getTime() - ago * DAY);
      d.setUTCHours(8 + Math.floor(rnd() * 9), Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0);
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setTime(d.getTime() - DAY);
      return d.getTime() > now.getTime() - 5 * MIN ? new Date(now.getTime() - between(20, 180) * MIN) : d;
    };
    const cap = (d: Date, floorMs = 5 * MIN) => (d.getTime() > now.getTime() - floorMs ? new Date(now.getTime() - floorMs) : d);
    const at = (d: Date, plusMs: number) => new Date(d.getTime() + plusMs);
    // A later step is capped to stay clear of "now" too, but never lands before the step it follows (the margins differ).
    const capAfter = (d: Date, after: Date, floorMs?: number) => {
      const c = cap(d, floorMs);
      return c.getTime() < after.getTime() ? after : c;
    };

    const autoAnswers = (categoryKey: string, u: Person, started: Date) => {
      const def = INC_CATEGORY_BY_KEY[categoryKey]!;
      const out: Record<string, unknown> = {};
      for (const q of def.questions) {
        if (!q.required && rnd() < 0.4) continue;
        if (q.kind === 'boolean') out[q.key] = rnd() < 0.5;
        else if (q.kind === 'select') out[q.key] = pick(q.options ?? ['Yes']);
        else if (q.kind === 'choices') out[q.key] = [pick(q.options ?? ['Other'])];
        else if (q.key === 'started') out[q.key] = started.toUTCString().replace(' GMT', ' UTC');
        else if (q.key === 'affected_user') out[q.key] = u.name;
        else if (q.kind === 'text' || q.kind === 'textarea') out[q.key] = 'See the description';
      }
      return out;
    };

    const created = { incidents: 0, requests: 0, problems: 0, knowledge: 0, majors: 0 };
    const demoIds: string[] = [];
    const closedByCategory = new Map<string, string>();

    await this.db.transaction().execute(async (trx) => {
      const x = tenantDb(trx, t.schema);

      /* ------------------------- problems (linked below) ------------------------- */
      const mkProblem = async (title: string, status: string, category: string, rootCause: string, workaround: string, customerNote: string, ago: number, resolved: boolean) => {
        const id = randomUUID();
        const when = new Date(now.getTime() - ago * DAY);
        await x
          .insertInto('problems')
          .values({
            id,
            title,
            description: `${DEMO_PROBLEM_MARK}${title}`,
            category,
            status,
            root_cause: rootCause,
            workaround,
            customer_note: customerNote,
            owner_id: pick(engineers).id,
            created_by: user.id,
            created_at: when.toISOString(),
            updated_at: new Date(now.getTime() - ago * DAY * 0.4).toISOString(),
            resolved_at: resolved ? new Date(now.getTime() - ago * DAY * 0.3).toISOString() : null,
          } as never)
          .execute();
        created.problems++;
        return id;
      };
      const wifiProblem = await mkProblem('Wifi handsets lose media when roaming', 'known_error', 'call_quality', 'The access points hand over between bands without keeping the Teams media QoS marking.', 'Pin handsets to the 5GHz network, or use a wired phone until the access points are updated.', 'We know about one-way and choppy audio on wifi handsets. Until the fix is applied, use a wired phone or the 5GHz network.', 40, false);
      const trunkProblem = await mkProblem('Carrier trunk flaps overnight', 'investigating', 'direct_routing', '', '', '', 20, false);
      const vmProblem = await mkProblem('Voicemail greeting lost after language change', 'resolved', 'voicemail_recording', 'Changing the voicemail language resets the greeting; the recorder does not warn.', 'Re-record the greeting after changing the language.', '', 35, true);

      /* ------------------------------ one incident ------------------------------ */
      interface Spec {
        tpl: IncTemplate;
        person: Person;
        site: { id: string; sitecode: string } | null;
        archetype: Archetype;
        created: Date;
        problemId?: string | null;
        parentId?: string | null;
        duplicateOf?: string | null;
        major?: 'live' | 'past' | null;
        override?: IncPriority;
        forceMiss?: boolean;
      }

      const addIncident = async (spec: Spec) => {
        const { tpl, person, site, archetype } = spec;
        const calc = incPriority(tpl.impact, tpl.urgency, tpl.category, matrix).priority;
        const priority: IncPriority = spec.override ?? calc;
        const tg = targets[priority];
        const reporter = pick(team);
        const assignee = pick(engineers);
        const miss = spec.forceMiss ?? rnd() < 0.18;
        const frac = (lo: number, hi: number) => (miss ? between(1.15, 2.6) : between(lo, hi));
        const created0 = spec.created;
        const evs: IncEvent[] = [{ at: created0, kind: 'created', to: 'new', author: reporter.id }];
        let status: IncStatus = 'new';
        let hold: IncHoldReason | null = null;
        let ackAt: Date | null = null;
        let restoredAt: Date | null = null;
        let resolvedAt: Date | null = null;
        let closedAt: Date | null = null;
        let cancelledAt: Date | null = null;
        let reopenedAt: Date | null = null;
        let pauseState: { paused_since: string | null; paused_seconds: number; pause_log: { from: string; to: string }[] } = { paused_since: null, paused_seconds: 0, pause_log: [] };
        const move = (to: IncStatus, when: Date, kind: string, body: string | null, holdReason: IncHoldReason | null = null, extra: Record<string, unknown> = {}) => {
          const next = incPause({ ...pauseState, priority, status, hold_reason: hold }, { priority, status: to, hold_reason: holdReason }, when.toISOString());
          pauseState = next;
          evs.push({ at: when, kind: 'status_changed', from: status, to, body, author: assignee.id, meta: { kind, ...(holdReason ? { holdReason } : {}), ...extra } });
          status = to;
          hold = holdReason;
        };
        const note = (when: Date, body: string, internal = true) => evs.push({ at: when, kind: 'comment', body, internal, author: assignee.id });

        if (archetype !== 'new') {
          ackAt = cap(at(created0, Math.max(4, tg.responseMinutes * frac(0.08, 0.8)) * MIN));
          move('in_progress', ackAt, 'acknowledge', 'Looking into this now.');
          if (rnd() < 0.3) evs.push({ at: at(ackAt, 2 * MIN), kind: 'assigned', body: assignee.name, author: assignee.id, meta: { userId: assignee.id } });
        }

        // Time budgets.
        const restoreMs = (tg.restoreHours ?? tg.resolveHours * 0.5) * HOUR * frac(0.2, 0.85);
        const resolveMs = Math.max(restoreMs + 20 * MIN, tg.resolveHours * HOUR * frac(0.3, 0.9));

        if (archetype === 'in_progress' || archetype === 'new' || archetype === 'on_hold') {
          if (archetype === 'in_progress' && ackAt) note(cap(at(ackAt, between(10, 50) * MIN)), tpl.notes[0]!);
          if (archetype === 'on_hold' && ackAt) {
            note(cap(at(ackAt, 15 * MIN)), tpl.notes[0]!);
            const reason: IncHoldReason = pick(['customer', 'vendor', 'carrier'] as const);
            const when = cap(at(ackAt, between(30, 120) * MIN));
            move('on_hold', when, 'hold', reason === 'customer' ? 'Waiting for the customer to confirm the change window.' : reason === 'vendor' ? 'Waiting for the vendor to confirm the firmware fault.' : 'Waiting for the carrier to confirm the fault.', reason);
          }
        } else if (archetype === 'cancelled') {
          move('cancelled', cap(at(ackAt!, between(20, 90) * MIN)), 'cancel', 'Raised in error: the phone had been unplugged.');
          cancelledAt = evs[evs.length - 1]!.at;
        } else if (archetype === 'duplicate') {
          move('cancelled', cap(at(ackAt!, between(10, 40) * MIN)), 'duplicate', 'Same fault as the earlier incident.', null, { duplicateOf: spec.duplicateOf });
          status = 'duplicate';
          evs[evs.length - 1]!.to = 'duplicate';
          cancelledAt = evs[evs.length - 1]!.at;
        } else {
          // restored / resolved / closed / reopened all start with the same work.
          for (const [i, n] of tpl.notes.entries()) note(cap(at(ackAt!, (restoreMs * (i + 1)) / (tpl.notes.length + 1))), n);
          if (rnd() < 0.3) {
            const reason: IncHoldReason = pick(['customer', 'vendor', 'carrier', 'microsoft'] as const);
            const from = cap(at(ackAt!, restoreMs * 0.3));
            const heldFor = reason === 'customer' ? between(3, 22) * HOUR : between(1, 8) * HOUR;
            move('on_hold', from, 'hold', reason === 'customer' ? 'Waiting for the customer to test and confirm.' : `Waiting for the ${reason} to respond.`, reason);
            move('in_progress', cap(at(from, heldFor)), 'resume', 'Back with us, carrying on.');
          }
          if (rnd() < 0.7) note(cap(at(ackAt!, restoreMs * 0.5)), `Update to the customer: ${tpl.fix.split('.')[0]}.`, false);
          const last = evs[evs.length - 1]!.at;
          if (archetype === 'restored' || tg.restoreHours !== null || rnd() < 0.5) {
            restoredAt = cap(at(new Date(Math.max(last.getTime(), at(ackAt!, restoreMs).getTime())), 5 * MIN));
            move('restored', restoredAt, 'restore', tpl.fix);
          }
          if (archetype !== 'restored') {
            resolvedAt = cap(at(new Date(Math.max((restoredAt ?? last).getTime(), at(ackAt!, resolveMs).getTime())), 10 * MIN));
            move('resolved', resolvedAt, 'resolve', tpl.fix);
            if (archetype === 'closed') {
              closedAt = capAfter(at(resolvedAt, between(2, 70) * HOUR), resolvedAt, 30 * MIN);
              move('closed', closedAt, 'close', null);
            }
            if (archetype === 'reopened') {
              reopenedAt = capAfter(at(resolvedAt, between(3, 20) * HOUR), resolvedAt, 20 * MIN);
              move('in_progress', reopenedAt, 'reopen', 'The customer says it has come back.');
              pauseState = { paused_since: null, paused_seconds: 0, pause_log: [] };
              restoredAt = null;
              resolvedAt = capAfter(at(reopenedAt, between(1, 8) * HOUR), reopenedAt, 10 * MIN);
              move('resolved', resolvedAt, 'resolve', `${tpl.fix} Checked again with the customer.`);
              closedAt = capAfter(at(resolvedAt, between(5, 40) * HOUR), resolvedAt, 5 * MIN);
              move('closed', closedAt, 'close', null);
            }
          }
        }

        // A comment the customer would have seen on the closed ones.
        if (resolvedAt && rnd() < 0.8) evs.push({ at: at(resolvedAt, 3 * MIN), kind: 'comment', body: `We have fixed this: ${tpl.fix} Please let us know if anything is still wrong.`, internal: false, author: assignee.id });

        evs.sort((a, b) => a.at.getTime() - b.at.getTime());
        const answers = autoAnswers(tpl.category, person, created0);
        const id = randomUUID();
        const lastAt = evs[evs.length - 1]!.at;
        const major = spec.major ?? null;
        await x
          .insertInto('incidents')
          .values({
            id,
            title: tpl.title(person),
            description: tpl.description(person),
            category: tpl.category,
            subcategory: tpl.sub,
            site_id: site?.id ?? null,
            impact: tpl.impact,
            urgency: tpl.urgency,
            priority,
            priority_overridden: priority !== calc,
            status,
            hold_reason: hold,
            source: 'staff',
            details: JSON.stringify({ answers, example_calls: [], demo: true }),
            reporter_id: reporter.id,
            assigned_to: archetype === 'new' ? null : assignee.id,
            duplicate_of: archetype === 'duplicate' ? (spec.duplicateOf ?? null) : null,
            version: evs.length,
            created_at: created0.toISOString(),
            updated_at: lastAt.toISOString(),
            acknowledged_at: ackAt?.toISOString() ?? null,
            restored_at: restoredAt?.toISOString() ?? null,
            resolved_at: resolvedAt?.toISOString() ?? null,
            closed_at: closedAt?.toISOString() ?? null,
            cancelled_at: cancelledAt?.toISOString() ?? null,
            reopened_at: reopenedAt?.toISOString() ?? null,
            paused_since: pauseState.paused_since,
            paused_seconds: pauseState.paused_seconds,
            pause_log: JSON.stringify(pauseState.pause_log),
            problem_id: spec.problemId ?? null,
            parent_id: spec.parentId ?? null,
          } as never)
          .execute();
        await x
          .insertInto('incident_events')
          .values(
            evs.map((e) => ({
              incident_id: id,
              kind: e.kind,
              from_status: e.from ?? null,
              to_status: e.to ?? null,
              body: e.body ?? null,
              internal: e.internal ?? false,
              actor_type: 'user',
              author_id: e.author,
              meta: JSON.stringify(e.meta ?? {}),
              created_at: e.at.toISOString(),
            })) as never,
          )
          .execute();
        await x.insertInto('incident_items').values({ incident_id: id, kind: 'user', ref: person.upn, label: person.name, created_by: reporter.id } as never).execute();
        if (spec.problemId) await x.insertInto('incident_events').values({ incident_id: id, kind: 'problem_linked', body: null, author_id: assignee.id, meta: JSON.stringify({ problemId: spec.problemId }), created_at: at(ackAt ?? created0, 20 * MIN).toISOString() } as never).execute();
        created.incidents++;
        demoIds.push(id);
        if (archetype === 'closed') closedByCategory.set(`${tpl.category}|${tpl.sub}`, id);
        return { id, priority, evs, assignee, reporter, created: created0, ackAt, resolvedAt, closedAt, major, status: status as IncStatus, tpl, person, site };
      };

      const siteFor = () => (sites.length && rnd() < 0.8 ? pick(sites) : null);

      /* ------------------------ the everyday spread of incidents ------------------------ */
      const plan: { archetype: Archetype; n: number }[] = [
        { archetype: 'closed', n: 26 },
        { archetype: 'reopened', n: 2 },
        { archetype: 'resolved', n: 3 },
        { archetype: 'restored', n: 2 },
        { archetype: 'in_progress', n: 4 },
        { archetype: 'on_hold', n: 2 },
        { archetype: 'cancelled', n: 1 },
      ];
      const wifiTpls = TEMPLATES.filter((tp) => tp.category === 'call_quality' && (tp.sub === 'one_way_audio' || tp.sub === 'choppy_audio'));
      const trunkTpl = TEMPLATES.find((tp) => tp.sub === 'trunk_down')!;
      const everyday = TEMPLATES.filter((tp) => tp !== trunkTpl && tp.category !== 'emergency');
      const lessonTpls = ['one_way_audio', 'vm_greeting', 'desk_phone', 'no_dialpad'].map((sub) => TEMPLATES.find((tp) => tp.sub === sub)!);
      let wifiLinked = 0;
      let trunkLinked = 0;
      const results: Awaited<ReturnType<typeof addIncident>>[] = [];
      for (const step of plan) {
        for (let i = 0; i < step.n; i++) {
          const recent = step.archetype === 'closed' || step.archetype === 'reopened' ? between(3, days) : step.archetype === 'cancelled' ? between(5, 30) : between(0.1, 4);
          const link = step.archetype === 'closed' && wifiLinked < 4 && i % 5 === 1 ? 'wifi' : step.archetype === 'closed' && trunkLinked < 2 && i % 7 === 3 ? 'trunk' : null;
          // The first few closed ones are the fixes worth keeping as knowledge, so those four snippets always exist.
          const lesson = step.archetype === 'closed' && !link ? lessonTpls[[0, 2, 4, 5].indexOf(i)] : undefined;
          const tpl = link === 'wifi' ? pick(wifiTpls) : link === 'trunk' ? trunkTpl : (lesson ?? pick(everyday));
          const site = link === 'wifi' ? (sites[0] ?? null) : siteFor();
          if (link === 'wifi') wifiLinked++;
          if (link === 'trunk') trunkLinked++;
          results.push(
            await addIncident({ tpl, person: pick(people), site, archetype: step.archetype, created: workMoment(recent), problemId: link === 'wifi' ? wifiProblem : link === 'trunk' ? trunkProblem : tpl.sub === 'vm_greeting' && rnd() < 0.7 ? vmProblem : null, override: rnd() < 0.06 ? 'p2' : undefined }),
          );
        }
      }
      // A duplicate of an earlier closed one.
      const orig = [...closedByCategory.entries()][0];
      if (orig) await addIncident({ tpl: TEMPLATES.find((tp) => `${tp.category}|${tp.sub}` === orig[0])!, person: pick(people), site: siteFor(), archetype: 'duplicate', created: workMoment(between(1, 20)), duplicateOf: orig[1] });

      // Two that are on the clock right now: one still inside its response target, one past it.
      const fresh = TEMPLATES.find((tp) => tp.sub === 'queue_not_ringing')!;
      await addIncident({ tpl: fresh, person: pick(people), site: siteFor(), archetype: 'new', created: new Date(now.getTime() - targets[incPriority(fresh.impact, fresh.urgency, fresh.category, matrix).priority].responseMinutes * 0.35 * MIN) });
      const late = TEMPLATES.find((tp) => tp.sub === 'inbound_fail')!;
      await addIncident({ tpl: late, person: pick(people), site: siteFor(), archetype: 'new', created: new Date(now.getTime() - Math.max(3 * HOUR, targets[incPriority(late.impact, late.urgency, late.category, matrix).priority].responseMinutes * 3 * MIN)) });

      /* ---------------------------- major incidents ---------------------------- */
      const mkMajor = async (tpl: IncTemplate, when: Date, kind: 'past' | 'live', notices: string[], outcome: string) => {
        const lead = pick(engineers);
        const comms = pick(team);
        const r = await addIncident({ tpl, person: pick(people), site: sites[0] ?? null, archetype: kind === 'past' ? 'closed' : 'in_progress', created: when, major: kind, forceMiss: false });
        const declared = new Date(r.created.getTime() + 12 * MIN);
        const interval = 30;
        let ended: Date | null = null;
        const ev: { at: Date; kind: string; body: string; meta: Record<string, unknown> }[] = [{ at: declared, kind: 'major_declared', body: notices[0]!, meta: { leadId: lead.id, commsId: comms.id, intervalMinutes: interval } }];
        notices.slice(1).forEach((body, i) => ev.push({ at: cap(at(declared, (i + 1) * interval * MIN)), kind: 'major_update', body, meta: {} }));
        if (kind === 'past') {
          ended = r.resolvedAt ? at(r.resolvedAt, -3 * MIN) : cap(at(declared, 3 * HOUR));
          ev.push({ at: ended, kind: 'major_ended', body: outcome, meta: {} });
        }
        await x
          .updateTable('incidents')
          .set({
            major: true,
            major_declared_at: declared.toISOString(),
            major_declared_by: lead.id,
            major_ended_at: ended?.toISOString() ?? null,
            lead_id: lead.id,
            comms_id: comms.id,
            update_interval_minutes: interval,
            next_update_due_at: kind === 'live' ? new Date(now.getTime() + 9 * MIN).toISOString() : null,
            assigned_to: lead.id,
          } as never)
          .where('id', '=', r.id)
          .execute();
        await x
          .insertInto('incident_events')
          .values(ev.map((e) => ({ incident_id: r.id, kind: e.kind, body: e.body, author_id: lead.id, actor_type: 'user', meta: JSON.stringify(e.meta), created_at: e.at.toISOString() })) as never)
          .execute();
        created.majors++;
        return { ...r, lead, comms, declared, ended };
      };
      const past1 = await mkMajor(trunkTpl, workMoment(between(18, 26)), 'past', ['We are aware that external calls at the site are failing. The carrier trunk is down and the carrier is working on it. Next update in 30 minutes.', 'The carrier has confirmed a fault in their core network and is rerouting traffic.', 'Calls are starting to recover as the carrier reroutes. We are testing.'], 'Calls are working again. The carrier has fixed the fault and we have confirmed inbound and outbound calls at the site.');
      await x
        .insertInto('incident_reviews')
        .values({
          incident_id: past1.id,
          status: 'shared',
          summary: 'External calls failed at the site for about three hours because the carrier trunk went down.',
          cause: 'A fault in the carrier core network. Our SBC detected it within two minutes; no change on our side contributed.',
          went_well: 'The SBC alert and the first customer notice went out inside fifteen minutes. Updates followed every thirty minutes.',
          went_badly: 'The customer had no backup route for urgent calls, and our runbook did not name the carrier escalation contact.',
          actions: JSON.stringify([{ text: 'Add the carrier escalation contact to the runbook', owner: past1.lead.name, due: new Date(now.getTime() + 7 * DAY).toISOString().slice(0, 10), serviceRequestId: null }, { text: 'Offer the customer a secondary carrier route', owner: past1.comms.name, due: new Date(now.getTime() + 21 * DAY).toISOString().slice(0, 10), serviceRequestId: null }]),
          created_by: past1.lead.id,
          created_at: at(past1.ended ?? now, 2 * HOUR).toISOString(),
          updated_by: past1.lead.id,
          updated_at: at(past1.ended ?? now, 5 * HOUR).toISOString(),
          shared_at: at(past1.ended ?? now, 5 * HOUR).toISOString(),
          shared_by: past1.lead.id,
        } as never)
        .execute();
      const msTpl: IncTemplate = { category: 'microsoft_service', sub: 'ms_outage', impact: 'company', urgency: 'degraded', title: () => 'Microsoft Teams calling degraded across the tenant', description: () => 'Calls fail to connect or take a long time to set up. Microsoft has posted a service health advisory.', notes: ['Matches the Microsoft 365 service health advisory TM-demo.', 'Nothing to do on the tenant; monitoring Microsoft updates.'], fix: 'Microsoft resolved the service issue and calls are connecting normally.' };
      await mkMajor(msTpl, workMoment(between(36, 44)), 'past', ['Microsoft is reporting a problem with Teams calling. Some calls fail to connect. We are monitoring and will update you.', 'Microsoft is still investigating. There is nothing you need to do.'], 'Microsoft has resolved the service issue. Calls connect normally.');
      const live = await mkMajor(TEMPLATES.find((tp) => tp.category === 'call_failure' && tp.sub === 'outbound_fail')!, new Date(now.getTime() - 55 * MIN), 'live', ['We are aware that nobody at the main site can make calls. Engineers are working on it. Next update in 30 minutes.', 'We have found the cause (the carrier trunk) and the carrier has been engaged.'], '');
      // Customers noticing the same thing, linked under the live major.
      for (let i = 0; i < 3; i++) {
        await addIncident({ tpl: TEMPLATES[1]!, person: pick(people), site: sites[0] ?? null, archetype: 'new', created: new Date(now.getTime() - between(15, 45) * MIN), parentId: live.id });
      }

      /* ------------------------------- knowledge ------------------------------- */
      const lessons = results.filter((r) => r.status === 'closed' || r.status === 'resolved');
      const learn = async (tplSub: string, tip?: string) => {
        const src = lessons.find((r) => r.tpl.sub === tplSub);
        if (!src) return;
        await x
          .insertInto('incident_knowledge')
          .values({ title: src.tpl.title(src.person).replace(src.person.name, 'a user'), category: src.tpl.category, subcategory: src.tpl.sub, symptoms: src.tpl.description(src.person).replace(src.person.name, 'The user'), fix: src.tpl.fix, customer_text: tip ?? '', source_incident_id: src.id, helpful: Math.floor(between(1, 7)), not_helpful: Math.floor(between(0, 2)), created_by: user.id } as never)
          .execute();
        created.knowledge++;
      };
      await learn('one_way_audio', TEMPLATES.find((tp) => tp.sub === 'one_way_audio')!.tip);
      await learn('vm_greeting');
      await learn('desk_phone');
      await learn('no_dialpad');

      /* ---------------------------- service requests ---------------------------- */
      const srPlan: { type: SrType; status: SrStatus; n: number }[] = [
        { type: 'new_user', status: 'deployed', n: 4 },
        { type: 'new_users', status: 'deployed', n: 2 },
        { type: 'change_user', status: 'deployed', n: 3 },
        { type: 'remove_user', status: 'deployed', n: 2 },
        { type: 'new_phone_numbers', status: 'deployed', n: 2 },
        { type: 'new_common_area_phone', status: 'deployed', n: 1 },
        { type: 'new_call_queue', status: 'deployed', n: 1 },
        { type: 'new_auto_attendant', status: 'deployed', n: 1 },
        { type: 'new_user', status: 'planned', n: 2 },
        { type: 'change_user', status: 'planned', n: 1 },
        { type: 'new_users', status: 'built', n: 1 },
        { type: 'new_call_queue', status: 'built', n: 1 },
        { type: 'new_user', status: 'new', n: 2 },
        { type: 'other', status: 'new', n: 2 },
        { type: 'remove_user', status: 'cancelled', n: 1 },
        { type: 'new_phone_numbers', status: 'declined', n: 1 },
      ];
      const srDetails = (type: SrType) => {
        const out: Record<string, unknown> = {};
        const chosen = (f: SrFieldSpec) => !f.showWhen || (Array.isArray(out[f.showWhen.key]) ? (out[f.showWhen.key] as string[]).includes(f.showWhen.equals) : out[f.showWhen.key] === f.showWhen.equals);
        for (const f of SR_TYPE_DEFS[type].fields) {
          if (!chosen(f)) continue;
          if (!f.required && rnd() < 0.5) continue;
          const who = pick(people);
          switch (f.kind) {
            case 'person': out[f.key] = who; break;
            case 'people': out[f.key] = Array.from({ length: type === 'new_users' ? 3 : 4 }, () => pick(people)); break;
            case 'select': out[f.key] = pick(f.options ?? ['Yes']); break;
            case 'choices': out[f.key] = [pick(f.options ?? ['Other'])]; break;
            case 'boolean': out[f.key] = rnd() < 0.7; break;
            case 'number': out[f.key] = Math.min(f.max ?? 50, Math.max(f.min ?? 1, Math.floor(between(2, 20)))); break;
            case 'date': out[f.key] = new Date(now.getTime() + between(3, 21) * DAY).toISOString().slice(0, 10); break;
            case 'text': out[f.key] = f.key === 'name' || f.key === 'display_name' ? pick(['Reception', 'Support', 'Warehouse', 'Accounts', 'Front desk']) : f.key === 'location' ? 'Ground floor' : 'Demo'; break;
            case 'textarea': out[f.key] = f.key === 'greeting' ? 'Thank you for calling. For sales press 1, for support press 2.' : 'Please see the title.'; break;
            case 'phone_number': out[f.key] = `+4415820${Math.floor(between(10000, 99999))}`; break;
            case 'target': out[f.key] = { kind: 'voicemail', label: 'Voicemail' }; break;
            default: break; // menus, ranges, device models, site objects stay empty
          }
        }
        return out;
      };
      const srTitle = (type: SrType, d: Record<string, unknown>) => {
        const person = (d.user as Person | undefined)?.name ?? ((d.people as Person[] | undefined)?.[0]?.name ?? 'new starter');
        switch (type) {
          case 'new_user': return `New starter - ${person}`;
          case 'new_users': return `${(d.people as Person[] | undefined)?.length ?? 3} new starters this month`;
          case 'change_user': return `Change for ${person}`;
          case 'remove_user': return `Leaver - ${person}`;
          case 'new_phone_numbers': return `${(d.quantity as number | undefined) ?? 10} more phone numbers`;
          case 'new_common_area_phone': return `Common area phone - ${(d.display_name as string | undefined) ?? 'Reception'}`;
          case 'new_call_queue': return `New call queue - ${(d.name as string | undefined) ?? 'Support'}`;
          case 'new_auto_attendant': return `New auto attendant - ${(d.name as string | undefined) ?? 'Main line'}`;
          default: return 'Question about the service';
        }
      };
      for (const step of srPlan) {
        for (let i = 0; i < step.n; i++) {
          const priority: SrPriority = rnd() < 0.7 ? 'normal' : rnd() < 0.6 ? 'high' : rnd() < 0.5 ? 'low' : 'urgent';
          const tg = srTargets[priority];
          const ago = step.status === 'deployed' ? between(4, days) : step.status === 'cancelled' || step.status === 'declined' ? between(8, 30) : step.status === 'new' ? between(0.2, 4.5) : between(1, 9);
          const createdAt = workMoment(ago);
          const requester = pick(team);
          const assignee = pick(engineers);
          const details = srDetails(step.type);
          const miss = rnd() < 0.25;
          const f = (lo: number, hi: number) => (miss ? between(1.2, 2.2) : between(lo, hi));
          const evs: { at: Date; kind: string; from?: string; to?: string; body?: string; internal?: boolean; author: string }[] = [{ at: createdAt, kind: 'created', to: 'new', author: requester.id }];
          let firstResponse: Date | null = null;
          let plannedAt: Date | null = null;
          let builtAt: Date | null = null;
          let deployedAt: Date | null = null;
          let declinedAt: Date | null = null;
          let cancelledAt: Date | null = null;
          let waitingSince: Date | null = null;
          let waitingSeconds = 0;
          let status: SrStatus = 'new';
          const step2 = (to: SrStatus, when: Date, body: string | null) => {
            evs.push({ at: when, kind: 'status_changed', from: status, to, body: body ?? undefined, author: assignee.id });
            status = to;
          };
          if (step.status !== 'new') {
            firstResponse = cap(at(createdAt, tg.responseHours * HOUR * f(0.1, 0.8)));
            evs.push({ at: firstResponse, kind: 'assigned', body: assignee.name, author: assignee.id });
            if (step.status === 'declined') {
              declinedAt = firstResponse;
              step2('declined', firstResponse, 'This is not something we can do under the current service. We have explained what to do instead.');
            } else if (step.status === 'cancelled') {
              cancelledAt = cap(at(firstResponse, between(2, 30) * HOUR));
              step2('cancelled', cancelledAt, 'Cancelled at the customer’s request: the person is staying.');
            } else {
              plannedAt = firstResponse;
              step2('planned', plannedAt, 'Planned. We will get this built and tested.');
              if (rnd() < 0.35) {
                waitingSince = cap(at(plannedAt, between(1, 6) * HOUR));
                const asked = waitingSince;
                evs.push({ at: asked, kind: 'comment', body: 'Could you confirm which floor the phone is on?', internal: false, author: assignee.id });
                evs.push({ at: asked, kind: 'waiting', body: 'Waiting for the customer.', author: assignee.id });
                if (step.status !== 'planned') {
                  const back = cap(at(asked, between(2, 20) * HOUR));
                  waitingSeconds = Math.round((back.getTime() - asked.getTime()) / 1000);
                  evs.push({ at: back, kind: 'comment', body: 'It is on the second floor, by the kitchen.', internal: false, author: requester.id });
                  evs.push({ at: back, kind: 'resumed', author: assignee.id });
                  waitingSince = null;
                }
              }
              if (step.status === 'built' || step.status === 'deployed') {
                builtAt = cap(at(waitingSince ? plannedAt : at(plannedAt, waitingSeconds * 1000), tg.resolveHours * HOUR * f(0.15, 0.5)));
                step2('built', builtAt, 'Designed, built and checked.');
              }
              if (step.status === 'deployed') {
                deployedAt = cap(at(builtAt!, Math.max(30, tg.resolveHours * 60 * f(0.1, 0.35)) * MIN));
                step2('deployed', deployedAt, 'Deployed and checked live. Everything matches the design.');
                evs.push({ at: at(deployedAt, 4 * MIN), kind: 'comment', body: 'All done. Please let us know if anything does not work as expected.', internal: false, author: assignee.id });
              }
              if (rnd() < 0.5) evs.push({ at: cap(at(plannedAt, 30 * MIN)), kind: 'comment', body: 'Checked the design against Discovery. Numbers are free and policies are set.', internal: true, author: assignee.id });
            }
          }
          evs.sort((a, b) => a.at.getTime() - b.at.getTime());
          const id = randomUUID();
          const last = evs[evs.length - 1]!.at;
          await x
            .insertInto('service_requests')
            .values({
              id,
              type: step.type,
              title: srTitle(step.type, details),
              site_id: SR_TYPE_DEFS[step.type].needsSite ? (siteFor()?.id ?? sites[0]?.id ?? null) : null,
              details: JSON.stringify({ ...details, demo: true }),
              priority,
              status,
              target_date: step.status === 'deployed' || rnd() < 0.5 ? new Date(createdAt.getTime() + between(5, 14) * DAY).toISOString().slice(0, 10) : null,
              requested_by: requester.id,
              assigned_to: step.status === 'new' && rnd() < 0.5 ? null : assignee.id,
              created_at: createdAt.toISOString(),
              updated_at: last.toISOString(),
              planned_at: plannedAt?.toISOString() ?? null,
              built_at: builtAt?.toISOString() ?? null,
              deployed_at: deployedAt?.toISOString() ?? null,
              cancelled_at: cancelledAt?.toISOString() ?? null,
              declined_at: declinedAt?.toISOString() ?? null,
              first_response_at: firstResponse?.toISOString() ?? null,
              waiting_since: waitingSince?.toISOString() ?? null,
              waiting_seconds: waitingSeconds,
            } as never)
            .execute();
          await x
            .insertInto('service_request_events')
            .values(evs.map((e) => ({ request_id: id, kind: e.kind, from_status: e.from ?? null, to_status: e.to ?? null, body: e.body ?? null, internal: e.internal ?? false, author_id: e.author, created_at: e.at.toISOString() })) as never)
            .execute();
          created.requests++;
        }
      }
    });

    await this.audit.tenant(t.schema, 'incident.demo_data_added', { actor: { id: user.id, email: user.email }, targetType: 'tenant', targetId: t.id, detail: created });
    return created;
  }

  /** Takes every demo row away again; real incidents and requests are untouched. */
  async remove(t: TenantContext, user: AuthedUser) {
    const demo = sql<boolean>`details @> '{"demo": true}'::jsonb`;
    const removed = await this.db.transaction().execute(async (trx) => {
      const x = tenantDb(trx, t.schema);
      const ids = (await x.selectFrom('incidents').select('id').where(demo).execute()).map((r) => r.id);
      if (ids.length) await x.deleteFrom('incident_knowledge').where('source_incident_id', 'in', ids).execute();
      const prob = await x.deleteFrom('problems').where('description', 'like', `${DEMO_PROBLEM_MARK}%`).returning('id').execute();
      // Children and duplicates point at other demo rows; clear those links first so the delete order cannot matter.
      if (ids.length) await x.updateTable('incidents').set({ parent_id: null, duplicate_of: null } as never).where('id', 'in', ids).execute();
      const inc = ids.length ? await x.deleteFrom('incidents').where('id', 'in', ids).returning('id').execute() : [];
      const req = await x.deleteFrom('service_requests').where(demo).returning('id').execute();
      return { incidents: inc.length, requests: req.length, problems: prob.length };
    });
    await this.audit.tenant(t.schema, 'incident.demo_data_removed', { actor: { id: user.id, email: user.email }, targetType: 'tenant', targetId: t.id, detail: removed });
    return removed;
  }
}
