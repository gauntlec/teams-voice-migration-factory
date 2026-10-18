import { describe, expect, it } from 'vitest';
import { requestedRole, type RoleSource } from './roles';

const oidc = (over: Partial<RoleSource> = {}): RoleSource => ({ kind: 'oidc', default_role: 'CUSTOMER', role_claim: null, role_map: {}, ...over });
const hub: RoleSource = { kind: 'hub', default_role: 'CUSTOMER', role_claim: null, role_map: {} };

describe('the role a provider asks for', () => {
  it('uses the hub\'s vx_role, and the default when it is missing or not a role', () => {
    expect(requestedRole(hub, { vx_role: 'SUPER_ADMIN' })).toEqual({ role: 'SUPER_ADMIN', fromProvider: true });
    expect(requestedRole(hub, {})).toEqual({ role: 'CUSTOMER', fromProvider: false });
    expect(requestedRole(hub, { vx_role: 'ROOT' })).toEqual({ role: 'CUSTOMER', fromProvider: false });
    expect(requestedRole(hub, { vx_role: ['SUPER_ADMIN'] })).toEqual({ role: 'CUSTOMER', fromProvider: false });
  });

  it('ignores role claims on the hub provider\'s behalf for other providers, and the other way round', () => {
    expect(requestedRole(oidc({ role_claim: 'vx_role', role_map: {} }), { vx_role: 'SUPER_ADMIN' }).role).toBe('CUSTOMER');
    expect(requestedRole(oidc({ default_role: 'ENGINEER' }), { vx_role: 'SUPER_ADMIN' }).role).toBe('ENGINEER');
  });

  it('maps a claim through the role map, taking the most powerful match from a list', () => {
    const p = oidc({ role_claim: 'roles', role_map: { 'Voxshift Admins': 'SUPER_ADMIN', 'Voxshift Engineers': 'ENGINEER', 'Voxshift PMs': 'PROJECT_MANAGER' } });
    expect(requestedRole(p, { roles: ['Staff', 'Voxshift Engineers'] })).toEqual({ role: 'ENGINEER', fromProvider: true });
    expect(requestedRole(p, { roles: ['Voxshift Engineers', 'Voxshift Admins'] }).role).toBe('SUPER_ADMIN');
    expect(requestedRole(p, { roles: 'Voxshift PMs' }).role).toBe('PROJECT_MANAGER');
    expect(requestedRole(p, { roles: ['Staff'] })).toEqual({ role: 'CUSTOMER', fromProvider: false });
    expect(requestedRole(p, {})).toEqual({ role: 'CUSTOMER', fromProvider: false });
  });

  it('reads a nested claim by its dotted path, and does not take a value that is only an inherited property', () => {
    const p = oidc({ role_claim: 'realm_access.roles', role_map: { admin: 'SUPER_ADMIN' } });
    expect(requestedRole(p, { realm_access: { roles: ['admin'] } }).role).toBe('SUPER_ADMIN');
    expect(requestedRole(p, { realm_access: 'nope' }).role).toBe('CUSTOMER');
    expect(requestedRole(oidc({ role_claim: 'g', role_map: {} }), { g: ['constructor', 'toString'] }).role).toBe('CUSTOMER');
  });
});
