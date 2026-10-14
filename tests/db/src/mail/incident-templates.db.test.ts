// The five incident emails render with the right subject, wording and links, for
// the customer side and for the team, and never put HTML from a customer's text
// into the page.
import { describe, expect, it } from 'vitest';
import type { IncidentActivityContext, IncidentCreatedContext, IncidentMajorContext, IncidentMessageContext, IncidentResolvedContext, IncidentReviewContext, IncidentStatusChangedContext } from '@tvmf/shared';
import { renderEmail } from '../../../../apps/worker/src/mail/templates';

const base = { customerName: 'Contoso', reference: 'INC-0042', title: 'No audio on inbound calls', runUrl: 'https://app.test/incidents/abc' };

describe('incident emails', () => {
  it('thank the reporter and tell the team about a new incident', () => {
    const c: IncidentCreatedContext = { ...base, audience: 'reporter', categoryLabel: 'Call quality', siteLabel: 'RDG01 — Reading', priorityLabel: 'high', raisedBy: 'Cara', respondText: 'We aim to respond within 1 hour.', lines: [] };
    const reporter = renderEmail('incident_created', c as never);
    expect(reporter.subject).toBe("We've got it: INC-0042 — No audio on inbound calls");
    expect(reporter.text).toContain('We\'re treating this as high priority. We aim to respond within 1 hour.');
    const team = renderEmail('incident_created', { ...c, audience: 'team', priorityLabel: 'P2 High', lines: [{ label: 'When did it start?', value: 'Today 09:00' }] } as never);
    expect(team.subject).toBe('New P2 High incident INC-0042 — Contoso');
    expect(team.text).toContain('When did it start?: Today 09:00');
    expect(team.text).toContain('Raised by: Cara');
  });

  it('describe each way an incident moves', () => {
    const subjects = (['acknowledge', 'hold', 'restore', 'close', 'auto_close', 'cancel', 'duplicate', 'reopen', 'priority'] as const).map((kind) => {
      const c: IncidentStatusChangedContext = { ...base, kind, holdLabel: 'Waiting on your carrier', note: 'A note', priorityText: 'high' };
      const r = renderEmail('incident_status_changed', c as never);
      expect(r.html).toContain(base.runUrl);
      return r.subject;
    });
    expect(new Set(subjects).size).toBeGreaterThanOrEqual(8);
    expect(subjects[1]).toContain('on hold');
    const hold = renderEmail('incident_status_changed', { ...base, kind: 'hold', holdLabel: 'Waiting on your carrier' } as never);
    expect(hold.text).toContain('waiting on your carrier');
    expect(renderEmail('incident_status_changed', { ...base, kind: 'priority', priorityText: 'critical' } as never).text).toContain('to critical');
  });

  it('send updates, questions and reminders to the customer', () => {
    const m = (kind: IncidentMessageContext['kind']) => renderEmail('incident_message', { ...base, kind, author: 'Eve Engineer', body: 'Which handsets?' } as never);
    expect(m('comment').subject).toBe('Update on INC-0042 — No audio on inbound calls');
    expect(m('question').subject).toContain('needs your reply');
    expect(m('question').text).toContain('Reply now');
    expect(m('reminder').subject).toBe('Reminder: INC-0042 is waiting for your reply');
  });

  it('ask "Is it fixed?" with both answers one click away', () => {
    const c: IncidentResolvedContext = { ...base, author: 'Eve Engineer', note: 'Replaced the certificate', fixedUrl: 'https://app.test/incident-response?t=T&a=fixed', brokenUrl: 'https://app.test/incident-response?t=T&a=broken', autoCloseDays: 5 };
    const r = renderEmail('incident_resolved', c as never);
    expect(r.subject).toBe('Is INC-0042 fixed? — No audio on inbound calls');
    expect(r.html).toContain('href="https://app.test/incident-response?t=T&amp;a=fixed"');
    expect(r.html).toContain('href="https://app.test/incident-response?t=T&amp;a=broken"');
    expect(r.text).toContain("Yes, it's fixed: https://app.test/incident-response?t=T&a=fixed");
    expect(r.text).toContain('No, it is still broken: https://app.test/incident-response?t=T&a=broken');
    expect(r.text).toContain('close the incident after 5 days');
    expect(r.text).toContain('What was done: Replaced the certificate');
  });

  it('tell the team what happened and why they are being told', () => {
    const kinds: IncidentActivityContext['kind'][] = ['comment', 'replied', 'internal_note', 'assigned', 'reopened', 'cancelled', 'confirmed', 'sla_warning', 'sla_breached', 'update_due', 'update_overdue', 'major_assigned'];
    const subjects = kinds.map((kind) => {
      const r = renderEmail('incident_activity', { ...base, categoryLabel: 'Call quality', priorityLabel: 'P1 Critical', kind, author: 'Cara', body: 'Still no audio' } as never);
      expect(r.text).toContain('P1 Critical · Call quality');
      return r.subject;
    });
    expect(new Set(subjects).size).toBe(kinds.length);
    expect(subjects.at(-1)).toBe('INC-0042: you are on a major incident');
    expect(subjects).toContain('INC-0042 has missed a target');
  });

  it("never lets a customer's text become HTML", () => {
    const r = renderEmail('incident_message', { ...base, kind: 'comment', author: '<b>Mallory</b>', body: '<script>alert(1)</script>' } as never);
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).not.toContain('<b>Mallory</b>');
  });
});

describe('major incident and review emails', () => {
  const major: IncidentMajorContext = { ...base, audience: 'customer', kind: 'declared', priorityLabel: 'critical', siteLabel: 'RDG01 — Reading', lead: 'Lee Lead', body: 'Calls at Reading are failing; we are checking the SBC.', nextUpdateText: "We'll update you again by 14:30 UTC.", customerName: 'Contoso' };

  it('tell the customer we know, then update them, then say it is over', () => {
    const declared = renderEmail('incident_major', major as never);
    expect(declared.subject).toBe("We're aware of a problem: INC-0042 — No audio on inbound calls");
    expect(declared.text).toContain('Site: RDG01 — Reading');
    expect(declared.text).toContain("We'll update you again by 14:30 UTC.");
    expect(declared.text).not.toContain('Priority:');
    const update = renderEmail('incident_major', { ...major, kind: 'update', body: 'Carrier engaged.' } as never);
    expect(update.subject).toBe('Update on INC-0042 — No audio on inbound calls');
    const done = renderEmail('incident_major', { ...major, kind: 'resolved', body: 'Trunk restored.', nextUpdateText: null } as never);
    expect(done.subject).toBe('Resolved: INC-0042 — No audio on inbound calls');
    expect(done.text).not.toContain("We'll update you again");
    expect(done.text).toContain('Trunk restored.');
  });

  it('tell the team who is leading, and say "all sites" for a customer-wide one', () => {
    const team = renderEmail('incident_major', { ...major, audience: 'team', siteLabel: null } as never);
    expect(team.subject).toBe('MAJOR INCIDENT INC-0042 — Contoso');
    expect(team.text).toContain('Lee Lead has declared this a major incident');
    expect(team.text).toContain('Affects: all sites');
    expect(team.text).toContain('Priority: critical');
  });

  it('summarise a shared review with its actions', () => {
    const c: IncidentReviewContext = { ...base, summary: 'Calls failed for 90 minutes.', cause: 'The certificate expired.', actions: [{ text: 'Renew 30 days early', owner: 'Ed', due: '2026-11-01' }, { text: 'Alert on expiry' }] };
    const r = renderEmail('incident_review', c as never);
    expect(r.subject).toBe('Review: INC-0042 — No audio on inbound calls');
    expect(r.text).toContain('What happened: Calls failed for 90 minutes.');
    expect(r.text).toContain('Why it happened: The certificate expired.');
    expect(r.text).toContain('• Renew 30 days early (Ed, by 2026-11-01)');
    expect(r.text).toContain('• Alert on expiry');
    expect(r.html).toContain(base.runUrl);
  });
});
