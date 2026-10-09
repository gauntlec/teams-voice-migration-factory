import { describe, expect, it } from 'vitest';
import { srChangePlan } from './service-request-change';

const id = '11111111-2222-3333-4444-555555555555';
const jo = { upn: 'Jo@Contoso.com', name: 'Jo' };

describe('srChangePlan', () => {
  it('maps a number and voicemail change, leaving forwarding as a to-do', () => {
    const r = srChangePlan('change_user', { user: jo, changes: ['Phone number', 'Voicemail', 'Call forwarding'], new_number: '+15550001', voicemail: 'Turn off', forward_to: { kind: 'voicemail', label: 'Voicemail' } });
    expect(r.ok && r.plan).toMatchObject({ kind: 'user', find: { upn: 'jo@contoso.com' }, apply: { newNumber: '+15550001', voicemail: false } });
    expect(r.ok && r.plan.todo.some((t) => t.includes('forwarding to Voicemail'))).toBe(true);
  });
  it('ignores answers for things that were not ticked', () => {
    const r = srChangePlan('change_user', { user: jo, changes: ['Voicemail'], voicemail: 'Turn on', new_number: '+15550001' });
    expect(r.ok && r.plan.apply).toEqual({ voicemail: true });
  });
  it('revokes a leaver', () => {
    const r = srChangePlan('remove_user', { user: jo, number_after: 'Keep it for a replacement' });
    expect(r.ok && r.plan.apply).toEqual({ revoke: true });
    expect(r.ok && r.plan.todo[0]).toContain('replacement');
  });
  it('maps queue agents and routing', () => {
    const r = srChangePlan('change_call_queue', { queue: { id, label: 'Sales' }, changes: ['Add people', 'How calls are shared out'], add_agents: [jo], routing: 'In order' });
    expect(r.ok && r.plan.apply).toEqual({ addAgents: ['jo@contoso.com'], routing: 'Serial' });
  });
  it('builds a holiday closure with an exclusive end', () => {
    const r = srChangePlan('change_auto_attendant', { auto_attendant: { id, label: 'Main' }, changes: ['Holiday closure'], holiday_name: 'Xmas', holiday_from: '2026-12-25', holiday_to: '2026-12-25' });
    const h = r.ok ? r.plan.apply.holiday : undefined;
    expect(h?.schedule.fixed?.ranges[0]).toEqual({ start: '2026-12-25T00:00:00', end: '2026-12-26T00:00:00' });
    expect(h?.callFlow.menu.options).toEqual([{ dtmf: 'Automatic', action: 'DisconnectCall' }]);
  });
  it('refuses non-change types', () => {
    expect(srChangePlan('new_user', {}).ok).toBe(false);
  });
});
