/**
 * Managed Services: change and remove requests.
 *
 * A change or removal acts on something that already exists, so "Prefill"
 * on the Design tab doesn't create a row: it finds the existing Design &
 * Build row (or, for a user not yet in Design & Build, adds them to the
 * request's site), links it to the request, and applies the parts of the
 * request that map cleanly onto the row. Whatever needs an engineer's
 * judgement is listed as a to-do instead of being guessed.
 *
 *   change_user              -> user row: new number, voicemail on/off
 *   change_call_queue        -> queue row: agents added/removed, routing method
 *   change_auto_attendant    -> AA row: new greeting, a holiday closure
 *   remove_user              -> user row: Revoke Enterprise Voice (deploys
 *                               Remove-CsPhoneNumberAssignment -RemoveAll)
 *   remove_common_area_phone -> CAP row: the same
 *
 * Pure: the API looks up rows and numbers, then applies `apply` through the
 * normal Design & Build update path.
 */
import { CALL_QUEUE_ROUTING_METHODS } from './domain';
import { normalizeFixedRange, type AutoAttendantHolidayCallFlow } from './deployment';
import { SR_ROUTING_TO_BUILD } from './service-request-build';
import { NUMBER_RELEASE, type SrMenuOption, type SrPerson, type SrSiteObject, type SrTarget, type SrType } from './service-requests';

export const SR_CHANGE_TYPES: readonly SrType[] = ['change_user', 'change_call_queue', 'change_auto_attendant', 'remove_user', 'remove_common_area_phone'];

export function isSrChangeType(type: SrType): boolean {
  return SR_CHANGE_TYPES.includes(type);
}

export interface SrChangePlan {
  kind: 'user' | 'cap' | 'call_queue' | 'auto_attendant';
  /** Users by UPN (added to the site if not in Design & Build yet); everything else by the row picked on the form. */
  find: { upn: string; name: string } | { id: string };
  label: string;
  /** Applied to the row automatically. */
  apply: {
    /** E.164 - the API resolves it to the inventory number. */
    newNumber?: string;
    voicemail?: boolean;
    /** Remove the number and Teams calling when deployed. */
    revoke?: boolean;
    addAgents?: string[];
    removeAgents?: string[];
    routing?: (typeof CALL_QUEUE_ROUTING_METHODS)[number];
    greeting?: string;
    holiday?: AutoAttendantHolidayCallFlow;
  };
  /** For the engineer to finish by hand on the Design tab. */
  todo: string[];
}

const ticked = (details: Record<string, unknown>, option: string) => Array.isArray(details.changes) && details.changes.includes(option);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const upns = (v: unknown) => (Array.isArray(v) ? (v as SrPerson[]).map((p) => p.upn.toLowerCase()) : []);
const targetLabel = (v: unknown) => (v && typeof v === 'object' ? (v as SrTarget).label : '');

export function srChangePlan(type: SrType, details: Record<string, unknown>): { ok: true; plan: SrChangePlan } | { ok: false; error: string } {
  const notes = str(details.notes);
  const notesTodo = notes ? [`Read the customer's notes: ${notes}`] : [];

  switch (type) {
    case 'change_user':
    case 'remove_user': {
      const person = details.user as SrPerson | undefined;
      if (!person?.upn) return { ok: false, error: 'The request has no person.' };
      const plan: SrChangePlan = { kind: 'user', find: { upn: person.upn.toLowerCase(), name: person.name }, label: person.upn.toLowerCase(), apply: {}, todo: [] };
      if (type === 'remove_user') {
        plan.apply.revoke = true;
        plan.todo.push(
          str(details.number_after) === NUMBER_RELEASE
            ? 'Once it is deployed, clear the phone number on the row so the number goes back to the free pool.'
            : 'Keep the number on the row for now - the customer wants it kept for a replacement.',
        );
        if (str(details.leaving_date)) plan.todo.push(`Deploy on or after their last working day, ${str(details.leaving_date)}.`);
      } else {
        if (ticked(details, 'Phone number') && str(details.new_number)) plan.apply.newNumber = str(details.new_number);
        if (ticked(details, 'Voicemail') && str(details.voicemail)) plan.apply.voicemail = str(details.voicemail) === 'Turn on';
        if (ticked(details, 'Call forwarding')) {
          plan.todo.push(`Set call forwarding${targetLabel(details.forward_to) ? ` to ${targetLabel(details.forward_to)}` : ''} (Calling… on the user's row).`);
        }
        if (ticked(details, 'Calling permissions')) {
          plan.todo.push(`Grant the policies for: ${str(details.permissions) || 'the calling permissions asked for'}.`);
        }
        if (ticked(details, 'Something else')) plan.todo.push('Something else was asked for - see the request.');
        if (str(details.when)) plan.todo.push(`Wanted from ${str(details.when)}.`);
      }
      plan.todo.push(...notesTodo);
      return { ok: true, plan };
    }

    case 'remove_common_area_phone': {
      const phone = details.phone as SrSiteObject | undefined;
      if (!phone?.id) return { ok: false, error: 'The request has no common area phone.' };
      return {
        ok: true,
        plan: {
          kind: 'cap',
          find: { id: phone.id },
          label: phone.label,
          apply: { revoke: true },
          todo: [
            str(details.number_after) === NUMBER_RELEASE
              ? 'Once it is deployed, clear the phone number on the row so the number goes back to the free pool.'
              : 'Keep the number on the row for now - the customer wants it kept for a replacement.',
            ...notesTodo,
          ],
        },
      };
    }

    case 'change_call_queue': {
      const queue = details.queue as SrSiteObject | undefined;
      if (!queue?.id) return { ok: false, error: 'The request has no call queue.' };
      const plan: SrChangePlan = { kind: 'call_queue', find: { id: queue.id }, label: queue.label, apply: {}, todo: [] };
      if (ticked(details, 'Add people')) plan.apply.addAgents = upns(details.add_agents);
      if (ticked(details, 'Remove people')) plan.apply.removeAgents = upns(details.remove_agents);
      if (ticked(details, 'How calls are shared out')) {
        const routing = SR_ROUTING_TO_BUILD[str(details.routing)];
        if (routing) plan.apply.routing = routing;
      }
      if (ticked(details, 'When nobody answers')) {
        const after = str(details.unanswered_after);
        plan.todo.push(`Set the timeout${after ? ` to ${after}` : ''}${targetLabel(details.unanswered) ? `, then send calls to ${targetLabel(details.unanswered)}` : ''} (Configure… on the queue).`);
      }
      if (ticked(details, 'Something else')) plan.todo.push('Something else was asked for - see the request.');
      if (str(details.when)) plan.todo.push(`Wanted from ${str(details.when)}.`);
      plan.todo.push(...notesTodo);
      return { ok: true, plan };
    }

    case 'change_auto_attendant': {
      const aa = details.auto_attendant as SrSiteObject | undefined;
      if (!aa?.id) return { ok: false, error: 'The request has no auto attendant.' };
      const plan: SrChangePlan = { kind: 'auto_attendant', find: { id: aa.id }, label: aa.label, apply: {}, todo: [] };
      if (ticked(details, 'Greeting') && str(details.greeting)) plan.apply.greeting = str(details.greeting).slice(0, 1000);
      if (ticked(details, 'Holiday closure')) {
        const range = normalizeFixedRange({ start: str(details.holiday_from), end: str(details.holiday_to) });
        if (range) {
          const greeting = str(details.holiday_greeting);
          plan.apply.holiday = {
            name: (str(details.holiday_name) || 'Holiday').slice(0, 64),
            callFlow: {
              greetings: greeting ? [{ type: 'Text', text: greeting.slice(0, 1000) }] : [],
              // Play the greeting, then end the call - the usual "we're closed" holiday.
              menu: { options: [{ dtmf: 'Automatic', action: 'DisconnectCall' }] },
            },
            schedule: { type: 'fixed', fixed: { ranges: [range] } },
          };
          plan.todo.push('Check the holiday closure: by default callers hear the message and the call ends. Point it somewhere else if they should be put through.');
        } else {
          plan.todo.push('Add the holiday closure by hand - the dates could not be read.');
        }
      }
      if (ticked(details, 'Opening hours')) plan.todo.push(`Change the opening hours to: ${str(details.business_hours)} (Configure… on the auto attendant).`);
      if (ticked(details, 'Menu options')) {
        const menu = Array.isArray(details.menu) ? (details.menu as SrMenuOption[]).map((o) => `${o.key}: ${o.target.label}`).join('; ') : '';
        plan.todo.push(`Change the menu${menu ? ` to: ${menu}` : ''} (Configure… on the auto attendant).`);
      }
      if (ticked(details, 'Something else')) plan.todo.push('Something else was asked for - see the request.');
      plan.todo.push(...notesTodo);
      return { ok: true, plan };
    }

    default:
      return { ok: false, error: 'This is not a change or removal request.' };
  }
}
