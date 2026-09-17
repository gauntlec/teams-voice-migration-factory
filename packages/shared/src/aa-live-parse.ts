/**
 * Pure parsers for the raw Get-CsAutoAttendant/Get-CsCallQueue/
 * Get-CsOnlineSchedule shape stored verbatim in tenant_objects.data -
 * reverse-engineered against OVP012's real live Auto Attendants this
 * session (see the "reverse-engineer OVP012" plan). Used by
 * BuildService.populateResourceAccounts to pre-fill the structured AA/CQ
 * columns from live data, and intended for reuse by the Discovery-side
 * call-flow diagram (Workstream 6), which reads the same raw shape.
 *
 * These return an intermediate shape, not the final AutoAttendant* types in
 * deployment.ts: a menu option's target may be a same-site Auto Attendant or
 * Call Queue, identified here only by its live Identity GUID
 * (`LiveCallableEntityRef.liveId`) - resolving that GUID to a
 * build_auto_attendants/build_call_queues id needs a DB-backed lookup only
 * the caller has.
 */
import { AA_DTMF_RESPONSES, AA_DIRECTORY_SEARCH_METHODS } from './domain';
import type {
  AutoAttendantCallableEntity,
  AutoAttendantCallFlow,
  AutoAttendantHolidayCallFlow,
  AutoAttendantMenu,
  AutoAttendantMenuOption,
  AutoAttendantSchedule,
} from './deployment';

export interface LiveCallableEntityRef {
  kind: 'voice_app' | 'user' | 'external' | 'unknown';
  /** Identity GUID - for kind 'voice_app' (resolve against both AA and CQ live-Identity maps) or 'user' (resolve against tenant_users.object_id). */
  liveId?: string;
  /** tel: string - only for kind 'external'. */
  number?: string;
}

export interface LiveMenuOption {
  dtmf: (typeof AA_DTMF_RESPONSES)[number];
  /** 'DisconnectCall' is used whenever no real CallTarget was captured - this is what Teams' simple after-hours/holiday action selector (not a custom menu) produces internally, not a guess. */
  action: 'TransferCallToTarget' | 'DisconnectCall';
  target?: LiveCallableEntityRef;
}

export interface LiveMenu {
  enableDialByName?: boolean;
  directorySearchMethod?: (typeof AA_DIRECTORY_SEARCH_METHODS)[number];
  options: LiveMenuOption[];
  /** New-CsAutoAttendantMenu -Prompts - the menu's own spoken prompt (e.g. "For Sales press 1..."), distinct from the CallFlow's Greetings. */
  prompts?: LivePrompt[];
}

export interface LivePrompt {
  type: 'None' | 'Text' | 'AudioFile';
  text?: string;
}

export interface LiveCallFlow {
  greetings: LivePrompt[];
  menu: LiveMenu;
}

export interface LiveTimeRange {
  start: string;
  end: string;
}

export interface LiveSchedule {
  type: 'weekly' | 'fixed';
  weekly?: {
    monday: LiveTimeRange[];
    tuesday: LiveTimeRange[];
    wednesday: LiveTimeRange[];
    thursday: LiveTimeRange[];
    friday: LiveTimeRange[];
    saturday: LiveTimeRange[];
    sunday: LiveTimeRange[];
    complement?: boolean;
  };
  fixed?: { ranges: { start: string; end: string }[] };
}

/** DtmfResponse serializes as a bare int: 0-9 -> Tone0-Tone9, 100 -> Automatic (Teams' sentinel for the catch-all/no-input option). */
export function parseLiveDtmf(raw: unknown): (typeof AA_DTMF_RESPONSES)[number] | undefined {
  if (typeof raw !== 'number') return undefined;
  if (raw === 100) return 'Automatic';
  if (raw >= 0 && raw <= 9) return AA_DTMF_RESPONSES[raw];
  return undefined;
}

/**
 * CallTarget is `{Id, Type}` where Type 6 = voice app (AA/CQ), 0 = user, and
 * a bare `tel:` string Id = external number - OR a plain string holding the
 * .NET type name (`Microsoft.Rtc.Management.Hosted.OAA.Models.CallableEntity`)
 * when ConvertTo-Json's depth limit truncated a real object (see the AA
 * cmdlet's `depth: 10` fix, apps/worker/src/discovery/cmdlets.ts) - treated
 * as "no target captured", not a real disconnect/voicemail configuration.
 */
export function parseLiveCallTarget(raw: unknown): LiveCallableEntityRef | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const id = typeof o.Id === 'string' ? o.Id : undefined;
  if (!id) return undefined;
  if (id.startsWith('tel:')) return { kind: 'external', number: id };
  const type = typeof o.Type === 'number' ? o.Type : undefined;
  if (type === 0) return { kind: 'user', liveId: id };
  if (type === 6) return { kind: 'voice_app', liveId: id };
  return { kind: 'unknown', liveId: id };
}

export function parseLiveMenuOption(raw: unknown): LiveMenuOption | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const dtmf = parseLiveDtmf(o.DtmfResponse);
  if (!dtmf) return undefined;
  const target = parseLiveCallTarget(o.CallTarget);
  return target ? { dtmf, action: 'TransferCallToTarget', target } : { dtmf, action: 'DisconnectCall' };
}

export function parseLiveMenu(raw: unknown): LiveMenu | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const options = Array.isArray(o.MenuOptions)
    ? (o.MenuOptions as unknown[]).map(parseLiveMenuOption).filter((v): v is LiveMenuOption => !!v)
    : [];
  const prompts = Array.isArray(o.Prompts)
    ? (o.Prompts as unknown[]).map(parseLivePrompt).filter((v): v is LivePrompt => !!v)
    : [];
  return {
    enableDialByName: typeof o.DialByNameEnabled === 'boolean' ? o.DialByNameEnabled : undefined,
    // Confirmed live (was previously flagged "unconfirmed" here and in
    // AA_DIRECTORY_SEARCH_METHODS's own domain.ts note): Teams' numeric
    // encoding is None=0, ByName=1, ByExtension=2 - matching Microsoft
    // Learn's own documented order (None | ByName | ByExtension) - not
    // ByName=0/ByExtension=1 as this previously assumed. A row that never
    // set -DirectorySearchMethod at all deploys as plain 0/None, which this
    // used to misread as 'ByName', permanently disagreeing with the row's
    // own undefined value even though nothing had actually changed.
    directorySearchMethod:
      o.DirectorySearchMethod === 1 ? AA_DIRECTORY_SEARCH_METHODS[0] : o.DirectorySearchMethod === 2 ? AA_DIRECTORY_SEARCH_METHODS[1] : undefined,
    options,
    prompts,
  };
}

function parseLivePrompt(raw: unknown): LivePrompt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.TextToSpeechPrompt === 'string' && o.TextToSpeechPrompt) return { type: 'Text', text: o.TextToSpeechPrompt };
  if (o.AudioFilePrompt) return { type: 'AudioFile' };
  return { type: 'None' };
}

export function parseLiveCallFlow(raw: unknown): LiveCallFlow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const greetings = Array.isArray(o.Greetings)
    ? (o.Greetings as unknown[]).map(parseLivePrompt).filter((v): v is LivePrompt => !!v)
    : [];
  return { greetings, menu: parseLiveMenu(o.Menu) ?? { options: [] } };
}

function fmtTimeOfDay(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const h = typeof o.Hours === 'number' ? o.Hours : undefined;
  const m = typeof o.Minutes === 'number' ? o.Minutes : undefined;
  if (h == null || m == null) return undefined;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function parseLiveTimeRanges(raw: unknown): LiveTimeRange[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      if (!r || typeof r !== 'object') return undefined;
      const o = r as Record<string, unknown>;
      const start = fmtTimeOfDay(o.Start);
      const end = fmtTimeOfDay(o.End);
      return start && end ? { start, end } : undefined;
    })
    .filter((v): v is LiveTimeRange => !!v);
}

/** New-CsOnlineSchedule - either a FixedSchedule (holiday date ranges) or a WeeklyRecurrentSchedule (business/after hours), never both populated. */
export function parseLiveSchedule(raw: unknown): LiveSchedule | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const fixedRanges = (o.FixedSchedule as Record<string, unknown> | null)?.DateTimeRanges;
  if (Array.isArray(fixedRanges) && fixedRanges.length > 0) {
    const ranges = fixedRanges
      .map((r) => {
        if (!r || typeof r !== 'object') return undefined;
        const rr = r as Record<string, unknown>;
        return typeof rr.Start === 'string' && typeof rr.End === 'string' ? { start: rr.Start, end: rr.End } : undefined;
      })
      .filter((v): v is { start: string; end: string } => !!v);
    return { type: 'fixed', fixed: { ranges } };
  }
  const w = o.WeeklyRecurrentSchedule as Record<string, unknown> | null;
  if (w) {
    return {
      type: 'weekly',
      weekly: {
        monday: parseLiveTimeRanges(w.MondayHours),
        tuesday: parseLiveTimeRanges(w.TuesdayHours),
        wednesday: parseLiveTimeRanges(w.WednesdayHours),
        thursday: parseLiveTimeRanges(w.ThursdayHours),
        friday: parseLiveTimeRanges(w.FridayHours),
        saturday: parseLiveTimeRanges(w.SaturdayHours),
        sunday: parseLiveTimeRanges(w.SundayHours),
        complement: typeof w.ComplementEnabled === 'boolean' ? w.ComplementEnabled : undefined,
      },
    };
  }
  return undefined;
}

/** What liveAutoAttendantToStructured converts one live Auto Attendant object into - the same shape build_auto_attendants stores, so it can be deep-compared against a saved row. */
export interface LiveAutoAttendantStructured {
  languageId?: string;
  timeZoneId?: string;
  voiceId?: string;
  enableVoiceResponse?: boolean;
  operator: AutoAttendantCallableEntity | null;
  defaultCallFlow: AutoAttendantCallFlow | null;
  afterHoursCallFlow: AutoAttendantCallFlow | null;
  holidayCallFlows: AutoAttendantHolidayCallFlow[];
  schedule: AutoAttendantSchedule | null;
}

/**
 * Converts a live Get-CsAutoAttendant object into the same structured shape
 * build_auto_attendants stores. This IS the conversion
 * BuildService.populateStructuredFromLive uses to pre-fill a row from live
 * data (factored out here so it's one implementation, not two that can
 * silently drift) - and, run fresh at deploy-preview time, it's also what
 * lets the deployment planner tell "this row already matches the tenant"
 * from "something really changed", instead of always re-sending
 * Set-CsAutoAttendant just because a live object exists.
 *
 * `resolveTarget` turns a live CallTarget/-Operator reference into a
 * build-shaped one (a UPN for a user, a same-site buildId for another
 * AA/CQ) - the caller supplies it since that resolution needs a DB lookup
 * (tenant_users, and this site's own build_auto_attendants/build_call_queues
 * rows) this pure function doesn't have access to. `scheduleByKey` is every
 * live Schedule object keyed by its own object_key/GUID (a
 * CallHandlingAssociation's ScheduleId), needed to resolve the after-hours/
 * holiday schedule paired with each CallFlow.
 */
export function liveAutoAttendantToStructured(
  data: Record<string, unknown>,
  scheduleByKey: Map<string, Record<string, unknown>>,
  resolveTarget: (ref: LiveCallableEntityRef | undefined) => AutoAttendantCallableEntity | undefined,
): LiveAutoAttendantStructured {
  const resolveMenuOption = (opt: LiveMenuOption): AutoAttendantMenuOption => ({
    dtmf: opt.dtmf,
    action: opt.action,
    target: resolveTarget(opt.target),
  });
  const resolveMenu = (m: LiveMenu): AutoAttendantMenu => ({
    enableDialByName: m.enableDialByName,
    directorySearchMethod: m.directorySearchMethod,
    options: m.options.map(resolveMenuOption),
    prompts: m.prompts?.map((p) => ({ type: p.type, text: p.text })),
  });
  const resolveCallFlow = (cf: LiveCallFlow): AutoAttendantCallFlow => ({
    greetings: cf.greetings.map((g) => ({ type: g.type, text: g.text })),
    menu: resolveMenu(cf.menu),
  });

  const out: LiveAutoAttendantStructured = {
    languageId: typeof data.LanguageId === 'string' ? data.LanguageId : undefined,
    timeZoneId: typeof data.TimeZoneId === 'string' ? data.TimeZoneId : undefined,
    voiceId: typeof data.VoiceId === 'string' ? data.VoiceId : undefined,
    // Get-CsAutoAttendant's own object names this VoiceResponseEnabled, not
    // EnableVoiceResponse (that's only the New/Set-CsAutoAttendant *write*
    // parameter name - Microsoft's read/write asymmetry). Reading the write
    // name here always came back undefined, permanently disagreeing with a
    // row that had it enabled - confirmed live: a just-deployed, correctly
    // configured Auto Attendant never stopped showing as "needs deploying"
    // after this exact field silently failed to round-trip.
    enableVoiceResponse: typeof data.VoiceResponseEnabled === 'boolean' ? data.VoiceResponseEnabled : undefined,
    operator: resolveTarget(parseLiveCallTarget(data.Operator)) ?? null,
    defaultCallFlow: null,
    afterHoursCallFlow: null,
    holidayCallFlows: [],
    schedule: null,
  };

  const defaultCf = parseLiveCallFlow(data.DefaultCallFlow);
  if (defaultCf) out.defaultCallFlow = resolveCallFlow(defaultCf);

  const callFlowsById = new Map(
    (Array.isArray(data.CallFlows) ? (data.CallFlows as Record<string, unknown>[]) : []).map((cf) => [cf.Id as string, cf]),
  );
  for (const cha of Array.isArray(data.CallHandlingAssociations) ? (data.CallHandlingAssociations as Record<string, unknown>[]) : []) {
    const cfRaw = typeof cha.CallFlowId === 'string' ? callFlowsById.get(cha.CallFlowId) : undefined;
    const parsedCf = cfRaw ? parseLiveCallFlow(cfRaw) : undefined;
    const scheduleRaw = typeof cha.ScheduleId === 'string' ? scheduleByKey.get(cha.ScheduleId) : undefined;
    const parsedSchedule = scheduleRaw ? parseLiveSchedule(scheduleRaw) : undefined;
    if (!parsedCf) continue;
    if (cha.Type === 0) {
      out.afterHoursCallFlow = resolveCallFlow(parsedCf);
      if (parsedSchedule) out.schedule = parsedSchedule;
    } else if (cha.Type === 1 && parsedSchedule) {
      out.holidayCallFlows.push({
        name: (typeof scheduleRaw?.Name === 'string' && scheduleRaw.Name) || (typeof cfRaw?.Name === 'string' && cfRaw.Name) || 'Holiday',
        callFlow: resolveCallFlow(parsedCf),
        schedule: parsedSchedule as AutoAttendantHolidayCallFlow['schedule'],
      });
    }
  }

  return out;
}
