import { describe, expect, it } from 'vitest';
import { discoverySiteOverviewSchema } from './dto';
import { SITE_CONTACT_ROLES, contactLabel, contactUserIds, siteContactTargets } from './site-contacts';

const uid = '11111111-1111-4111-8111-111111111111';

describe('site contact roles', () => {
  it('has the five roles in order', () => {
    expect(SITE_CONTACT_ROLES.map((r) => r.label)).toEqual([
      'Site contact(s)',
      'Provider PM',
      'Provider Engineer',
      'Provider Porting PM',
      'Provider Porting Engineer',
    ]);
  });
});

describe('overview contacts schema', () => {
  it('accepts picked users and typed people, several per role', () => {
    const r = discoverySiteOverviewSchema.safeParse({
      contacts: {
        siteContacts: [{ userId: uid }, { name: 'Jane Smith', email: 'jane@example.com' }, { email: 'ops@example.com' }],
        providerPm: [{ userId: uid }],
      },
    });
    expect(r.success).toBe(true);
  });
  it('rejects an empty person, a bad email and an unknown role', () => {
    expect(discoverySiteOverviewSchema.safeParse({ contacts: { siteContacts: [{}] } }).success).toBe(false);
    expect(discoverySiteOverviewSchema.safeParse({ contacts: { siteContacts: [{ name: 'A', email: 'not-an-email' }] } }).success).toBe(false);
    expect(discoverySiteOverviewSchema.safeParse({ contacts: { boss: [{ name: 'A' }] } }).success).toBe(false);
  });
  it('no longer takes the two fields the roles replace', () => {
    expect(discoverySiteOverviewSchema.safeParse({ primaryContactEmail: 'a@b.co' }).success).toBe(false);
    expect(discoverySiteOverviewSchema.safeParse({ assignedUserIds: [uid] }).success).toBe(false);
  });
});

describe('siteContactTargets', () => {
  it('splits picked users from typed people and ignores typed people with no email', () => {
    const t = siteContactTargets({
      contacts: { siteContacts: [{ userId: uid }, { userId: uid }, { name: 'Jane', email: 'jane@example.com' }, { name: 'No Email' }], providerPm: [{ email: 'pm@example.com' }] },
    });
    expect(t.userIds).toEqual([uid]);
    expect(t.typed).toEqual([{ email: 'jane@example.com', name: 'Jane' }]);
  });
  it('uses the old primary contact email until the overview is saved with roles', () => {
    expect(siteContactTargets({ primaryContactEmail: 'old@example.com' })).toEqual({ userIds: [], typed: [{ email: 'old@example.com', name: null }] });
    expect(siteContactTargets({ contacts: {}, primaryContactEmail: 'old@example.com' })).toEqual({ userIds: [], typed: [] });
    expect(siteContactTargets(undefined)).toEqual({ userIds: [], typed: [] });
  });
});

describe('contactLabel and contactUserIds', () => {
  it('names a picked user by their name and a typed person as typed', () => {
    expect(contactLabel({ userId: uid }, 'Ann Engineer')).toBe('Ann Engineer');
    expect(contactLabel({ userId: uid }, null)).toBe('Unknown user');
    expect(contactLabel({ name: 'Jane', email: 'j@x.co' })).toBe('Jane');
    expect(contactLabel({ email: 'j@x.co' })).toBe('j@x.co');
  });
  it('lists every picked user once', () => {
    expect(contactUserIds({ siteContacts: [{ userId: uid }], providerPm: [{ userId: uid }, { name: 'X' }] })).toEqual([uid]);
  });
});
