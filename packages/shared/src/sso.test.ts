import { describe, expect, it } from 'vitest';
import { can } from './rbac';
import { ROLES } from './rbac';
import {
  OIDC_CALLBACK_PATH,
  capRole,
  createSsoProviderSchema,
  hubGateHost,
  instanceIdFromHubToken,
  linkIdentitySchema,
  safeReturnTo,
  updateSsoProviderSchema,
} from './sso';

describe('role ceiling', () => {
  it('gives the lower of the requested role and the ceiling', () => {
    expect(capRole('SUPER_ADMIN', 'ENGINEER')).toBe('ENGINEER');
    expect(capRole('SUPER_ADMIN', 'PROJECT_MANAGER')).toBe('PROJECT_MANAGER');
    expect(capRole('ENGINEER', 'SUPER_ADMIN')).toBe('ENGINEER');
    expect(capRole('CUSTOMER', 'SUPER_ADMIN')).toBe('CUSTOMER');
    expect(capRole('PROJECT_MANAGER', 'ENGINEER')).toBe('ENGINEER');
    expect(capRole('ENGINEER', 'CUSTOMER')).toBe('CUSTOMER');
  });

  it('never hands out more than the ceiling, for every pair', () => {
    for (const requested of ROLES) {
      for (const ceiling of ROLES) {
        const got = capRole(requested, ceiling);
        expect([requested, ceiling]).toContain(got);
        expect(capRole(got, ceiling)).toBe(got);
      }
    }
  });

  it('only a Super Admin can manage single sign-on', () => {
    expect(can('SUPER_ADMIN', 'sso:manage')).toBe(true);
    for (const r of ROLES.filter((x) => x !== 'SUPER_ADMIN')) expect(can(r, 'sso:manage')).toBe(false);
  });
});

describe('return path', () => {
  it('keeps a path inside the application', () => {
    expect(safeReturnTo('/incidents/123?tab=notes')).toBe('/incidents/123?tab=notes');
    expect(safeReturnTo('/')).toBe('/');
  });

  it('replaces everything that could leave the application', () => {
    for (const bad of ['https://evil.example.com', '//evil.example.com', '/\\evil.example.com', 'javascript:alert(1)', 'evil', '', '/a\r\nSet-Cookie: x=1', '/api/auth/me', undefined, 42, '/' + 'a'.repeat(600)]) {
      expect(safeReturnTo(bad), String(bad)).toBe('/');
    }
  });
});

describe('the hub gate address', () => {
  it('recognises <slug>.<hub domain> only', () => {
    expect(hubGateHost('contoso.hub.voxshift.io', 'https://hub.voxshift.io')).toBe('contoso.hub.voxshift.io');
    expect(hubGateHost('Contoso.Hub.Voxshift.io:443', 'https://hub.voxshift.io')).toBe('contoso.hub.voxshift.io');
    for (const host of ['hub.voxshift.io', 'a.b.hub.voxshift.io', 'evilhub.voxshift.io', 'contoso.hub.voxshift.io.evil.example', 'www.voxshift.io', '-x.hub.voxshift.io', undefined]) {
      expect(hubGateHost(host, 'https://hub.voxshift.io'), String(host)).toBeNull();
    }
    expect(hubGateHost('contoso.hub.voxshift.io', null)).toBeNull();
  });

  it('reads the instance id out of an instance token', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(instanceIdFromHubToken(`vxh_${id}_${'a'.repeat(48)}`)).toBe(id);
    expect(instanceIdFromHubToken('nonsense')).toBeNull();
  });

  it('uses the one callback path the contract names', () => {
    expect(OIDC_CALLBACK_PATH).toBe('/api/auth/oidc/callback');
  });
});

describe('provider input', () => {
  const base = { name: 'Contoso Entra', issuer: 'https://login.microsoftonline.com/tenant/v2.0', clientId: 'abc', clientSecret: 's3cret' };

  it('accepts a minimal provider and refuses an insecure or malformed one', () => {
    expect(createSsoProviderSchema.safeParse(base).success).toBe(true);
    expect(createSsoProviderSchema.safeParse({ ...base, issuer: 'http://login.example.com' }).success).toBe(false);
    expect(createSsoProviderSchema.safeParse({ ...base, issuer: 'http://127.0.0.1:9999' }).success).toBe(true);
    expect(createSsoProviderSchema.safeParse({ ...base, scopes: 'email profile' }).success).toBe(false);
    expect(createSsoProviderSchema.safeParse({ ...base, roleCeiling: 'GOD' }).success).toBe(false);
    expect(createSsoProviderSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it('normalises the email domain allow-list', () => {
    const r = updateSsoProviderSchema.parse({ emailDomains: ['Contoso.com', 'contoso.com', 'fabrikam.co.uk'] });
    expect(r.emailDomains).toEqual(['contoso.com', 'fabrikam.co.uk']);
    expect(updateSsoProviderSchema.safeParse({ emailDomains: ['not a domain'] }).success).toBe(false);
  });

  it('links by a waiting sign-in or by a subject, not both', () => {
    expect(linkIdentitySchema.safeParse({ requestId: '0f8fad5b-d9cb-469f-a165-70867728950e' }).success).toBe(true);
    expect(linkIdentitySchema.safeParse({ providerId: '0f8fad5b-d9cb-469f-a165-70867728950e', subject: 'abc' }).success).toBe(true);
    expect(linkIdentitySchema.safeParse({ subject: 'abc' }).success).toBe(false);
  });
});
