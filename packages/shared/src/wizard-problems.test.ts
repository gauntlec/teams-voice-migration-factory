import { describe, expect, it } from 'vitest';
import { autoAttendantWizardAnswersSchema, autoAttendantWizardProblem, cleanAutoAttendantWizardAnswers, wizardCallFlowProblem, type AutoAttendantWizardAnswers } from './wizard';

const base: AutoAttendantWizardAnswers = {
  languageId: 'en-GB',
  timeZoneId: 'GMT Standard Time',
  hoursType: 'standard',
  businessFlow: { mode: 'menu', options: [{ key: '1', label: 'Sales', target: { kind: 'team', label: 'Sales' } }] },
  afterHoursFlow: { mode: 'voicemail' },
  holidaysEnabled: false,
  holidays: [],
};

describe('the auto attendant wizard’s checks', () => {
  // bug report "Auto Attendant Wizard #2": a button left without a name came back as a raw validation message
  it('names a menu button left without a name, in words', () => {
    const flow = { mode: 'menu' as const, options: [{ key: '1', label: 'Sales', target: { kind: 'team' as const } }, { key: '2', label: ' ', target: { kind: 'person' as const } }] };
    expect(wizardCallFlowProblem(flow, 'Business hours')).toBe('Business hours: give button 2 a name, for example "Sales".');
    expect(wizardCallFlowProblem({ mode: 'menu', options: [] }, 'After hours')).toMatch(/add at least one menu option/);
    expect(wizardCallFlowProblem({ mode: 'menu', options: [], allowDialByName: true }, 'After hours')).toBeNull();
    expect(wizardCallFlowProblem({ mode: 'menu', options: [flow.options[0]!, { ...flow.options[0]!, label: 'Support' }] }, 'Business hours')).toMatch(/button 1 is used twice/);
    expect(wizardCallFlowProblem({ mode: 'direct' }, 'Business hours')).toMatch(/choose where every call goes/);
    expect(autoAttendantWizardProblem(base)).toBeNull();
  });

  // bug report "Auto Attendnat Wizard": holidays ticked, a row added, then unticked - the empty row failed with "holidays.0.name"
  it('drops holidays switched off, and asks for a name and dates when they are on', () => {
    const emptied = { ...base, holidays: [{ name: '', dateRange: { start: '', end: '' }, flow: { mode: 'voicemail' as const } }] };
    expect(autoAttendantWizardProblem(emptied)).toBeNull();
    expect(cleanAutoAttendantWizardAnswers(emptied)).not.toHaveProperty('holidays');
    // the server drops them too, for anything saved without cleaning
    const parsed = autoAttendantWizardAnswersSchema.safeParse(emptied);
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('holidays');

    const on = { ...emptied, holidaysEnabled: true };
    expect(autoAttendantWizardProblem(on)).toBe('Give holiday 1 a name, for example "Christmas Day".');
    expect(autoAttendantWizardProblem({ ...on, holidays: [{ ...on.holidays[0]!, name: 'Christmas Day' }] })).toBe('Christmas Day: choose the first and last day.');
    expect(autoAttendantWizardProblem({ ...on, holidays: [{ ...on.holidays[0]!, name: 'Christmas Day', dateRange: { start: '2026-12-26', end: '2026-12-25' } }] })).toMatch(/last day is before the first/);
    expect(autoAttendantWizardProblem({ ...on, holidays: [{ ...on.holidays[0]!, name: 'Christmas Day', dateRange: { start: '2026-12-25', end: '2026-12-25' } }] })).toBeNull();
    expect(autoAttendantWizardAnswersSchema.safeParse(on).success).toBe(false);
  });
});
