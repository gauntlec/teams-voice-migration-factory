import { describe, expect, it } from 'vitest';
import { isTeamsWebhookUrl, mspNotifyBackoffSeconds, mspNotifyEnabled, mspTeamsSchema, teamsPayload } from './msp-notify';

describe('webhook addresses', () => {
  it('accepts the places a Teams webhook lives', () => {
    for (const u of ['https://contoso.webhook.office.com/webhookb2/abc', 'https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x', 'https://abc.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/x', 'https://outlook.office.com/webhook/abc'])
      expect(isTeamsWebhookUrl(u), u).toBe(true);
  });
  it('refuses anything else: other hosts, plain http, internal addresses, credentials, lookalikes, junk', () => {
    for (const u of ['http://contoso.webhook.office.com/x', 'https://evil.example/webhook.office.com', 'https://webhook.office.com.evil.example/x', 'https://localhost/x', 'https://192.168.1.10/x', 'https://user:pw@contoso.webhook.office.com/x', 'https://contoso.webhook.office.com:8443/x', 'https://logic.azure.com/x', 'not a url', ''])
      expect(isTeamsWebhookUrl(u), u).toBe(false);
  });
});

describe('cards', () => {
  it('builds an adaptive card in the shape Workflows takes, and keeps it short', () => {
    const p = teamsPayload({ title: 'P1: SBC down', body: 'x'.repeat(5000), facts: [{ title: 'Customer', value: 'Contoso' }], link: { label: 'Open INC-0042', url: 'https://app/incidents/1' }, tone: 'attention' });
    expect(p.type).toBe('message');
    const card = p.attachments[0]!.content as { body: { text?: string; color?: string; type: string }[]; actions: { url: string }[] };
    expect(p.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.body[0]).toMatchObject({ text: 'P1: SBC down', color: 'attention' });
    expect(card.body[1]!.text).toHaveLength(1500);
    expect(card.body[2]!.type).toBe('FactSet');
    expect(card.actions[0]!.url).toBe('https://app/incidents/1');
  });
});

describe('settings', () => {
  it('reads what to tell the channel about, with everything on by default, and tests always go through', () => {
    expect(mspNotifyEnabled(null, 'incident')).toBe(true);
    expect(mspNotifyEnabled({ incidents: false }, 'incident')).toBe(false);
    expect(mspNotifyEnabled({ incidents: false }, 'major')).toBe(true);
    expect(mspNotifyEnabled({ sla: false }, 'sla')).toBe(false);
    expect(mspNotifyEnabled({ sla: false, major: false, incidents: false }, 'test')).toBe(true);
  });
  it('validates input and backs off', () => {
    expect(mspTeamsSchema.safeParse({ webhookUrl: null }).success).toBe(true);
    expect(mspTeamsSchema.safeParse({ notify: { incidents: true, major: true } }).success).toBe(false);
    expect([1, 2, 3, 10].map(mspNotifyBackoffSeconds)).toEqual([30, 60, 120, 3600]);
  });
});
