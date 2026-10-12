/**
 * The home-page migration progress: where each site of a customer is, from
 * Data Collection to Operations, derived only from data the app already
 * stores - there is no manual status field. ProgressService (apps/api) gathers
 * the inputs; deriveSiteProgress turns them into stages and plain-words
 * blockers. Kept pure so the rules are unit-tested. See docs/PROGRESS.md.
 */
import type { DiscoveryStatus } from './domain';

export const PROGRESS_STAGES = ['data_collection', 'designed', 'validated', 'dry_run', 'deployed', 'handover', 'operations'] as const;
export type ProgressStageKey = (typeof PROGRESS_STAGES)[number];

/**
 * 'delivery' stands in for designed/validated/dry_run/deployed for anyone who
 * can't see Design & Build or Deployment (project managers, customers).
 */
export type ProgressStageViewKey = ProgressStageKey | 'delivery';

export const PROGRESS_STAGE_LABELS: Record<ProgressStageViewKey, string> = {
  data_collection: 'Data Collection',
  designed: 'Designed',
  validated: 'Validated',
  dry_run: 'Dry run',
  deployed: 'Deployed',
  delivery: 'Design & deployment',
  handover: 'Handover',
  operations: 'Operations',
};

/** done = finished; attention = reached or attempted but something needs fixing; todo = not started. */
export type ProgressStageState = 'done' | 'attention' | 'todo';


/** A finished (completed or failed) deployment run. */
export interface ProgressRun {
  status: 'completed' | 'failed';
  /** when the run was started - the design it applied is the one as of this time */
  createdAt: string;
  /** deployments.summary.failed - rows the run could not apply */
  failed: number;
}

export interface SiteProgressInput {
  /** the customer-wide Data Collection status (one discovery row per customer) */
  discoveryStatus: DiscoveryStatus;
  /** rows captured for this site in Data Collection */
  captured: { users: number; caps: number; resourceAccounts: number };
  build: {
    users: number;
    caps: number;
    resourceAccounts: number;
    /** other site build rows: auto attendants, call queues, shared calling policies */
    other: number;
    /** BuildService.siteRollup's validationIssues */
    validationIssues: number;
    /** latest updated_at over every build row of the site; null = no rows */
    lastChangeAt: string | null;
  };
  /** the site's latest finished dry run / live run */
  lastDryRun: ProgressRun | null;
  lastLiveRun: ProgressRun | null;
  /** when the site's first clean live run started - a handover pack only counts once the site is live */
  firstLiveAt: string | null;
  /** a run for this site is queued or running now */
  runInProgress: 'dry_run' | 'execute' | null;
  handover: {
    /** latest issued pack covering this site (every-site packs included) */
    issued: { version: number; issuedAt: string } | null;
    /** a newer draft pack covering this site, not yet issued */
    draftVersion: number | null;
  };
  mode: 'project' | 'operations';
}

export interface ProgressStage {
  key: ProgressStageViewKey;
  label: string;
  state: ProgressStageState;
  /** one short line under the chip, e.g. "47 captured" or "Dry run 12 Oct" */
  detail: string | null;
}

export interface ProgressBlocker {
  stage: ProgressStageViewKey;
  message: string;
}

export interface SiteProgress {
  stages: ProgressStage[];
  /** the stage being worked on: the one after the furthest finished stage (operations once it is reached) */
  current: ProgressStageViewKey;
  /** true once the site is in Operations */
  complete: boolean;
  blockers: ProgressBlocker[];
}

export interface SiteProgressRow extends SiteProgress {
  id: string;
  sitecode: string;
  name: string | null;
}

export interface CustomerProgressItem {
  /** what the item is about, for picking a link in the UI */
  kind: 'data_collection' | 'discovery_sync' | 'service_requests';
  message: string;
  /** true = something to act on (shown in Needs attention); false = information */
  attention: boolean;
}

/** GET /t/:tenantId/progress */
export interface CustomerProgress {
  discoveryStatus: DiscoveryStatus;
  /** the caller sees designed/validated/dry_run/deployed rather than one 'delivery' stage */
  fullView: boolean;
  sites: SiteProgressRow[];
  items: CustomerProgressItem[];
  /** latest Discovery (live tenant) sync run; omitted for roles that can't see Discovery */
  lastDiscoverySync?: { status: string; finishedAt: string | null; createdAt: string } | null;
  /** open service requests; omitted when Managed Services is off or the role can't see them */
  openServiceRequests?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 Oct" - dates in details are short; the full time is on the module's own page. */
export function progressShortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const newer = (a: string, b: string) => new Date(a).getTime() >= new Date(b).getTime();

/**
 * Derives one site's stages. `fullView` false collapses the four engineering
 * stages into one 'delivery' stage and drops their blockers - project
 * managers and customers can't open Design & Build or Deployment.
 */
export function deriveSiteProgress(input: SiteProgressInput, fullView = true): SiteProgress {
  const { captured, build, lastDryRun, lastLiveRun, handover } = input;
  const capturedTotal = captured.users + captured.caps + captured.resourceAccounts;
  const buildTotal = build.users + build.caps + build.resourceAccounts + build.other;
  const designed = buildTotal > 0;
  const lastChange = build.lastChangeAt;
  const blockers: ProgressBlocker[] = [];
  const stages: ProgressStage[] = [];
  const add = (key: ProgressStageViewKey, state: ProgressStageState, detail: string | null) =>
    stages.push({ key, label: PROGRESS_STAGE_LABELS[key], state, detail });

  /* Data Collection: something captured for the site and the customer's Data Collection submitted. */
  const capturedLine = `${capturedTotal} captured`;
  if (capturedTotal > 0 && input.discoveryStatus !== 'draft') {
    // "awaiting review" is a customer-wide item, not repeated on every site.
    add('data_collection', 'done', capturedLine);
  } else {
    add('data_collection', 'todo', capturedTotal === 0 ? 'Nothing captured yet' : `${capturedLine} · not submitted`);
    // Only worth flagging when nothing else has happened either - a site
    // designed straight from the live tenant can have no capture at all.
    if (capturedTotal === 0 && !designed) blockers.push({ stage: 'data_collection', message: 'No users, phones or resource accounts captured yet' });
  }

  /* Designed: any build row for the site. */
  const designedState: ProgressStageState = designed ? 'done' : 'todo';
  const designedDetail = designed ? plural(buildTotal, 'row') : null;

  /* Validated: designed and no row with a validation issue. */
  let validatedState: ProgressStageState = 'todo';
  let validatedDetail: string | null = null;
  const engineering: ProgressBlocker[] = [];
  if (designed) {
    if (build.validationIssues > 0) {
      validatedState = 'attention';
      validatedDetail = `${plural(build.validationIssues, 'issue')}`;
      engineering.push({
        stage: 'validated',
        message: `${plural(build.validationIssues, 'row has', 'rows have')} validation issues`,
      });
    } else {
      validatedState = 'done';
      validatedDetail = 'No issues';
    }
  }

  /* Deployed: the latest live run completed with no failures, and nothing changed since. */
  let deployedState: ProgressStageState = 'todo';
  let deployedDetail: string | null = input.runInProgress === 'execute' ? 'Live run in progress' : null;
  const liveClean = !!lastLiveRun && lastLiveRun.status === 'completed' && lastLiveRun.failed === 0;
  const liveCurrent = liveClean && (!lastChange || newer(lastLiveRun!.createdAt, lastChange));
  if (lastLiveRun) {
    deployedDetail ??= `Live run ${progressShortDate(lastLiveRun.createdAt)}`;
    if (lastLiveRun.status === 'failed') {
      deployedState = 'attention';
      engineering.push({ stage: 'deployed', message: 'Last live run failed' });
    } else if (lastLiveRun.failed > 0) {
      deployedState = 'attention';
      engineering.push({ stage: 'deployed', message: `Last live run had ${plural(lastLiveRun.failed, 'failure')}` });
    } else if (!liveCurrent) {
      deployedState = 'attention';
      engineering.push({ stage: 'deployed', message: 'The design has changed since the last live run' });
    } else {
      deployedState = 'done';
    }
  }

  /*
   * Dry run: the latest dry run completed cleanly after the latest design
   * change. A clean live run after the change covers it too - nobody needs a
   * fresh dry run of a design that is already live.
   */
  let dryState: ProgressStageState = 'todo';
  let dryDetail: string | null = input.runInProgress === 'dry_run' ? 'Dry run in progress' : null;
  if (liveCurrent && (!lastDryRun || !newer(lastDryRun.createdAt, lastLiveRun!.createdAt))) {
    dryState = 'done';
    dryDetail ??= lastDryRun ? `Dry run ${progressShortDate(lastDryRun.createdAt)}` : 'Covered by live run';
  } else if (lastDryRun) {
    dryDetail ??= `Dry run ${progressShortDate(lastDryRun.createdAt)}`;
    if (lastDryRun.status === 'failed') {
      dryState = 'attention';
      engineering.push({ stage: 'dry_run', message: 'Last dry run failed' });
    } else if (lastDryRun.failed > 0) {
      dryState = 'attention';
      engineering.push({ stage: 'dry_run', message: `Last dry run reported ${plural(lastDryRun.failed, 'failure')}` });
    } else if (lastChange && !newer(lastDryRun.createdAt, lastChange)) {
      dryState = 'attention';
      engineering.push({ stage: 'dry_run', message: 'Dry run is older than the latest design change' });
    } else {
      dryState = 'done';
    }
  }

  if (fullView) {
    add('designed', designedState, designedDetail);
    add('validated', validatedState, validatedDetail);
    add('dry_run', dryState, dryDetail);
    add('deployed', deployedState, deployedDetail);
    // In engineering order, not the order they were found in.
    const order: ProgressStageViewKey[] = ['validated', 'dry_run', 'deployed'];
    blockers.push(...engineering.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage)));
  } else {
    // One stage for the team's work; engineering blockers stay with the engineers.
    const live = deployedState === 'done';
    add('delivery', live ? 'done' : 'todo', live ? 'Live' : designed ? 'In progress with the project team' : null);
  }

  /*
   * Handover: an issued pack covers the site, issued after the site first went
   * live. Packs are often customer-wide, and one issued for the first sites
   * says nothing about a site deployed after it.
   */
  const issued = handover.issued;
  if (issued && input.firstLiveAt && newer(issued.issuedAt, input.firstLiveAt)) {
    add('handover', 'done', `v${issued.version} issued ${progressShortDate(issued.issuedAt)}`);
  } else if (issued && handover.draftVersion == null) {
    add('handover', 'todo', `v${issued.version} predates go-live`);
  } else {
    add('handover', 'todo', handover.draftVersion != null ? `Draft v${handover.draftVersion} not issued` : null);
  }

  /* Operations: the site was moved to operations mode. */
  add('operations', input.mode === 'operations' ? 'done' : 'todo', input.mode === 'operations' ? 'In service' : null);

  let furthest = -1;
  stages.forEach((st, i) => {
    if (st.state === 'done') furthest = i;
  });
  const last = stages.length - 1;
  const complete = stages[last]!.state === 'done';
  const current = stages[Math.min(furthest + 1, last)]!.key;
  return { stages, current, complete, blockers };
}
