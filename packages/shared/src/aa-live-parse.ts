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
  return {
    enableDialByName: typeof o.DialByNameEnabled === 'boolean' ? o.DialByNameEnabled : undefined,
    // Unconfirmed index direction (0/1 -> ByName/ByExtension) - see AA_DIRECTORY_SEARCH_METHODS's own "confirm during implementation" note in domain.ts.
    directorySearchMethod:
      o.DirectorySearchMethod === 0 ? AA_DIRECTORY_SEARCH_METHODS[0] : o.DirectorySearchMethod === 1 ? AA_DIRECTORY_SEARCH_METHODS[1] : undefined,
    options,
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
