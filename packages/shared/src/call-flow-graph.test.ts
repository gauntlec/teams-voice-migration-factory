import { describe, expect, it } from 'vitest';
import { buildAutoAttendantFlowGraphFromDesign, buildAutoAttendantFlowGraphFromLive, formatWeeklyHours } from './call-flow-graph';

const none = { monday: [], tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [] };
const nineToFive = [{ start: '09:00', end: '17:00' }];

describe('formatWeeklyHours', () => {
  it('joins consecutive days with the same hours and leaves out closed days', () => {
    const lines = formatWeeklyHours({ ...none, monday: nineToFive, tuesday: nineToFive, wednesday: nineToFive, thursday: nineToFive, friday: nineToFive, saturday: [{ start: '10:00', end: '14:00' }], complement: true });
    expect(lines).toEqual(['Mon–Fri 09:00–17:00', 'Sat 10:00–14:00']);
  });
  it('shows a split day and a day on its own', () => {
    expect(formatWeeklyHours({ ...none, monday: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }], wednesday: nineToFive })).toEqual([
      'Mon 08:00–12:00, 13:00–17:00',
      'Wed 09:00–17:00',
    ]);
  });
  it('says so when there are no hours, and when the list is the closed hours', () => {
    expect(formatWeeklyHours(none)).toEqual(['No hours set']);
    expect(formatWeeklyHours({ ...none, sunday: nineToFive, complement: false })).toEqual(['Closed during:', 'Sun 09:00–17:00']);
  });
});

const menu = { options: [] };
const flow = { greetings: [], menu };

describe('Auto Attendant graph from Design & Build', () => {
  it('names the front door\'s resource account and number and shows the business hours', () => {
    const aa = {
      buildId: 'a1',
      name: 'Main line',
      operator: null,
      defaultCallFlow: flow,
      afterHoursCallFlow: null,
      holidayCallFlows: [],
      hasPhoneNumber: true,
      resourceAccounts: [{ name: 'aa-main', upn: 'aa-main@contoso.test', number: '+442070001000' }],
      schedule: { type: 'weekly' as const, weekly: { ...none, monday: nineToFive, tuesday: nineToFive, complement: true } },
      timeZone: 'GMT Standard Time',
    };
    const g = buildAutoAttendantFlowGraphFromDesign(aa, [aa], []);
    const root = g.nodes.find((n) => n.id === 'aa:a1')!;
    expect(root.badge).toBe('Front door');
    expect(root.details).toEqual(['Resource account: aa-main', 'Number: +442070001000']);
    const hours = g.nodes.find((n) => n.id === 'aa:a1:business_hours')!;
    expect(hours.details).toEqual(['Mon–Tue 09:00–17:00', 'Time zone: GMT Standard Time']);
  });

  it('draws nothing extra for an attendant with no resource account or schedule', () => {
    const aa = { buildId: 'a2', name: 'Menu', operator: null, defaultCallFlow: flow, afterHoursCallFlow: null, holidayCallFlows: [] };
    const g = buildAutoAttendantFlowGraphFromDesign(aa, [aa], []);
    expect(g.nodes.find((n) => n.id === 'aa:a2')!.details).toEqual([]);
    expect(g.nodes.find((n) => n.id === 'aa:a2:business_hours')!.details).toEqual([]);
  });
});

describe('Auto Attendant graph from the live tenant', () => {
  const t = (h: number, m = 0) => ({ Hours: h, Minutes: m });
  it('reads the resource account behind ApplicationInstances and the hours from the After hours schedule', () => {
    const data = {
      Identity: 'aa-1',
      TimeZoneId: 'GMT Standard Time',
      ApplicationInstances: ['11111111-1111-1111-1111-111111111111'],
      DefaultCallFlow: { Id: 'cf0', Greetings: [], Menu: { MenuOptions: [] } },
      CallFlows: [{ Id: 'cf1', Greetings: [], Menu: { MenuOptions: [] } }],
      CallHandlingAssociations: [{ Type: 0, ScheduleId: 'sch1', CallFlowId: 'cf1' }],
    };
    const schedule = {
      key: 'sch1',
      data: { WeeklyRecurrentSchedule: { ComplementEnabled: true, MondayHours: [{ Start: t(9), End: t(17) }], TuesdayHours: [{ Start: t(9), End: t(17) }] } },
    };
    const accounts = new Map([['11111111-1111-1111-1111-111111111111', { name: 'Main AA', upn: 'aa-main@contoso.test', number: 'tel:+442070001000' }]]);
    const g = buildAutoAttendantFlowGraphFromLive({ name: 'Main line', data }, [{ name: 'Main line', data }], [], [schedule], undefined, accounts);
    expect(g.nodes.find((n) => n.id === 'aa:aa-1')!.details).toEqual(['Resource account: Main AA', 'Number: +442070001000']);
    expect(g.nodes.find((n) => n.id === 'aa:aa-1:business_hours')!.details).toEqual(['Mon–Tue 09:00–17:00', 'Time zone: GMT Standard Time']);
  });
});
