import { describe, expect, it } from 'vitest';
import { convertAutoAttendantWizard } from './wizard-convert';
// Bug report "Auto Attendnat Wizard #3": the wizard's voicemail now names the Microsoft 365 group, or says it doesn't exist yet.
describe('voicemail to a Microsoft 365 group', () => {
  const GROUP = '11111111-2222-4333-8444-555555555555';
  const answers = (afterHoursFlow: import('./wizard').WizardCallFlow, businessFlow: import('./wizard').WizardCallFlow = { mode: 'disconnect' }) =>
    ({ languageId: 'en-GB', timeZoneId: 'GMT Standard Time', hoursType: 'standard', businessFlow, afterHoursFlow, holidaysEnabled: false }) as import('./wizard').AutoAttendantWizardAnswers;
  const target = (r: ReturnType<typeof convertAutoAttendantWizard>) => (r.value.after_hours_call_flow as { menu: { options: { target?: unknown }[] } }).menu.options[0]!.target;

  it('uses the group picked for "send every call to voicemail" and for a menu button', () => {
    const r = convertAutoAttendantWizard(answers({ mode: 'voicemail', target: { kind: 'voicemail', groupId: GROUP, label: 'Reception' } }), { siteId: 's', name: 'Main' });
    expect(target(r)).toEqual({ kind: 'shared_voicemail', groupId: GROUP });
    expect(r.warnings.filter((w) => /voicemail/i.test(w))).toEqual([]);

    const menu = convertAutoAttendantWizard(
      answers({ mode: 'voicemail', target: { kind: 'voicemail', groupId: GROUP } }, { mode: 'menu', options: [{ key: '1', label: 'Leave a message', target: { kind: 'voicemail', groupId: GROUP } }] }),
      { siteId: 's', name: 'Main' },
    );
    const option = (menu.value.default_call_flow as { menu: { options: { target?: unknown }[] } }).menu.options[0]!;
    expect(option.target).toEqual({ kind: 'shared_voicemail', groupId: GROUP });
  });

  it('notes a group that is still to be made, or only named, for the engineer to choose', () => {
    const fresh = convertAutoAttendantWizard(answers({ mode: 'voicemail', target: { kind: 'voicemail', label: 'Reception voicemail', newGroup: true } }), { siteId: 's', name: 'Main' });
    expect(target(fresh)).toEqual({ kind: 'shared_voicemail' });
    expect(fresh.warnings.join(' ')).toMatch(/new Microsoft 365 group "Reception voicemail" that doesn't exist yet/);

    const named = convertAutoAttendantWizard(answers({ mode: 'voicemail', target: { kind: 'voicemail', label: 'Reception' } }), { siteId: 's', name: 'Main' });
    expect(named.warnings.join(' ')).toMatch(/goes to voicemail \("Reception"\).*Choose the group in Design & Build/);
  });
});
