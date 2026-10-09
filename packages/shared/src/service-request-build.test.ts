import { describe, expect, it } from 'vitest';
import {
  buildAutoAttendantCreateSchema,
  buildCallQueueCreateSchema,
  buildCapCreateSchema,
  buildIdentityCreateSchema,
  discoverySiteSchema,
} from './dto';
import {
  SR_BUILD_KIND,
  SR_ROUTING_TO_BUILD,
  canDraftSrInBuild,
  fitText,
  serviceRequestBuildDraftSchema,
  srAgentEntries,
  srBuildHref,
  srToBuildDraft,
  suggestCapUpn,
  type SrBuildDraft,
} from './service-request-build';
import { SR_STATUSES, SR_TYPES, SR_TYPE_DEFS } from './service-requests';

const SITE = '11111111-2222-3333-4444-555555555555';
const CTX = { reference: 'SR-0042', siteId: SITE };

function draftOf(result: ReturnType<typeof srToBuildDraft>): SrBuildDraft {
  if (!result.ok) throw new Error(result.error);
  return result.draft;
}

/** The draft must be accepted by the same schema as adding the row by hand. */
function assertValid(d: SrBuildDraft) {
  const schema = {
    site: discoverySiteSchema,
    user: buildIdentityCreateSchema,
    cap: buildCapCreateSchema,
    call_queue: buildCallQueueCreateSchema,
    auto_attendant: buildAutoAttendantCreateSchema,
  }[d.kind];
  const r = schema.safeParse(d.input);
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
}

describe('which requests can be drafted', () => {
  it('maps every type, with nothing automatic for numbers and "other"', () => {
    expect(Object.keys(SR_BUILD_KIND).sort()).toEqual([...SR_TYPES].sort());
    expect(SR_BUILD_KIND.new_phone_numbers).toBeNull();
    expect(SR_BUILD_KIND.other).toBeNull();
  });

  it('only while New or Planned', () => {
    const allowed = SR_STATUSES.filter((s) => canDraftSrInBuild('new_user', s));
    expect(allowed).toEqual(['new', 'planned']);
    expect(canDraftSrInBuild('new_phone_numbers', 'new')).toBe(false);
    expect(canDraftSrInBuild('other', 'planned')).toBe(false);
  });

  it('refuses unsupported types with a reason', () => {
    const r = srToBuildDraft('other', { description: 'x' }, CTX);
    expect(r.ok).toBe(false);
  });
});

describe('new user -> build_users', () => {
  it('takes the UPN and puts the name, number need and notes in comments', () => {
    const d = draftOf(
      srToBuildDraft(
        'new_user',
        { display_name: 'Jo Bloggs', upn: 'Jo.Bloggs@Contoso.com', number: 'Keep an existing number', existing_number: '+44 20 7946 0000', voicemail: true, notes: 'Starts Monday' },
        CTX,
      ),
    );
    expect(d.kind).toBe('user');
    expect(d.key).toBe('jo.bloggs@contoso.com');
    if (d.kind !== 'user') return;
    expect(d.input.site_id).toBe(SITE);
    expect(d.input.upn).toBe('Jo.Bloggs@Contoso.com'); // the create schema lower-cases it
    expect(d.input.voicemail).toEqual({ enabled: true });
    expect(d.input.comments).toBe('From SR-0042.\nName: Jo Bloggs.\nPhone number: Keep an existing number (+44 20 7946 0000).\nNotes: Starts Monday');
    expect(d.input.phone_number_id).toBeUndefined(); // the number is left for the engineer
    assertValid(d);
    expect(buildIdentityCreateSchema.parse(d.input).upn).toBe('jo.bloggs@contoso.com');
  });

  it('also reads a person picked from the directory', () => {
    const d = draftOf(srToBuildDraft('new_user', { user: { upn: 'sam@contoso.com', name: 'Sam Smith' }, number: 'No number' }, CTX));
    expect(d.key).toBe('sam@contoso.com');
    if (d.kind === 'user') expect(d.input.comments).toContain('Name: Sam Smith.');
    expect(d.kind === 'user' && d.input.voicemail).toBeFalsy(); // not answered -> not set
    assertValid(d);
  });

  it('needs a site and a UPN', () => {
    expect(srToBuildDraft('new_user', { upn: 'a@b.com' }, { reference: 'SR-1', siteId: null }).ok).toBe(false);
    expect(srToBuildDraft('new_user', { display_name: 'No UPN' }, CTX).ok).toBe(false);
  });
});

describe('new common area phone -> build_caps', () => {
  it('uses the UPN the engineer gives, with name, location and model', () => {
    const d = draftOf(
      srToBuildDraft('new_common_area_phone', { display_name: 'Reception desk', location: 'Ground floor', device_model: 'Yealink MP54', number: 'New number' }, { ...CTX, capUpn: 'reception.desk@contoso.com' }),
    );
    expect(d.kind).toBe('cap');
    if (d.kind !== 'cap') return;
    expect(d.input).toMatchObject({ upn: 'reception.desk@contoso.com', display_name: 'Reception desk', phone_location: 'Ground floor', phone_model: 'Yealink MP54' });
    expect(d.label).toBe('Reception desk (reception.desk@contoso.com)');
    expect(d.input.comments).toContain('Phone number: New number.');
    assertValid(d);
  });

  it('asks for the UPN when none is given', () => {
    const r = srToBuildDraft('new_common_area_phone', { display_name: 'Lobby', number: 'No number' }, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/UPN/);
  });

  it('suggests a UPN from the name and the main domain', () => {
    expect(suggestCapUpn('Reception Desk (Ground)', 'contoso.com')).toBe('reception.desk.ground@contoso.com');
    expect(suggestCapUpn('Café', 'contoso.com')).toBe('cafe@contoso.com');
    expect(suggestCapUpn('Lobby', null)).toBeNull();
    expect(suggestCapUpn('!!!', 'contoso.com')).toBeNull();
  });
});

describe('new call queue -> build_call_queues', () => {
  it('maps every "How calls are shared out" option to a routing method', () => {
    const options = SR_TYPE_DEFS.new_call_queue.fields.find((f) => f.key === 'routing')!.options!;
    for (const o of options) expect(SR_ROUTING_TO_BUILD[o], o).toBeDefined();
    expect(SR_ROUTING_TO_BUILD['All at once']).toBe('Attendant');
    expect(SR_ROUTING_TO_BUILD['In order']).toBe('Serial');
  });

  it('takes the name, routing and agent UPNs', () => {
    const d = draftOf(
      srToBuildDraft('new_call_queue', { name: 'Sales', agents: ['A@contoso.com', 'b@contoso.com', 'a@contoso.com'], routing: 'Round robin', unanswered: 'Voicemail after 60s', number: 'New number' }, CTX),
    );
    expect(d.kind).toBe('call_queue');
    if (d.kind !== 'call_queue') return;
    expect(d.key).toBe('sales');
    expect(d.input.routing_method).toBe('RoundRobin');
    expect(d.input.agents).toEqual(['a@contoso.com', 'b@contoso.com']);
    expect(d.input.notes).toContain('If nobody answers: Voicemail after 60s.');
    assertValid(d);
  });

  it('uses the agents the API resolved, and leaves routing to the default when not chosen', () => {
    const d = draftOf(srToBuildDraft('new_call_queue', { name: 'Support', agents: ['Jo Bloggs'] }, { ...CTX, agentUpns: ['jo@contoso.com'] }));
    if (d.kind !== 'call_queue') throw new Error('kind');
    expect(d.input.agents).toEqual(['jo@contoso.com']);
    expect(d.input.routing_method).toBeNull();
    assertValid(d);
  });

  it('reads the picker shape too (people and a call target)', () => {
    const d = draftOf(
      srToBuildDraft(
        'new_call_queue',
        { name: 'Help', agents: [{ upn: 'X@contoso.com', name: 'X' }], unanswered_after: '1 minute', unanswered: { kind: 'voicemail', label: 'Voicemail' } },
        CTX,
      ),
    );
    if (d.kind !== 'call_queue') throw new Error('kind');
    expect(d.input.agents).toEqual(['x@contoso.com']);
    expect(d.input.notes).toContain('If nobody answers within 1 minute: Voicemail.');
  });

  it('splits agents into UPNs and names to look up', () => {
    expect(srAgentEntries({ agents: ['a@contoso.com', 'Jo Bloggs', ' ', { upn: 'B@contoso.com', name: 'B' }, { name: 'Sam' }] })).toEqual({
      upns: ['a@contoso.com', 'b@contoso.com'],
      names: ['Jo Bloggs', 'Sam'],
    });
    expect(srAgentEntries({ agents: 'a@contoso.com\nb@contoso.com' }).upns).toEqual(['a@contoso.com', 'b@contoso.com']);
    expect(srAgentEntries({})).toEqual({ upns: [], names: [] });
  });
});

describe('new auto attendant -> build_auto_attendants', () => {
  it('makes the greeting a text prompt and keeps the rest as notes', () => {
    const d = draftOf(
      srToBuildDraft(
        'new_auto_attendant',
        { name: 'Main line', greeting: 'Thanks for calling Contoso', menu: '1 = Sales, 2 = Support', business_hours: 'Mon-Fri 9-5', after_hours: 'Voicemail', number: 'Keep an existing number' },
        CTX,
      ),
    );
    expect(d.kind).toBe('auto_attendant');
    if (d.kind !== 'auto_attendant') return;
    expect(d.input.default_call_flow).toEqual({ greetings: [{ type: 'Text', text: 'Thanks for calling Contoso' }], menu: { options: [] } });
    expect(d.input.business_hours).toBe('Mon-Fri 9-5');
    expect(d.input.ooh_action).toBe('Voicemail');
    expect(d.input.notes).toContain('Menu options: 1 = Sales, 2 = Support');
    assertValid(d);
  });

  it('reads a structured menu and target', () => {
    const d = draftOf(
      srToBuildDraft(
        'new_auto_attendant',
        { name: 'Main', greeting: 'Hi', menu: [{ key: '1', target: { kind: 'call_queue', label: 'Sales' } }], after_hours: { kind: 'voicemail', label: 'Voicemail' } },
        CTX,
      ),
    );
    if (d.kind !== 'auto_attendant') throw new Error('kind');
    expect(d.input.notes).toContain('Menu options: 1: Sales');
    expect(d.input.ooh_action).toBe('Voicemail');
  });

  it('shortens long answers to the Design & Build limits and points back to the request', () => {
    const d = draftOf(srToBuildDraft('new_auto_attendant', { name: 'Main', greeting: 'Hi', business_hours: 'x'.repeat(1000) }, CTX));
    if (d.kind !== 'auto_attendant') throw new Error('kind');
    expect(d.input.business_hours!.length).toBe(400);
    expect(d.input.business_hours).toMatch(/\(full text on SR-0042\)$/);
    assertValid(d);
  });
});

describe('new site -> discovery_sites', () => {
  it('takes the site code, name, address and country', () => {
    const d = draftOf(srToBuildDraft('new_site', { sitecode: 'LON02', name: 'London', address: '1 High St\nLondon', country: 'United Kingdom', go_live: '2026-12-01' }, { reference: 'SR-7', siteId: null }));
    expect(d).toMatchObject({ kind: 'site', key: 'LON02', input: { sitecode: 'LON02', name: 'London', address: '1 High St\nLondon', country: 'United Kingdom' } });
    assertValid(d);
  });

  it('turns an ISO country code into its name', () => {
    const d = draftOf(srToBuildDraft('new_site', { sitecode: 'PAR01', name: 'Paris', address: 'x', country: 'FR' }, { reference: 'SR-7', siteId: null }));
    if (d.kind === 'site') expect(d.input.country).toBe('France');
  });
});

describe('helpers', () => {
  it('fitText leaves short text alone', () => {
    expect(fitText('abc', 10, 'SR-1')).toBe('abc');
    expect(fitText('a'.repeat(50), 40, 'SR-1')).toHaveLength(40);
  });

  it('links each kind to its Design & Build tab or the site page', () => {
    expect(srBuildHref('user', SITE)).toBe(`/build/sites/${SITE}?tab=users`);
    expect(srBuildHref('auto_attendant', SITE)).toBe(`/build/sites/${SITE}?tab=auto-attendants`);
    expect(srBuildHref('site', SITE)).toBe(`/data-collection/sites/${SITE}`);
  });

  it('accepts an empty body or a valid CAP UPN', () => {
    expect(serviceRequestBuildDraftSchema.safeParse({}).success).toBe(true);
    expect(serviceRequestBuildDraftSchema.parse({ capUpn: 'Lobby@Contoso.com' }).capUpn).toBe('lobby@contoso.com');
    expect(serviceRequestBuildDraftSchema.safeParse({ capUpn: 'not a upn' }).success).toBe(false);
  });
});
