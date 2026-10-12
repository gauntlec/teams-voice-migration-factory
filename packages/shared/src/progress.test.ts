import { describe, expect, it } from 'vitest';
import { deriveSiteProgress, type SiteProgressInput } from './progress';

const base = (over: Partial<SiteProgressInput> = {}): SiteProgressInput => ({
  discoveryStatus: 'accepted',
  captured: { users: 0, caps: 0, resourceAccounts: 0 },
  build: { users: 0, caps: 0, resourceAccounts: 0, other: 0, validationIssues: 0, lastChangeAt: null },
  lastDryRun: null,
  lastLiveRun: null,
  firstLiveAt: null,
  runInProgress: null,
  handover: { issued: null, draftVersion: null },
  mode: 'project',
  ...over,
});

const designed = (over: Partial<SiteProgressInput['build']> = {}): SiteProgressInput['build'] => ({
  users: 10,
  caps: 2,
  resourceAccounts: 1,
  other: 0,
  validationIssues: 0,
  lastChangeAt: '2026-10-01T10:00:00Z',
  ...over,
});

const stateOf = (p: ReturnType<typeof deriveSiteProgress>) => Object.fromEntries(p.stages.map((s) => [s.key, s.state]));

describe('deriveSiteProgress', () => {
  it('a brand-new site is at Data Collection with one blocker', () => {
    const p = deriveSiteProgress(base({ discoveryStatus: 'draft' }));
    expect(p.current).toBe('data_collection');
    expect(p.complete).toBe(false);
    expect(Object.values(stateOf(p)).every((s) => s === 'todo')).toBe(true);
    expect(p.blockers).toEqual([{ stage: 'data_collection', message: 'No users, phones or resource accounts captured yet' }]);
  });

  it('Data Collection is done once something is captured and the customer has submitted', () => {
    const captured = { users: 5, caps: 1, resourceAccounts: 0 };
    expect(stateOf(deriveSiteProgress(base({ captured, discoveryStatus: 'draft' }))).data_collection).toBe('todo');
    const submitted = deriveSiteProgress(base({ captured, discoveryStatus: 'submitted' }));
    expect(submitted.stages[0]).toMatchObject({ state: 'done', detail: '6 captured' });
    expect(submitted.current).toBe('designed');
    expect(submitted.blockers).toEqual([]);
  });

  it('a designed site with validation issues is stuck at Validated', () => {
    const p = deriveSiteProgress(base({ build: designed({ validationIssues: 12 }) }));
    expect(stateOf(p)).toMatchObject({ designed: 'done', validated: 'attention', dry_run: 'todo' });
    expect(p.current).toBe('validated');
    expect(p.blockers).toEqual([{ stage: 'validated', message: '12 rows have validation issues' }]);
    expect(deriveSiteProgress(base({ build: designed({ validationIssues: 1 }) })).blockers[0]?.message).toBe('1 row has validation issues');
  });

  it('a dry run older than the latest design change needs redoing', () => {
    const p = deriveSiteProgress(
      base({
        build: designed({ lastChangeAt: '2026-10-05T00:00:00Z' }),
        lastDryRun: { status: 'completed', createdAt: '2026-10-02T00:00:00Z', failed: 0 },
      }),
    );
    expect(stateOf(p).dry_run).toBe('attention');
    expect(p.current).toBe('dry_run');
    expect(p.blockers).toEqual([{ stage: 'dry_run', message: 'Dry run is older than the latest design change' }]);
  });

  it('a clean, current dry run moves the site on to Deployed', () => {
    const p = deriveSiteProgress(base({ build: designed(), lastDryRun: { status: 'completed', createdAt: '2026-10-02T00:00:00Z', failed: 0 } }));
    expect(stateOf(p).dry_run).toBe('done');
    expect(p.current).toBe('deployed');
    expect(p.blockers).toEqual([]);
  });

  it('flags a failed dry run and one with failures', () => {
    const failed = deriveSiteProgress(base({ build: designed(), lastDryRun: { status: 'failed', createdAt: '2026-10-02T00:00:00Z', failed: 0 } }));
    expect(failed.blockers).toEqual([{ stage: 'dry_run', message: 'Last dry run failed' }]);
    const withFailures = deriveSiteProgress(base({ build: designed(), lastDryRun: { status: 'completed', createdAt: '2026-10-02T00:00:00Z', failed: 2 } }));
    expect(withFailures.blockers).toEqual([{ stage: 'dry_run', message: 'Last dry run reported 2 failures' }]);
  });

  it('a live run with failures is not Deployed', () => {
    const p = deriveSiteProgress(
      base({
        build: designed(),
        lastDryRun: { status: 'completed', createdAt: '2026-10-02T00:00:00Z', failed: 0 },
        lastLiveRun: { status: 'completed', createdAt: '2026-10-03T00:00:00Z', failed: 3 },
      }),
    );
    expect(stateOf(p)).toMatchObject({ dry_run: 'done', deployed: 'attention' });
    expect(p.current).toBe('deployed');
    expect(p.blockers).toEqual([{ stage: 'deployed', message: 'Last live run had 3 failures' }]);
    const failed = deriveSiteProgress(base({ build: designed(), lastLiveRun: { status: 'failed', createdAt: '2026-10-03T00:00:00Z', failed: 0 } }));
    expect(failed.blockers).toContainEqual({ stage: 'deployed', message: 'Last live run failed' });
  });

  it('a clean live run after the latest change covers the dry run too', () => {
    const p = deriveSiteProgress(base({ build: designed(), lastLiveRun: { status: 'completed', createdAt: '2026-10-03T00:00:00Z', failed: 0 } }));
    expect(stateOf(p)).toMatchObject({ dry_run: 'done', deployed: 'done', handover: 'todo' });
    expect(p.stages.find((s) => s.key === 'dry_run')?.detail).toBe('Covered by live run');
    expect(p.current).toBe('handover');
    expect(p.blockers).toEqual([]);
  });

  it('a design change after go-live sends the site back to a dry run', () => {
    const p = deriveSiteProgress(
      base({
        build: designed({ lastChangeAt: '2026-10-09T00:00:00Z' }),
        lastDryRun: { status: 'completed', createdAt: '2026-10-02T00:00:00Z', failed: 0 },
        lastLiveRun: { status: 'completed', createdAt: '2026-10-03T00:00:00Z', failed: 0 },
      }),
    );
    expect(stateOf(p)).toMatchObject({ dry_run: 'attention', deployed: 'attention' });
    expect(p.current).toBe('dry_run');
    expect(p.blockers.map((b) => b.message)).toEqual([
      'Dry run is older than the latest design change',
      'The design has changed since the last live run',
    ]);
  });

  it('an issued handover pack and operations mode complete the site', () => {
    const live = {
      build: designed(),
      lastLiveRun: { status: 'completed' as const, createdAt: '2026-10-03T00:00:00Z', failed: 0 },
      firstLiveAt: '2026-10-03T00:00:00Z',
    };
    const draft = deriveSiteProgress(base({ ...live, handover: { issued: null, draftVersion: 2 } }));
    expect(draft.stages.find((s) => s.key === 'handover')).toMatchObject({ state: 'todo', detail: 'Draft v2 not issued' });
    const handedOver = deriveSiteProgress(base({ ...live, handover: { issued: { version: 1, issuedAt: '2026-10-04T00:00:00Z' }, draftVersion: null } }));
    expect(handedOver.current).toBe('operations');
    expect(handedOver.complete).toBe(false);
    const ops = deriveSiteProgress(base({ ...live, handover: { issued: { version: 1, issuedAt: '2026-10-04T00:00:00Z' }, draftVersion: null }, mode: 'operations' }));
    expect(ops.current).toBe('operations');
    expect(ops.complete).toBe(true);
  });

  it('a pack issued before the site went live does not hand it over', () => {
    const issued = { version: 1, issuedAt: '2026-09-20T00:00:00Z' };
    const notLive = deriveSiteProgress(base({ build: designed(), handover: { issued, draftVersion: null } }));
    expect(notLive.stages.find((s) => s.key === 'handover')).toMatchObject({ state: 'todo', detail: 'v1 predates go-live' });
    expect(notLive.current).toBe('dry_run');
    const liveLater = deriveSiteProgress(
      base({
        build: designed(),
        lastLiveRun: { status: 'completed', createdAt: '2026-10-03T00:00:00Z', failed: 0 },
        firstLiveAt: '2026-10-03T00:00:00Z',
        handover: { issued, draftVersion: null },
      }),
    );
    expect(liveLater.stages.find((s) => s.key === 'handover')?.state).toBe('todo');
    expect(liveLater.current).toBe('handover');
  });

  it('the current stage is the one after the furthest finished stage, even if an earlier one is unfinished', () => {
    // Designed straight from the live tenant: nothing captured, Data Collection never submitted.
    const p = deriveSiteProgress(base({ discoveryStatus: 'draft', build: designed() }));
    expect(stateOf(p)).toMatchObject({ data_collection: 'todo', validated: 'done' });
    expect(p.current).toBe('dry_run');
    expect(p.blockers).toEqual([]);
  });

  it('the summary view collapses the engineering stages and hides their blockers', () => {
    const input = base({
      captured: { users: 3, caps: 0, resourceAccounts: 0 },
      build: designed({ validationIssues: 4 }),
      lastLiveRun: { status: 'completed', createdAt: '2026-10-03T00:00:00Z', failed: 2 },
    });
    const p = deriveSiteProgress(input, false);
    expect(p.stages.map((s) => s.key)).toEqual(['data_collection', 'delivery', 'handover', 'operations']);
    expect(p.stages[1]).toMatchObject({ state: 'todo', detail: 'In progress with the project team' });
    expect(p.current).toBe('delivery');
    expect(p.blockers).toEqual([]);

    const live = deriveSiteProgress(base({ build: designed(), lastLiveRun: { status: 'completed', createdAt: '2026-10-03T00:00:00Z', failed: 0 } }), false);
    expect(live.stages[1]).toMatchObject({ key: 'delivery', state: 'done', detail: 'Live' });
    expect(live.current).toBe('handover');
  });
});
